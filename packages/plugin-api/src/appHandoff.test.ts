import { describe, expect, it } from "vitest";
import companionPipelines from "./__fixtures__/companion-pipelines.json";
import {
  PluginAppHandoffLimits as limits,
  PluginAppHandoffSchemas,
  PluginCompanionPipelineSchema,
  PluginHandoffChooseAppRequestSchema,
  PluginHandoffDiagnosticSchema,
  PluginHandoffRunCompanionRequestSchema,
  PluginHandoffRunCompanionResultSchema,
  PluginHandoffSendFileRequestSchema,
  PluginHandoffSendFileResultSchema,
  PluginManifestSchema,
  dangerousPluginPermissions,
  isPluginHandoffExtension,
  parsePluginManifest,
  sanitizePluginHandoffFileName
} from "./index";

const pipeline = {
  id: "mofBuild",
  tool: { macos: "Contents/MacOS/xtal", windows: "xtal.exe" },
  testedVersions: ["1.1.1"],
  steps: [
    { id: "preflight", args: ["capabilities", "--json"], timeoutSeconds: 30 },
    { id: "build", args: [
      "run", "mof.build", "-p", "topology={combination.topology}", "-p", "nodes={combination.node}",
      "-p", "edges={inputStem}", "-p", "bb_dir={inputDir}", "-p", "repeat={combination.repeat}",
      "-o", "{outputFile:cif}", "--json"
    ], input: { extension: "xyz" }, timeoutSeconds: 120 },
    { id: "inspect", args: ["inspect", "{previousOutput}", "--json"], timeoutSeconds: 60 }
  ],
  combinations: {
    "pcu-N16-2x2x2": { topology: "pcu", node: "N16", repeat: "2x2x2" },
    "pcu-N16-1x1x1": { topology: "pcu", node: "N16", repeat: "1x1x1", rebuildAs: "pcu-N16-2x2x2" }
  }
};
const manifest = {
  id: "org.test.handoff", name: "Handoff", version: "1.0.0",
  apiVersion: "^0.1.27", entry: "index.js", permissions: ["apps.handoff", "native.execute"]
};
const sendFile = { appId: "opaque-1", fileName: "benzene", extension: "xyz", text: "6\n" };
const runCompanion = { appId: "opaque-1", pipeline: "mofBuild", combination: "pcu-N16-1x1x1" };

