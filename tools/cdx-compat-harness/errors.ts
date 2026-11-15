import { errorStages, publicSanitizationReason, type ErrorStage, type Result, type StageError } from "./model";

/** Categories are a closed vocabulary: dependency messages and file content never become keys. */
const knownCategories = [
  "input.too_large", "input.unsupported_format", "import.rejected", "summary.incomplete",
  "summary.unknown_bond_order", "summary.radical_unsupported", "summary.rdkit_rejected",
  "summary.rdkit_capability", "summary.reaction_identity", "codec.unavailable",
  "worker.timeout", "worker.oom", "worker.crash", "worker.protocol",
  "import.hang", "harness.slow", "rdkit.wasm_oob", "rdkit.exception_number", "rdkit.exception_object", "rdkit.exception",
  "filesystem.not_found", "filesystem.permission", "filesystem.exists", "filesystem.io",
  "runtime.type_error", "runtime.range_error", "runtime.syntax_error", "runtime.error", "runtime.thrown_value"
] as const;
type ErrorCategory = typeof knownCategories[number];

export class HarnessFailure extends Error {
  constructor(name: string, readonly category: ErrorCategory, message: string) { super(message); this.name = name; }
}

/** Emscripten may throw a pointer, or an object with non-enumerable diagnostics. */
export function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      const native = error as { message?: unknown; what?: () => unknown };
      if (typeof native.message === "string" && native.message) return native.message;
      if (typeof native.what === "function") {
        const message = native.what();
        if (typeof message === "string" && message) return message;
      }
    } catch { /* Broken accessors must not obscure the original exception. */ }
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(error, (_key, value: unknown) => {
        if (!value || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
        if (seen.has(value)) return "[circular]";
        seen.add(value);
        return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          return [key, "value" in descriptor ? descriptor.value : "[accessor]"];
        }));
      }) ?? String(error);
    } catch { return "Unserializable thrown object"; }
  }
  return String(error);
}

export function rdkitError(error: unknown, module?: object): HarnessFailure {
  if (error instanceof HarnessFailure) return error;
  let message = thrownMessage(error);
  const decoder = module as { getExceptionMessage?: (value: unknown) => unknown } | undefined;
  if (!(error instanceof Error) && decoder?.getExceptionMessage) {
    try {
      const decoded = decoder.getExceptionMessage(error);
      if (decoded) message = Array.isArray(decoded) ? decoded.map(thrownMessage).join(": ") : thrownMessage(decoded);
    } catch { /* Older modules and ordinary JS exceptions have no Emscripten pointer. */ }
  }
  const category = /memory access out of bounds|out of bounds memory access|wasm.*(?:out.of.bounds|oob)/i.test(message)
    ? "rdkit.wasm_oob" : typeof error === "number" ? "rdkit.exception_number"
      : error && typeof error === "object" && !(error instanceof Error) ? "rdkit.exception_object" : "rdkit.exception";
  const result = new HarnessFailure(category === "rdkit.wasm_oob" ? "RdkitWasmOobError" : "RdkitException", category, message);
  if (error instanceof Error && error.stack) result.stack = error.stack;
  return result;
}

export function redactPaths(value: string, secrets: string[] = [], relative = true): string {
  let redacted = value;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const spelling of new Set([secret, secret.replace(/\\/g, "/"), secret.replace(/\//g, "\\")])) redacted = redacted.split(spelling).join("[redacted]");
  }
  // Quoted paths may contain spaces. Also cover drive letters, UNC, file URLs and home paths
  // independently of the OS running the harness.
  redacted = redacted.replace(/(["'`])(?=[^"'`\r\n]*[\\/])[^"'`\r\n]*\1/g, "$1[redacted]$1");
  redacted = redacted.replace(/(^|[\s("'`=])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])[^\r\n"'`<>|)]*/g, "$1[redacted]");
  if (relative) redacted = redacted.replace(/\b[\w.@-]+(?:[\\/][\w.@-]+)+/g, "[redacted]");
  return redacted;
}

function categoryFor(error: unknown): ErrorCategory {
  if (error instanceof HarnessFailure) return error.category;
  const { code, name, message = "" } = (error ?? {}) as { code?: string; name?: string; message?: string };
  if (code === "ENOENT") return "filesystem.not_found";
  if (code === "EACCES" || code === "EPERM") return "filesystem.permission";
  if (code === "EEXIST") return "filesystem.exists";
  if (["EIO", "ENOSPC", "EMFILE", "ENFILE", "EROFS", "EISDIR", "ENOTDIR"].includes(code ?? "")) return "filesystem.io";
  if (name === "UnknownBondOrderError") return "summary.unknown_bond_order";
  if (typeof message === "string") {
    if (message.includes("cannot preserve more than two radical electrons")) return "summary.radical_unsupported";
    if (message.includes("RDKit rejected the molecule")) return "summary.rdkit_rejected";
    if (message.includes("RDKit lacks")) return "summary.rdkit_capability";
    if (message.includes("reaction component has no canonical")) return "summary.reaction_identity";
    if (message === "no CDX support in this build") return "codec.unavailable";
  }
  if (name === "TypeError") return "runtime.type_error";
  if (name === "RangeError") return "runtime.range_error";
  if (name === "SyntaxError") return "runtime.syntax_error";
  return error instanceof Error ? "runtime.error" : "runtime.thrown_value";
}

export function stageError(stage: ErrorStage, error: unknown, secrets: string[] = []): StageError {
  const value = error as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown; rdkitReason?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : typeof value?.name === "string" ? value.name : error instanceof Error ? error.constructor.name : "ThrownValue";
  const message = error instanceof Error ? error.message : thrownMessage(error);
  const stack = typeof value?.stack === "string" ? value.stack.split("\n").slice(1).filter(line => /^\s*at\b/.test(line)).slice(0, 5).map(frame => {
    const relative = frame.replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^()\n]*?(?=(?:packages|tools|apps|scripts|node_modules)[\\/])/g, "");
    return redactPaths(relative, secrets, false).trim();
  }) : undefined;
  return { stage, code: redactPaths(code, secrets), category: categoryFor(error), message: redactPaths(message, secrets), ...(stack?.length ? { stack } : {}), ...(value?.rdkitReason ? { rdkitReason: publicSanitizationReason(value.rdkitReason) } : {}) };
}

export function resultErrors(result: Pick<Result, "error" | "errors" | "summary" | "roundTrips">): StageError[] {
  // errors is authoritative for new rows; fallbacks support independently written/older rows.
  return result.errors?.length ? result.errors : [
    ...(result.error ? [result.error] : []),
    ...(result.summary?.summaryErrors ?? []).map(item => item.summaryError),
    ...result.roundTrips.flatMap(trip => trip.errors?.length ? trip.errors : trip.error ? [trip.error] : [])
  ];
}

export function publicError(error: StageError): Pick<StageError, "stage" | "category"> {
  return {
    stage: errorStages.includes(error.stage) ? error.stage : "detect",
    category: knownCategories.includes(error.category as ErrorCategory) ? error.category : "runtime.error"
  };
}

export function completionLine(result: Pick<Result, "id" | "status" | "error" | "errors" | "summary" | "roundTrips">): string {
  const errors = [...new Set(resultErrors(result).map(error => { const safe = publicError(error); return `${safe.stage}/${safe.category}`; }))];
  const status = ["ok", "import-error", "processing-error", "crash", "timeout", "oom", "copy-error"].includes(result.status) ? result.status : "processing-error";
  return `${/^[0-9a-f]{12}$/.test(result.id) ? result.id : "unavailable"} ${status}${errors.length ? ` ${errors.join(",")}` : ""}\n`;
}
