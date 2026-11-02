/** Independent ceilings, not an allowance to multiply every dimension together.
 * A 300-heavy-atom report can have 900 proton assignments and 14,400 couplings;
 * Assistant reports can contain long replies and several 1 MiB images. The 128 MiB
 * envelope leaves headroom for both, independently of individual collection caps.
 * Existing SVG, image, assignment and coupling-per-peak limits are never tightened.
 * Strings are UTF-16 code units; the envelope measures UTF-8 JSON including escapes.
 */
export const PluginPanelReportLimits = {
  stringLength: 1_048_576,
  svgLength: 512_000,
  imageLength: 1_048_576,
  sections: 300,
  // Per-figure caps; the serialized envelope bounds multi-figure totals.
  peaks: 50_000,
  atomIndicesPerPeak: 4_000,
  atomIndicesTotal: 100_000,
  couplingsPerPeak: 16,
  couplingsTotal: 160_000,
  atoms: 10_000,
  bonds: 20_000,
  tableRows: 50_000,
  tableColumns: 256,
  tableCells: 256_000,
  keyValueRows: 5_000,
  warnings: 10_000,
  serializedBytes: 128 * 1024 * 1024,
  // Also bound malformed JSON before Zod can copy it or recurse into it.
  depth: 128,
  // A 4,000-character JSON payload can nest 2,000 empty arrays.
  payloadDepth: 2_048,
  objectFields: 1_024,
  nodes: 2_000_000
} as const;

type Path = (string | number)[];
class ReportLimitError extends Error {
  constructor(readonly path: Path, message: string) { super(message); }
}

type ReportSnapshot = { ok: true; data: unknown } | { ok: false; issue: { path: Path; message: string } };

/** Runs BEFORE schema parsing. Copy only own enumerable data into a detached, bounded graph;
 * never read properties through getters, iterators or toJSON. Read each descriptor at most once.
 * Stop at the first failure. Shared references are copied and charged on every occurrence. */