describe("app handoff manifest", () => {
  it.each(companionPipelines.cases)("matches native pipeline validation for $name", ({ valid, overrides }) => {
    expect(PluginCompanionPipelineSchema.safeParse({ ...companionPipelines.base, ...overrides }).success).toBe(valid);
  });

  it("marks app handoff dangerous and requires native.execute", () => {
    expect(dangerousPluginPermissions).toContain("apps.handoff");
    expect(PluginManifestSchema.parse({ ...manifest, companions: [pipeline] }).companions).toEqual([pipeline]);
    expect(PluginManifestSchema.parse(manifest).companions).toBeUndefined();
    expect(() => parsePluginManifest({ ...manifest, permissions: ["apps.handoff"] }))
      .toThrow(/"apps.handoff" without "native.execute"/);
    expect(() => PluginManifestSchema.parse({ ...manifest, companions: [pipeline], permissions: ["native.execute"] }))
      .toThrow(/Companion pipelines require apps.handoff/);
    expect(() => PluginManifestSchema.parse({ ...manifest, companions: [pipeline, pipeline] }))
      .toThrow(/Duplicate companion pipeline id/i);
  });

  it.each([
    ["macos", "/Contents/MacOS/xtal"], ["macos", "Contents/../xtal"], ["macos", "Contents\\..\\xtal"],
    ["windows", "C:xtal.exe"], ["windows", "C:\\xtal.exe"], ["windows", "\\\\host\\tools\\xtal.exe"],
    ["windows", "tools\\..\\xtal.exe"], ["windows", "tools\\.. \\xtal.exe"], ["windows", "tools\\xtal.exe:stream"]
  ])("refuses a tool path that escapes or is ambiguous on %s (%s)", (platform, path) => {
    expect(PluginCompanionPipelineSchema.safeParse({ ...pipeline, tool: { ...pipeline.tool, [platform]: path } }).success).toBe(false);
  });

  it("accepts relative tool paths with the Windows separator", () => {
    expect(PluginCompanionPipelineSchema.parse({ ...pipeline, tool: { ...pipeline.tool, windows: "bin\\xtal.exe" } }).tool)
      .toEqual({ macos: "Contents/MacOS/xtal", windows: "bin\\xtal.exe" });
  });

  it("requires the preceding build's output when a combination renders the inspect action", () => {
    const [preflight, build, inspect] = pipeline.steps;
    const combinations = Object.fromEntries(Object.entries(pipeline.combinations).map(([id, row]) =>
      [id, { ...row, action: row.repeat === "1x1x1" ? "inspect" : "check" }]));
    const step = { ...inspect, args: ["{combination.action}", "{previousOutput}", "--json"] };
    expect(PluginCompanionPipelineSchema.parse({ ...pipeline, combinations, steps: [preflight, build, step] })).toBeDefined();
    expect(() => PluginCompanionPipelineSchema.parse({
      ...pipeline, combinations, steps: [preflight, { ...build, id: "generate" }, step]
    })).toThrow(/preceding build/);
    expect(() => PluginCompanionPipelineSchema.parse({
      ...pipeline, combinations, steps: [preflight, build, { ...step, args: ["{combination.action}", "file.cif", "{previousOutput}"] }]
    })).toThrow(/preceding build/);
  });

  it.each([
    "{unknown}", "{combination.missing}", "{combination.rebuildAs}", "{outputFile:exe}", "prefix{inputStem}",
    "key={inputStem}.xyz", "key={inputStem}{inputDir}", "key={inputStem", "pre=fix={inputStem}", "{previousOutput}"
  ])("refuses invalid placeholders in %s", arg => {
    const steps = [pipeline.steps[0], { ...pipeline.steps[1], args: [arg] }];
    expect(PluginCompanionPipelineSchema.safeParse({ ...pipeline, steps }).success).toBe(false);
  });

  it("requires input references and combination values to be declared", () => {
    const noInput = [pipeline.steps[0], { ...pipeline.steps[1], input: undefined }, pipeline.steps[2]];
    expect(() => PluginCompanionPipelineSchema.parse({ ...pipeline, steps: noInput }))
      .toThrow(/requires a declared pipeline input file/);
    const combinations = { ...pipeline.combinations, incomplete: { node: "N16", repeat: "2x2x2" } };
    expect(() => parsePluginManifest({ ...manifest, companions: [{ ...pipeline, combinations }] }))
      .toThrow(/Combination "incomplete" does not declare "topology"/);
    const undeclaredRebuild = { ...pipeline.combinations, rebuild: { topology: "pcu", node: "N16", repeat: "1x1x1", rebuildAs: "missing" } };
    expect(() => PluginCompanionPipelineSchema.parse({ ...pipeline, combinations: undeclaredRebuild }))
      .toThrow(/Rebuild must name another declared combination/);
  });

  it.each([
    "-o", "--help", "@response", "/tmp/file", "a\\b", "a..b", "a=b", "a b", "a\nb",
    "$(command)", "a|b", "a;b", "a*b", "a&b", "x".repeat(limits.parameterCharacters + 1)
  ])("refuses unsafe or oversized combination values (%j)", node => {
    const combinations = { selected: { topology: "pcu", node, repeat: "1x1x1" } };
    expect(PluginCompanionPipelineSchema.safeParse({ ...pipeline, combinations }).success).toBe(false);
  });

  it("rejects oversized per-step and aggregate timeouts", () => {
    const withTimeouts = (timeouts: number[]) => ({
      ...pipeline, steps: pipeline.steps.map((step, index) => ({ ...step, timeoutSeconds: timeouts[index] }))
    });
    expect(PluginCompanionPipelineSchema.safeParse(withTimeouts([300, 240, 60])).success).toBe(true);
    expect(PluginCompanionPipelineSchema.safeParse(withTimeouts([301, 30, 30])).success).toBe(false);
    expect(() => PluginCompanionPipelineSchema.parse(withTimeouts([300, 241, 60]))).toThrow(/600 seconds in total/);
  });
});

