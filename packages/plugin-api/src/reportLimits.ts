/** Independent ceilings, not an allowance to multiply every dimension together.
 * A measured report for a large drug-like molecule (about 25 KB) was 25,448 UTF-8 JSON bytes.
 * 1,500,000 bytes is ~59x that real report. The other generous ceilings accommodate larger
 * reports (including tens of thousands of sparse peaks), while aggregate budgets prevent
 * peaks x assignments, rows x cells, or multiple figures from multiplying without bound.
 * Strings are UTF-16 code units, matching existing SDK string limits; size is UTF-8 JSON.
 */
export const PluginPanelReportLimits = {
  stringLength: 20_000,
  svgLength: 512_000,
  imageLength: 1_048_576,
  sections: 100,
  peaks: 50_000,
  atomIndicesPerPeak: 1_000,
  atomIndicesTotal: 100_000,
  couplingsPerPeak: 16,
  couplingsTotal: 10_000,
  atoms: 5_000,
  bonds: 10_000,
  tableRows: 50_000,
  tableColumns: 100,
  tableCells: 250_000,
  keyValueRows: 5_000,
  warnings: 1_000,
  serializedBytes: 1_500_000,
  // Also bound malformed JSON before Zod can copy it or recurse into it.
  depth: 32,
  objectFields: 64,
  nodes: 500_000
} as const;

type Path = (string | number)[];
class ReportLimitError extends Error {
  constructor(readonly path: Path, message: string) { super(message); }
}

/** Runs BEFORE Zod's object/array parse. Never stringify the entire untrusted graph or invoke
 * getters/toJSON. Stop at the first failure, so even the
 * error response cannot become enormous. Shared references are charged on every occurrence. */
export function panelReportLimitIssue(raw: unknown): { path: Path; message: string } | undefined {
  const limits = PluginPanelReportLimits;
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
  const visit = (value: unknown, path: Path, kind = "report"): void => {
    cap(++nodes, limits.nodes, "report nodes", path);
    cap(path.length, limits.depth, "report depth", path);
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
    } else if (value === null || value === undefined || typeof value === "boolean") {
      charge(value === true ? 4 : value === false ? 5 : 4, path);
    } else if (typeof value !== "object") {
      fail(path, `${label} must be JSON data`);
    } else {
      if (ancestors.has(value)) fail(path, `${label} must not contain a cycle`);
      ancestors.add(value);
      if (Array.isArray(value)) {
        let limit: number = limits.tableRows;
        let aggregate: [number, string] | undefined;
        if (key === "sections") limit = limits.sections;
        if (key === "buttons") limit = 8;
        if (key === "options") limit = 20;
        if (key === "peaks") { limit = limits.peaks; aggregate = [limits.peaks, "peaks"]; }
        if (key === "atomIndices") { limit = limits.atomIndicesPerPeak; aggregate = [limits.atomIndicesTotal, "atom indices"]; }
        if (key === "couplings") { limit = limits.couplingsPerPeak; aggregate = [limits.couplingsTotal, "couplings"]; }
        if (key === "atoms") { limit = limits.atoms; aggregate = [limits.atoms, "structure atoms"]; }
        if (key === "bonds") { limit = limits.bonds; aggregate = [limits.bonds, "structure bonds"]; }
        if (key === "warnings") { limit = limits.warnings; aggregate = [limits.warnings, "warnings"]; }
        if (key === "columns" || (kind === "table" && typeof key === "number" && path.at(-2) === "rows")) {
          limit = limits.tableColumns;
          aggregate = [limits.tableCells, "table cells"];
        }
        if (key === "rows") {
          limit = kind === "keyValue" ? limits.keyValueRows : limits.tableRows;
          aggregate = [limit, `${kind} rows`];
        }
        cap(value.length, limit, label, path);
        if (aggregate) total(value.length, aggregate[0], aggregate[1], path);
        charge(2 + Math.max(0, value.length - 1), path);
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, i);
          if (descriptor && !("value" in descriptor)) fail([...path, i], `${label} must not contain accessors`);
          visit(descriptor?.value, [...path, i], kind);
        }
      } else {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) fail(path, `${label} must be a plain JSON object`);
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
        if (kindDescriptor && "value" in kindDescriptor && typeof kindDescriptor.value === "string"
            && kindDescriptor.value.length <= 32) kind = kindDescriptor.value;
        charge(2, path);
        const fields = Reflect.ownKeys(value);
        cap(fields.length, limits.objectFields, `${kind} object fields`, path);
        let emitted = 0;
        for (const field of fields) {
          if (typeof field !== "string") return fail(path, `${kind} must not contain symbol keys`);
          cap(field.length, limits.stringLength, `${kind} field name length`, path);
          const descriptor = Object.getOwnPropertyDescriptor(value, field)!;
          if (!("value" in descriptor)) fail([...path, field], `${kind} ${field} must not be an accessor`);
          if (!descriptor.enumerable) fail([...path, field], `${kind} ${field} must be enumerable JSON data`);
          if (descriptor.value === undefined) continue; // JSON omits optional object properties.
          charge(encoder.encode(JSON.stringify(field)).byteLength + 1 + (emitted++ > 0 ? 1 : 0), path);
          visit(descriptor.value, [...path, field], kind);
        }
      }
      ancestors.delete(value);
    }
  };
  try { visit(raw, []); } catch (error) {
    if (error instanceof ReportLimitError) return { path: error.path, message: error.message };
    throw error;
  }
  return undefined;
}
