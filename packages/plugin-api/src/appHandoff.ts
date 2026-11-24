import { z } from "zod";
import { boundedRequestJson, type PluginRequestJson } from "./requestPayload";

export const PluginAppHandoffPermissions = ["apps.handoff", "native.execute"] as const;

export const PluginAppHandoffLimits = {
  purposeCharacters: 200,
  sendBytes: 5 * 1024 * 1024,
  warningCount: 20,
  warningCharacters: 300,
  inputBytes: 1024 * 1024,
  stepJsonBytes: 1024 * 1024,
  stderrTailBytes: 4 * 1024,
  parameterCharacters: 32,
  stepSeconds: 300,
  pipelineSeconds: 600
} as const;

const limits = PluginAppHandoffLimits;
const encoder = new TextEncoder();
const nonempty = z.string().min(1);

function utf8Text(maxBytes: number) {
  return z.string().max(maxBytes).refine(text => encoder.encode(text).length <= maxBytes, {
    message: `Text exceeds ${maxBytes} UTF-8 bytes.`
  });
}

// Count Unicode code points as Rust does, including non-BMP characters.
function characterLimitedText(maxCharacters: number) {
  return z.string().max(2 * maxCharacters).refine(text => [...text].length <= maxCharacters, {
    message: `Text exceeds ${maxCharacters} characters.`
  });
}

export const pluginHandoffExtensions = ["xyz", "cif", "mol", "sdf", "pdb", "smi", "csv", "json", "txt"] as const;
export const PluginHandoffExtensionSchema = z.enum(pluginHandoffExtensions);
export type PluginHandoffExtension = z.infer<typeof PluginHandoffExtensionSchema>;

export function isPluginHandoffExtension(value: unknown): value is PluginHandoffExtension {
  return PluginHandoffExtensionSchema.safeParse(value).success;
}

const windowsDeviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/iu;
const unsafeFileNameCharacter = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f\ud800-\udfff]/u;
const unsafeFileNameCharacters = new RegExp(unsafeFileNameCharacter.source, "gu");

/** Sanitize a single file stem for both platforms. Append the allowlisted extension separately. */
export function sanitizePluginHandoffFileName(fileName: string): string {
  const cleaned = fileName.replace(unsafeFileNameCharacters, "");
  // A portable component fits 255 UTF-8 bytes, including the dot and longest extension.
  let stem = "";
  let bytes = 0;
  for (const character of cleaned) {
    bytes += encoder.encode(character).length;
    if (bytes > 250) break;
    stem += character;
  }
  stem = stem.replace(/[. ]+$/u, "");
  return stem && !windowsDeviceName.test(stem.split(".", 1)[0].trimEnd()) ? stem : "handoff";
}

const companionId = nonempty.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, "Use letters, digits, underscores, or hyphens in a companion id.");
const parameterName = nonempty.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u, "Expected a companion parameter name.")
  .refine(name => name !== "__proto__", "Reserved companion parameter name.");
const safeCombinationValue = nonempty.max(limits.parameterCharacters)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u, "Expected a single companion value without paths, options, or shell characters.")
  .refine(value => !value.includes(".."), "A companion value cannot contain '..'.");

// Each row contains literal argument values, with rebuildAs reserved for the host's result session.
export const PluginCompanionCombinationSchema = z.record(parameterName, z.unknown()).pipe(
  z.object({ rebuildAs: companionId.optional() }).catchall(safeCombinationValue)
);

function relativeToolPath(platform: "macos" | "windows") {
  return nonempty.refine(value => {
    const segments = platform === "windows" ? value.split(/[/\\]/u) : value.split("/");
    return segments.every(segment => segment && segment !== "." && segment !== ".." &&
      !unsafeFileNameCharacter.test(segment) &&
      (platform === "macos" || (!/[. ]$/u.test(segment) && !windowsDeviceName.test(segment.split(".", 1)[0].trimEnd()))));
  }, `Expected a relative ${platform === "macos" ? "macOS" : "Windows"} tool path inside the app, with no traversal segments.`)
    .refine(value => {
      if (platform === "macos") return true;
      const name = value.split(/[/\\]/u).at(-1)!;
      return name.length > 4 && name.toLowerCase().endsWith(".exe");
    }, "A Windows companion tool must be a native .exe.");
}

const companionInputExtension = z.literal("xyz");

export const PluginCompanionStepSchema = z.object({
  id: companionId,
  args: z.array(z.string()),
  input: z.object({ extension: companionInputExtension }).strict().optional(),
  timeoutSeconds: z.number().int().positive().max(limits.stepSeconds)
}).strict();