describe("app handoff file names and extensions", () => {
  it("allows exactly the supported lowercase data extensions", () => {
    for (const extension of ["xyz", "cif", "mol", "sdf", "pdb", "smi", "csv", "json", "txt"]) {
      expect(isPluginHandoffExtension(extension)).toBe(true);
    }
    for (const extension of ["exe", "bat", "app", "XYZ", ".xyz", "x/y", "", null]) {
      expect(isPluginHandoffExtension(extension)).toBe(false);
    }
  });

  it.each([
    ["../mol\\file\x00\x1f\x85. ", "..molfile"],
    ["構造 with spaces", "構造 with spaces"],
    ["bad<>:\"|?*name", "badname"],
    ["CoN.txt", "handoff"],
    ["LPT².other", "handoff"],
    ["COM1 .mol", "handoff"],
    ["NUL. ", "handoff"],
    ["AUX", "handoff"],
    ["PRN.txt", "handoff"],
    ["CONOUT$", "handoff"],
    [" .. ", "handoff"],
    ["COM0", "COM0"],
    ["COM10", "COM10"],
    ["", "handoff"],
    ["🧪".repeat(70), "🧪".repeat(62)]
  ])("sanitizes %j as a portable file stem", (original, expected) => {
    expect(sanitizePluginHandoffFileName(original)).toBe(expected);
    expect(sanitizePluginHandoffFileName(expected)).toBe(expected);
  });
});