export function snapshotPanelReport(
  raw: unknown,
  overrides: Partial<{ [K in keyof typeof PluginPanelReportLimits]: number }> = {}
): ReportSnapshot {
  const limits = { ...PluginPanelReportLimits, ...overrides };
  const ancestors = new Set<object>();
  const totals = new Map<string, number>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let nodes = 0;
  const fail = (path: Path, message: string): never => { throw new ReportLimitError(path, message); };
  const cap = (value: number, limit: number, label: string, path: Path) => {
    if (value > limit) fail(path, `${label}: ${value} exceeds the limit of ${limit}`);
  };
  const charge = (size: number, path: Path) => {
    bytes += size;
    cap(bytes, limits.serializedBytes, "report serialized bytes (at least)", path);
  };
  const total = (value: number, limit: number, label: string, path: Path) => {
    const sum = (totals.get(label) ?? 0) + value;
    totals.set(label, sum);
    cap(sum, limit, `report total ${label}`, path);
  };
  type Visit = { value: unknown; path: Path; kind: string };
  function* visit({ value, path, kind }: Visit): Generator<Visit, unknown, unknown> {
    cap(++nodes, limits.nodes, "report nodes", path);
    const payloadIndex = path.indexOf("payload");
    cap(payloadIndex < 0 ? path.length : payloadIndex, limits.depth, "report depth", path);
    if (payloadIndex >= 0) cap(path.length - payloadIndex - 1, limits.payloadDepth, "report payload depth", path);
    // Control payload keys are plugin-defined JSON, not report schema field names.
    const key = path.includes("payload") ? undefined : path.at(-1);
    const label = kind === "table" && typeof key === "number" && path.at(-2) === "rows"
      ? "table row cells" : `${kind} ${String(path.at(-1) ?? "value")}`;
    if (typeof value === "string") {
      const limit = key === "svg" ? limits.svgLength : key === "dataUri" ? limits.imageLength
        : key === "solvent" ? 120 : key === "alternativeMarker" ? 8
        : kind === "prompt" && key === "value" ? 100
        : (kind === "prompt" || kind === "actions") && key === "id" ? 64 : limits.stringLength;
      cap(value.length, limit, `${label} length`, path);
      // Each individual string is already bounded; escaping and UTF-8 encoding stay bounded too.
      charge(encoder.encode(JSON.stringify(value)).byteLength, path);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(path, `${label}: ${String(value)} must be finite`);
      if (key === "maxLength") cap(value, 20_000, label, path);
      if (kind === "prompt" && key === "rows") cap(value, 12, label, path);
      if (kind === "linkedFigure" && key === "order") cap(value, 3, label, path);
      if (kind === "linkedFigure" && key !== undefined && (key === "index" || key === "from" || key === "to" || path.at(-2) === "atomIndices")
          && (!Number.isInteger(value) || value < 0)) {
        fail(path, `linkedFigure atom index: ${value} must be a non-negative integer`);
      }
      charge(String(value).length, path);
    } else if (value === null || typeof value === "boolean") {
      charge(value === true ? 4 : value === false ? 5 : 4, path);
    } else if (typeof value !== "object") {
      fail(path, `${label} must be JSON data`);
    } else {
      if (ancestors.has(value)) fail(path, `${label} must not contain a cycle`);
      ancestors.add(value);
      if (Array.isArray(value)) {
        // In particular, do not read value.length or iterate value: a Proxy may intercept reads,
        // and an own Symbol.iterator can replace a short array with an unbounded stream for Zod.
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor)) return fail(path, `${label} must not contain accessors`);
        const length: unknown = lengthDescriptor.value;
        if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
          return fail(path, `${label} must be a plain JSON array`);
        }
        let limit: number = limits.tableRows;
        let aggregate: [number, string] | undefined;
        if (key === "sections") limit = limits.sections;
        if (key === "buttons") limit = 8;
        if (key === "options") limit = 20;
        if (key === "peaks") { limit = limits.peaks; }
        if (key === "atomIndices") { limit = limits.atomIndicesPerPeak; aggregate = [limits.atomIndicesTotal, "atom indices"]; }
        if (key === "couplings") { limit = limits.couplingsPerPeak; aggregate = [limits.couplingsTotal, "couplings"]; }
        if (key === "atoms") { limit = limits.atoms; }
        if (key === "bonds") { limit = limits.bonds; }
        if (key === "warnings") { limit = limits.warnings; aggregate = [limits.warnings, "warnings"]; }
        if (key === "columns" || (kind === "table" && typeof key === "number" && path.at(-2) === "rows")) {
          limit = limits.tableColumns;
          aggregate = [limits.tableCells, "table cells"];
        }
        if (key === "rows") {
          limit = kind === "keyValue" ? limits.keyValueRows : limits.tableRows;
          aggregate = [limit, `${kind} rows`];
        }
        cap(length, limit, label, path);
        if (aggregate) total(length, aggregate[0], aggregate[1], path);
        charge(2 + Math.max(0, length - 1), path);
        if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, `${label} must be a plain JSON array`);
        const fields = Reflect.ownKeys(value);
        const copy: unknown[] = [];
        for (const field of fields) {
          if (typeof field !== "string") return fail(path, `${label} must not contain symbol keys`);
          if (field === "length") continue; // Already read its descriptor above.
          cap(field.length, limits.stringLength, `${kind} field name length`, path);
          if (!/^(0|[1-9][0-9]*)$/.test(field) || Number(field) >= length) {
            return fail(path, `${label} must contain only array indices`);
          }
          const i = Number(field);
          const descriptor = Object.getOwnPropertyDescriptor(value, field);
          if (!descriptor || !("value" in descriptor)) return fail([...path, i], `${label} must not contain accessors`);
          if (!descriptor.enumerable) fail([...path, i], `${label} must be enumerable JSON data`);
          copy[i] = yield { value: descriptor.value, path: [...path, i], kind };
        }
        if (fields.length !== length + 1) fail(path, `${label} must not contain holes`);
        ancestors.delete(value);
        return copy;
      } else {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) fail(path, `${label} must be a plain JSON object`);
        const fields = Reflect.ownKeys(value);
        cap(fields.length, limits.objectFields, `${kind} object fields`, path);
        const kindDescriptor = fields.includes("kind") ? Object.getOwnPropertyDescriptor(value, "kind") : undefined;
        if (kindDescriptor?.enumerable && "value" in kindDescriptor && typeof kindDescriptor.value === "string"
            && kindDescriptor.value.length <= 32) kind = kindDescriptor.value;
        charge(2, path);
        const copy: Record<string, unknown> = {};
        let emitted = 0;
        for (const field of fields) {
          if (typeof field !== "string") return fail(path, `${kind} must not contain symbol keys`);
          cap(field.length, limits.stringLength, `${kind} field name length`, path);
          const descriptor = field === "kind" ? kindDescriptor : Object.getOwnPropertyDescriptor(value, field);
          if (!descriptor || !("value" in descriptor)) return fail([...path, field], `${kind} ${field} must not be an accessor`);
          if (!descriptor.enumerable) fail([...path, field], `${kind} ${field} must be enumerable JSON data`);
          // Omit optional report fields as before; undefined inside a JSON payload is invalid.
          if (descriptor.value === undefined && !path.includes("payload")) continue;
          charge(encoder.encode(JSON.stringify(field)).byteLength + 1 + (emitted++ > 0 ? 1 : 0), path);
          // Define rather than assign so an untrusted __proto__ key cannot change the copy's prototype.
          Object.defineProperty(copy, field, { value: yield { value: descriptor.value, path: [...path, field], kind },
            enumerable: true, configurable: true, writable: true });
        }
        ancestors.delete(value);
        return copy;
      }
    }
    return value;
  };
  // Resume parents after their child completes without JS call-stack recursion. Preserve
  // ancestor tracking, descriptor reads and first-failure ordering across each suspension.
  try {
    const stack = [visit({ value: raw, path: [], kind: "report" })];
    let data: unknown;
    while (stack.length) {
      const step = stack[stack.length - 1]!.next(data);
      if (step.done) { data = step.value; stack.pop(); }
      else { stack.push(visit(step.value)); data = undefined; }
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ReportLimitError) return { ok: false, issue: { path: error.path, message: error.message } };
    throw error;
  }
}

/** Recheck schema-added defaults against the same budgets. */
export function panelReportLimitIssue(raw: unknown): { path: Path; message: string } | undefined {
  const snapshot = snapshotPanelReport(raw);
  return snapshot.ok ? undefined : snapshot.issue;
}