export const PluginCompanionPipelineSchema = z.object({
  id: companionId,
  tool: z.object({ macos: relativeToolPath("macos"), windows: relativeToolPath("windows") }).strict(),
  testedVersions: z.array(nonempty.max(80).regex(/^[A-Za-z0-9.+_-]+$/u)).min(1),
  steps: z.array(PluginCompanionStepSchema).min(1),
  combinations: z.record(companionId, PluginCompanionCombinationSchema)
}).strict().superRefine((pipeline, ctx) => {
  const refuse = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const preflight = pipeline.steps[0];
  if (!preflight || preflight.id !== "preflight" || preflight.input !== undefined ||
      preflight.args.length !== 2 || preflight.args[0] !== "capabilities" || preflight.args[1] !== "--json") {
    refuse(["steps", 0], "A companion pipeline must begin with preflight capabilities --json.");
  }
  const combinations = Object.entries(pipeline.combinations);
  if (!combinations.length) refuse(["combinations"], "Declare at least one companion combination.");
  for (const [id, combination] of combinations) {
    if (combination.rebuildAs !== undefined &&
        (combination.rebuildAs === id || !Object.hasOwn(pipeline.combinations, combination.rebuildAs))) {
      refuse(["combinations", id, "rebuildAs"], "Rebuild must name another declared combination.");
    }
  }
  if (pipeline.steps.reduce((sum, step) => sum + step.timeoutSeconds, 0) > limits.pipelineSeconds) {
    refuse(["steps"], `Companion pipeline timeouts exceed ${limits.pipelineSeconds} seconds in total.`);
  }
  const inputSteps = pipeline.steps.filter(step => step.input !== undefined);
  if (inputSteps.length > 1) refuse(["steps"], "Declare only one input file per companion pipeline.");
  const stepIds = new Set<string>();
  let previousHasOutput = false;
  pipeline.steps.forEach((step, stepIndex) => {
    if (stepIds.has(step.id)) refuse(["steps", stepIndex, "id"], `Duplicate companion step id "${step.id}".`);
    stepIds.add(step.id);
    if (step.args[0] === "inspect" && (!previousHasOutput || pipeline.steps[stepIndex - 1]?.id !== "build" ||
        step.args[1] !== "{previousOutput}")) {
      refuse(["steps", stepIndex, "args"], "Inspect requires the declared file from the preceding build step.");
    }
    let outputExtension: PluginHandoffExtension | undefined;
    step.args.forEach((arg, argIndex) => {
      const path = ["steps", stepIndex, "args", argIndex];
      if (/\x00/u.test(arg)) {
        refuse(path, "A companion argument cannot contain a NUL character.");
        return;
      }
      if (!/[{}]/u.test(arg)) return;
      const placeholder = /^(?:[A-Za-z0-9_.-]+=)?\{([^{}]+)\}$/u.exec(arg)?.[1];
      if (!placeholder) {
        refuse(path, "A companion placeholder must fill one argument or follow a fixed key= prefix.");
      } else if (placeholder === "inputDir" || placeholder === "inputStem") {
        if (!inputSteps.length) refuse(path, `{${placeholder}} requires a declared pipeline input file.`);
      } else if (placeholder === "previousOutput") {
        if (!previousHasOutput) refuse(path, "{previousOutput} requires an output file from the preceding step.");
      } else if (placeholder.startsWith("outputFile:")) {
        const extension = placeholder.slice("outputFile:".length);
        if (!isPluginHandoffExtension(extension)) {
          refuse(path, `Unsupported companion output extension "${extension}".`);
        } else if (outputExtension !== undefined && outputExtension !== extension) {
          refuse(path, "A companion step may declare only one output file.");
        } else {
          outputExtension = extension;
        }
      } else if (placeholder.startsWith("combination.")) {
        const name = placeholder.slice("combination.".length);
        if (name === "rebuildAs" || !parameterName.safeParse(name).success) {
          refuse(path, `Invalid companion parameter in {${placeholder}}.`);
        } else {
          for (const [id, combination] of combinations) {
            if (!Object.hasOwn(combination, name)) refuse(path, `Combination "${id}" does not declare "${name}".`);
          }
        }
      } else {
        refuse(path, `Undeclared companion placeholder {${placeholder}}.`);
      }
    });
    previousHasOutput = outputExtension !== undefined;
  });
});

export type PluginCompanionPipeline = z.infer<typeof PluginCompanionPipelineSchema>;
export type PluginCompanionStep = z.infer<typeof PluginCompanionStepSchema>;
export type PluginCompanionCombination = z.infer<typeof PluginCompanionCombinationSchema>;

export const PluginHandoffChooseAppRequestSchema = z.object({
  purpose: characterLimitedText(limits.purposeCharacters)
}).strict();
export const PluginHandoffChooseAppResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("chosen"),
    app: z.object({ appId: nonempty, displayName: nonempty }).strict()
  }).strict(),
  z.object({ status: z.literal("cancelled") }).strict()
]);

export const PluginHandoffStatusRequestSchema = z.object({ appId: nonempty }).strict();
export const PluginHandoffStatusResultSchema = z.object({
  available: z.boolean(),
  displayName: z.string().optional(),
  reason: z.string().optional()
}).strict();