describe("strict app handoff wire shapes", () => {
  const requests = [
    [PluginAppHandoffSchemas.chooseApp.request, { purpose: "View the structure" }],
    [PluginAppHandoffSchemas.status.request, { appId: "opaque-1" }],
    [PluginAppHandoffSchemas.sendFile.request, sendFile],
    [PluginAppHandoffSchemas.runCompanion.request, runCompanion]
  ] as const;
  it.each(requests)("accepts only documented fields on each request", (schema, request) => {
    expect(schema.parse(request)).toEqual(request);
    for (const field of ["token", "arming", "armingId", "commandId", "command", "path", "args", "env", "parameters"]) {
      expect(schema.safeParse({ ...request, [field]: "untrusted" }).success).toBe(false);
    }
  });

  it("accepts a single allowlisted input and a combination ID", () => {
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: { text: "6\n", extension: "xyz" }, openOutput: true
    }).success).toBe(true);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: { text: "data_cif", extension: "cif" }
    }).success).toBe(false);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({ ...runCompanion, combination: { topology: "pcu" } }).success).toBe(false);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: { text: "6\n", extension: "xyz", fileName: "untrusted" }
    }).success).toBe(false);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: [{ text: "6\n", extension: "xyz" }]
    }).success).toBe(false);
  });

  it("checks text sizes in UTF-8 bytes and native dialog copy in characters", () => {
    const sendText = "é".repeat(limits.sendBytes / 2);
    const inputText = "é".repeat(limits.inputBytes / 2);
    expect(PluginHandoffSendFileRequestSchema.safeParse({ ...sendFile, text: sendText }).success).toBe(true);
    expect(PluginHandoffSendFileRequestSchema.safeParse({ ...sendFile, text: sendText + "!" }).success).toBe(false);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: { extension: "xyz", text: inputText }
    }).success).toBe(true);
    expect(PluginHandoffRunCompanionRequestSchema.safeParse({
      ...runCompanion, input: { extension: "xyz", text: inputText + "!" }
    }).success).toBe(false);
    const warning = "🧪".repeat(limits.warningCharacters);
    const warnings = Array<string>(limits.warningCount).fill(warning);
    for (const [schema, request] of [[PluginHandoffSendFileRequestSchema, sendFile],
      [PluginHandoffRunCompanionRequestSchema, runCompanion]] as const) {
      expect(schema.safeParse({ ...request, warnings }).success).toBe(true);
      for (const invalid of [[...warnings, "extra"], [warning + "!"], [0], ["\0"], null]) {
        expect(schema.safeParse({ ...request, warnings: invalid }).success).toBe(false);
      }
    }
    const purpose = "🧪".repeat(limits.purposeCharacters);
    expect(PluginHandoffChooseAppRequestSchema.safeParse({ purpose }).success).toBe(true);
    expect(PluginHandoffChooseAppRequestSchema.safeParse({ purpose: purpose + "!" }).success).toBe(false);
  });

  it("refuses paths and credential fields on structured results", () => {
    const app = { appId: "opaque-1", displayName: "Crystal Builder" };
    expect(PluginAppHandoffSchemas.chooseApp.result.parse({ status: "chosen", app })).toEqual({ status: "chosen", app });
    expect(PluginAppHandoffSchemas.chooseApp.result.safeParse({ status: "chosen", app: { ...app, path: "/host/app" } }).success).toBe(false);
    expect(PluginAppHandoffSchemas.status.result.safeParse({ available: true, armingId: "proof" }).success).toBe(false);
    expect(PluginHandoffSendFileResultSchema.safeParse({ status: "declined", commandId: "plugin.handoff.send" }).success).toBe(false);
  });

  it("preserves bounded JSON and stderr in typed companion diagnostics", () => {
    const diagnostic = { step: "build", exitCode: 2, json: { error: "Step failed", details: [null, 2] }, stderrTail: "failed" };
    const failure = { status: "failed", code: "exit-nonzero", message: "Build failed.", diagnostic };
    expect(PluginHandoffRunCompanionResultSchema.parse(failure)).toEqual(failure);
    expect(PluginHandoffRunCompanionResultSchema.safeParse({ ...failure, code: "launch-failed" }).success).toBe(false);
    expect(PluginHandoffSendFileResultSchema.safeParse({ ...failure, diagnostic: undefined }).success).toBe(false);
    const tail = "é".repeat(limits.stderrTailBytes / 2);
    expect(PluginHandoffDiagnosticSchema.safeParse({ step: "build", stderrTail: tail }).success).toBe(true);
    expect(PluginHandoffDiagnosticSchema.safeParse({ step: "build", stderrTail: tail + "!" }).success).toBe(false);
    const stepText = "x".repeat(limits.stepJsonBytes - 2);
    expect(PluginHandoffDiagnosticSchema.safeParse({ step: "build", json: stepText }).success).toBe(true);
    expect(PluginHandoffDiagnosticSchema.safeParse({ step: "build", json: stepText + "!" }).success).toBe(false);
    for (const fields of [{ exitCode: 2.5 }, { json: { value: Infinity } }, { path: "/host/app" }, { token: "secret" }]) {
      expect(PluginHandoffDiagnosticSchema.safeParse({ step: "build", ...fields }).success).toBe(false);
    }
  });

  it("requires parsed JSON in every completed step", () => {
    const done = { status: "done", opened: true, steps: [{ id: "build", json: null }] };
    expect(PluginHandoffRunCompanionResultSchema.parse(done)).toEqual(done);
    expect(PluginHandoffRunCompanionResultSchema.safeParse({ ...done, steps: [{ id: "build" }] }).success).toBe(false);
    expect(PluginHandoffRunCompanionResultSchema.safeParse({
      ...done, steps: [{ id: "build", json: "x".repeat(limits.stepJsonBytes), stderr: "hidden field" }]
    }).success).toBe(false);
  });
});