export const PluginHandoffSendFileRequestSchema = z.object({
  appId: nonempty,
  fileName: z.string(),
  extension: PluginHandoffExtensionSchema,
  text: utf8Text(limits.sendBytes),
  warnings: z.array(characterLimitedText(limits.warningCharacters)).max(limits.warningCount).optional()
}).strict();

export const PluginHandoffSendFileFailureCodeSchema = z.enum([
  "app-missing", "app-changed", "launch-failed", "write-failed"
]);
export type PluginHandoffSendFileFailureCode = z.infer<typeof PluginHandoffSendFileFailureCodeSchema>;

const declined = z.object({ status: z.literal("declined") }).strict();
export const PluginHandoffSendFileResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent") }).strict(),
  declined,
  z.object({ status: z.literal("failed"), code: PluginHandoffSendFileFailureCodeSchema, message: nonempty }).strict()
]);

export const PluginHandoffRunCompanionRequestSchema = z.object({
  appId: nonempty,
  pipeline: companionId,
  combination: companionId,
  input: z.object({ extension: companionInputExtension, text: utf8Text(limits.inputBytes) }).strict().optional(),
  openOutput: z.boolean().optional()
}).strict();

export const PluginHandoffRunCompanionFailureCodeSchema = z.enum([
  "app-missing", "app-changed", "tool-missing", "bad-param", "version-untested",
  "timeout", "exit-nonzero", "bad-output", "write-failed"
]);
export type PluginHandoffRunCompanionFailureCode = z.infer<typeof PluginHandoffRunCompanionFailureCodeSchema>;

const stepJson = boundedRequestJson(z.custom<PluginRequestJson>(), limits.stepJsonBytes);

/** Native callers provide path-free messages and diagnostics. The schemas bound the JSON and stderr. */
export const PluginHandoffDiagnosticSchema = z.object({
  step: companionId,
  exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  json: stepJson.optional(),
  stderrTail: utf8Text(limits.stderrTailBytes).optional()
}).strict();
export type PluginHandoffDiagnostic = z.infer<typeof PluginHandoffDiagnosticSchema>;

export const PluginHandoffRunCompanionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    steps: z.array(z.object({ id: companionId, json: stepJson }).strict()),
    opened: z.boolean()
  }).strict(),
  declined,
  z.object({
    status: z.literal("failed"),
    code: PluginHandoffRunCompanionFailureCodeSchema,
    message: nonempty,
    diagnostic: PluginHandoffDiagnosticSchema.optional()
  }).strict()
]);

export const PluginAppHandoffSchemas = {
  chooseApp: { request: PluginHandoffChooseAppRequestSchema, result: PluginHandoffChooseAppResultSchema },
  status: { request: PluginHandoffStatusRequestSchema, result: PluginHandoffStatusResultSchema },
  sendFile: { request: PluginHandoffSendFileRequestSchema, result: PluginHandoffSendFileResultSchema },
  runCompanion: { request: PluginHandoffRunCompanionRequestSchema, result: PluginHandoffRunCompanionResultSchema }
} as const;

export type PluginHandoffChooseAppRequest = z.infer<typeof PluginHandoffChooseAppRequestSchema>;
export type PluginHandoffChooseAppResult = z.infer<typeof PluginHandoffChooseAppResultSchema>;
export type PluginHandoffStatusRequest = z.infer<typeof PluginHandoffStatusRequestSchema>;
export type PluginHandoffStatusResult = z.infer<typeof PluginHandoffStatusResultSchema>;
export type PluginHandoffSendFileRequest = z.infer<typeof PluginHandoffSendFileRequestSchema>;
export type PluginHandoffSendFileResult = z.infer<typeof PluginHandoffSendFileResultSchema>;
export type PluginHandoffRunCompanionRequest = z.infer<typeof PluginHandoffRunCompanionRequestSchema>;
export type PluginHandoffRunCompanionResult = z.infer<typeof PluginHandoffRunCompanionResultSchema>;

/** Available only to live plugin commands with both handoff permissions. The native host owns user intent. */
export interface PluginAppsAPI {
  /** Show the native app picker and return an opaque ID and display name. */
  chooseApp(request: PluginHandoffChooseAppRequest): Promise<PluginHandoffChooseAppResult>;
  /** Check whether a previously chosen app is still present and unchanged. */
  status(request: PluginHandoffStatusRequest): Promise<PluginHandoffStatusResult>;
  /** Ask the native host to write a temporary file and open it with the chosen app. */
  sendFile(request: PluginHandoffSendFileRequest): Promise<PluginHandoffSendFileResult>;
  /** Suggest a declared combination and ask the native host to run the entire declared pipeline. */
  runCompanion(request: PluginHandoffRunCompanionRequest): Promise<PluginHandoffRunCompanionResult>;
}
