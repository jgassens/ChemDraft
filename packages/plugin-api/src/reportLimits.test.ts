import { describe, expect, it, vi } from "vitest";
import {
  PluginApiVersion, PluginPanelReportLimits as L, PluginPanelReportSchema,
  PluginPanelSectionSchema, isPluginApiVersionCompatible, type PluginLinkedFigureSection
} from "./index";
import { panelReportLimitIssue } from "./reportLimits";

const peak = () => ({ id: "h", ppm: 1.23, intensity: 1, atomIndices: [0] });
const figure = (): PluginLinkedFigureSection => ({
  kind: "linkedFigure", spectrum: { nucleus: "1H", domain: { min: 0, max: 12 }, peaks: [peak()] },
  structure: { atoms: [{ index: 0, x: 0, y: 0, element: "C" }], bonds: [] }
});
const report = (section: unknown) => ({ title: "NMR", sections: [section] });
function rejected(raw: unknown, message: string) {
  const result = PluginPanelReportSchema.safeParse(raw);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.message).toContain(message);
}
const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw)).byteLength;

// Synthetic test data: generated values do not come from a predictor or a real molecule.
const syntheticReport = () => ({
  title: "Synthetic NMR report",
  sections: [
    {
      kind: "linkedFigure" as const, title: "Synthetic spectrum", caption: "Synthetic assignments and couplings",
      spectrum: {
        nucleus: "1H", domain: { min: 0, max: 12 },
        peaks: Array.from({ length: 520 }, (_, i) => ({
          id: `p${i}`, ppm: (i % 120) / 10, intensity: 1, atomIndices: [i % 200],
          ...(i % 10 === 0 ? { couplings: [{ jHz: 7, partnerCount: 1 }] } : {})
        }))
      },
      structure: {
        atoms: Array.from({ length: 200 }, (_, i) => ({ index: i, x: i % 20, y: Math.floor(i / 20), element: "C" })),
        bonds: Array.from({ length: 199 }, (_, i) => ({ from: i, to: i + 1, order: 1 }))
      }
    },
    { kind: "table" as const, title: "Synthetic shifts", columns: ["Atom", "Shift"],
      rows: Array.from({ length: 20 }, (_, i) => [`${i}`, `${i / 10}`]) },
    { kind: "text" as const, body: "Synthetic report generated for limit tests." }
  ]
});

describe("bounded panel reports (API 0.1.18)", () => {
  it("advertises a patch-compatible API and accepts a synthetic report of realistic size", () => {
    const synthetic = syntheticReport();
    expect(PluginApiVersion).toBe("0.1.18");
    expect(isPluginApiVersionCompatible("^0.1.18", PluginApiVersion)).toBe(true);
    expect(isPluginApiVersionCompatible("^0.1.18", "0.1.17")).toBe(false);
    expect(bytes(synthetic)).toBeGreaterThan(25_448);
    expect(bytes(synthetic)).toBeLessThan(55_000);
    expect(L.serializedBytes / 25_448).toBeGreaterThan(1000);
    expect(PluginPanelReportSchema.parse(synthetic)).toEqual(synthetic);
  });

  it("accepts hundreds of synthetic NMR peaks with assignments, couplings and shift tables", () => {
    const synthetic = syntheticReport();
    const parsed = PluginPanelReportSchema.parse(synthetic);
    const linked = parsed.sections.find(s => s.kind === "linkedFigure");
    expect(linked?.kind === "linkedFigure" && linked.spectrum.peaks.length).toBe(520);
    expect(parsed).toEqual(synthetic);
  });

  it("preserves a synthetic 300-heavy-atom report with every assignment and 14,400 couplings", () => {
    const f = figure();
    f.structure = {
      atoms: Array.from({ length: 900 }, (_, index) => ({ index, x: index % 30, y: Math.floor(index / 30), element: index < 300 ? "C" : "H" })),
      bonds: Array.from({ length: 1800 }, (_, index) => ({ from: index % 900, to: (index + 1) % 900, order: 1 }))
    };
    f.spectrum.peaks = Array.from({ length: 900 }, (_, index) => ({
      id: String(index), ppm: index / 100, intensity: 1, atomIndices: [index],
      couplings: Array.from({ length: 16 }, (_, j) => ({ jHz: j + 1, partnerCount: 1 }))
    }));
    const raw = { title: "Synthetic upper-use NMR", sections: [
      f,
      { kind: "table", columns: Array(20).fill("Assignment"), rows: Array(900).fill(Array(20).fill("synthetic value")) },
      { kind: "keyValue", rows: Array(500).fill({ label: "Synthetic property", value: "value" }) },
      { kind: "chemicalName", name: "synthetic", label: "Name", kindLabel: "Synthetic",
        warnings: Array(900).fill({ code: "abbreviationExpanded", message: "Synthetic atom warning" }) }
    ] };
    expect(PluginPanelReportSchema.parse(raw)).toEqual(raw);
  });

  it("preserves a long Assistant reply, several maximum image sections and 30 sections", () => {
    const uri = "data:image/png;base64," + "A".repeat(Math.floor((L.imageLength - 22) / 4) * 4);
    const raw = { title: "Synthetic Assistant report", sections: [
      { kind: "text", body: "x".repeat(100_000) },
      ...Array.from({ length: 8 }, () => ({ kind: "image", dataUri: uri, alt: "Synthetic image" })),
      ...Array.from({ length: 21 }, () => ({ kind: "text", body: "Synthetic detail" }))
    ] };
    expect(PluginPanelReportSchema.parse(raw)).toEqual(raw);
  });

  it("preserves four figures at main's per-figure maxima unchanged", () => {
    const f = figure();
    f.structure = {
      atoms: Array.from({ length: 4_000 }, (_, index) => ({ index, x: index, y: 0, element: "C" })),
      bonds: Array.from({ length: 8_000 }, (_, i) => ({ from: i % 4_000, to: (i + 1) % 4_000, order: 1 }))
    };
    f.spectrum.peaks = Array.from({ length: 4_000 }, (_, i) => ({ ...peak(), id: String(i), atomIndices: [i] }));
    const raw = { title: "Synthetic multi-figure report", sections: Array(4).fill(f) };
    expect(PluginPanelReportSchema.parse(raw)).toEqual(raw);
  });

  it("accepts deeply nested action payloads within 4,000 characters", () => {
    for (const depth of [1_900, 2_000, 2_001]) {
      const payload = JSON.parse("[".repeat(depth) + "]".repeat(depth));
      const raw = report({ kind: "actions", id: "actions", buttons: [
        { id: "run", label: "Run", commandId: "plugin.test.run", payload }
      ] });
      if (depth <= 2_000) {
        const parsed = PluginPanelReportSchema.parse(raw);
        const section = parsed.sections[0]!;
        expect(JSON.stringify(section.kind === "actions" && section.buttons[0]!.payload)).toBe(JSON.stringify(payload));
      } else rejected(raw, "Panel payload must be JSON-serialisable, at most 4000 characters");
    }
    rejected(report({ kind: "actions", id: "actions", buttons: [
      { id: "run", label: "Run", commandId: "plugin.test.run", payload: "x".repeat(4_000) }
    ] }), "Panel payload must be JSON-serialisable, at most 4000 characters");
  });

  it("preserves a 300-field action payload within the 4,000-character cap", () => {
    const payload = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    expect(JSON.stringify(payload).length).toBeLessThan(4_000);
    const raw = report({ kind: "actions", id: "actions", buttons: [{ id: "run", label: "Run", commandId: "plugin.test.run", disabled: false, tone: "default", payload }] });
    expect(PluginPanelReportSchema.parse(raw)).toEqual(raw);
  });

  it("preserves main's assignment and SVG ceilings and a 4,000-peak sparse spectrum", () => {
    const f = figure();
    f.structure = undefined;
    f.spectrum.peaks = Array.from({ length: 4000 }, (_, index) => ({
      id: String(index), ppm: index / 100, intensity: 1,
      atomIndices: index === 0 ? Array.from({ length: 4000 }, (_, i) => i) : [index]
    }));
    const raw = { title: "Synthetic main compatibility", sections: [f, { kind: "svg", svg: " ".repeat(L.svgLength) }] };
    expect(PluginPanelReportSchema.parse(raw)).toEqual(raw);
  });

  it("snapshots realistic nested control data with 20 fields at depth 12 without sharing references", () => {
    const payload: Record<string, unknown> = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), i]));
    let leaf = payload;
    for (let i = 0; i < 8; i++) { const next = {}; leaf.next = next; leaf = next; }
    const raw = report({ kind: "actions", id: "controls",
      buttons: [{ id: "run", commandId: "plugin.test.run", label: "Run", payload }] });
    const result = PluginPanelReportSchema.parse(raw);
    expect(result).toMatchObject(raw);
    const section = result.sections[0]!;
    expect(section.kind === "actions" && section.buttons[0]!.payload).not.toBe(payload);
  });

  it("preserves every pre-existing control and label ceiling at its accepted maximum", () => {
    const f = figure();
    f.spectrum.solvent = "x".repeat(120);
    f.spectrum.comparison = { primaryLabel: "Primary", alternativeLabel: "Alternative", alternativeMarker: "x".repeat(8) };
    const raw = { title: "Synthetic controls", sections: [
      f,
      { kind: "prompt", id: "p".repeat(64), commandId: "plugin.test.run", maxLength: 20_000, rows: 12,
        select: { id: "s".repeat(64), label: "Synthetic selector", value: "x".repeat(100),
          options: Array.from({ length: 20 }, (_, i) => ({ label: String(i), value: String(i).padEnd(100, "x") })) } },
      { kind: "actions", id: "actions", buttons: Array.from({ length: 8 }, (_, i) => ({
        id: String(i).padEnd(64, "x"), label: "Synthetic action", commandId: "plugin.test.run", payload: "x".repeat(3998)
      })) }
    ] };
    expect(PluginPanelReportSchema.parse(raw)).toMatchObject(raw);
  });

  it.each([
    ["sections", () => ({ title: "NMR", sections: Array(L.sections + 1).fill({ kind: "text", body: "" }) }), `report sections: ${L.sections + 1}`],
    ["peaks", () => { const f = figure(); f.spectrum.peaks = Array(L.peaks + 1).fill(peak()); return report(f); }, `linkedFigure peaks: ${L.peaks + 1}`],
    ["indices per peak", () => { const f = figure(); f.spectrum.peaks[0]!.atomIndices = Array(L.atomIndicesPerPeak + 1).fill(0); return report(f); }, `linkedFigure atomIndices: ${L.atomIndicesPerPeak + 1}`],
    ["couplings per peak", () => { const f = figure(); f.spectrum.peaks[0]!.couplings = Array(L.couplingsPerPeak + 1).fill({ jHz: 7, partnerCount: 1 }); return report(f); }, `linkedFigure couplings: ${L.couplingsPerPeak + 1}`],
    ["atoms", () => { const f = figure(); f.structure!.atoms = Array(L.atoms + 1).fill(f.structure!.atoms[0]); return report(f); }, `linkedFigure atoms: ${L.atoms + 1}`],
    ["bonds", () => { const f = figure(); f.structure!.bonds = Array(L.bonds + 1).fill({ from: 0, to: 0, order: 1 }); return report(f); }, `linkedFigure bonds: ${L.bonds + 1}`],
    ["table rows", () => report({ kind: "table", columns: [], rows: Array(L.tableRows + 1).fill([]) }), `table rows: ${L.tableRows + 1}`],
    ["table columns", () => report({ kind: "table", columns: Array(L.tableColumns + 1).fill(""), rows: [] }), `table columns: ${L.tableColumns + 1}`],
    ["row cells", () => report({ kind: "table", columns: [], rows: [Array(L.tableColumns + 1).fill("")] }), `${L.tableColumns + 1} exceeds the limit of ${L.tableColumns}`],
    ["keyValue rows", () => report({ kind: "keyValue", rows: Array(L.keyValueRows + 1).fill({ label: "", value: "" }) }), `keyValue rows: ${L.keyValueRows + 1}`],
    ["warnings", () => report({ kind: "chemicalName", label: "Name", name: "ethanol", kindLabel: "name", warnings: Array(L.warnings + 1).fill({ code: "abbreviationExpanded", message: "expanded" }) }), `chemicalName warnings: ${L.warnings + 1}`],
    ["SVG", () => report({ kind: "svg", svg: "x".repeat(L.svgLength + 1) }), `svg svg length: ${L.svgLength + 1}`],
    ["image", () => report({ kind: "image", alt: "", dataUri: "x".repeat(L.imageLength + 1) }), `image dataUri length: ${L.imageLength + 1}`]
  ] as const)("rejects %s at limit + 1 with its value", (_name, make, message) => rejected(make(), message));

  it("checks array length before accessing any oversized entry", () => {
    const f = figure();
    f.spectrum.peaks = Array(L.peaks + 1);
    const getter = vi.fn(() => { throw new Error("must not read"); });
    Object.defineProperty(f.spectrum.peaks, 0, { get: getter });
    rejected(report(f), `linkedFigure peaks: ${L.peaks + 1} exceeds the limit of ${L.peaks}`);
    expect(getter).not.toHaveBeenCalled();
  });

  it("allows the individual peak ceiling (the independent byte ceiling still applies to full reports)", () => {
    const f = figure();
    f.spectrum.peaks = Array(L.peaks).fill(peak());
    const parsed = PluginPanelSectionSchema.parse(f);
    expect(parsed.kind === "linkedFigure" && parsed.spectrum.peaks.length).toBe(L.peaks);
  });

  it.each(["atom indices", "couplings"] as const)("caps aggregate %s across peaks and figures, at + 1", which => {
    const f = figure();
    const perPeak = which === "atom indices" ? L.atomIndicesPerPeak : L.couplingsPerPeak;
    const total = which === "atom indices" ? L.atomIndicesTotal : L.couplingsTotal;
    const make = (count: number) => ({ ...peak(), ...(which === "atom indices"
      ? { atomIndices: Array(count).fill(0) }
      : { couplings: Array(count).fill({ jHz: 7, partnerCount: 1 }) }) });
    f.spectrum.peaks = Array(total / perPeak).fill(make(perPeak));
    const raw = { title: "NMR", sections: [f, { ...figure(), spectrum: { ...f.spectrum, peaks: [make(0)] } }] };
    expect(PluginPanelReportSchema.safeParse(raw).success).toBe(true);
    raw.sections[1]!.spectrum.peaks = [make(1)];
    rejected(raw, `report total ${which}: ${total + 1} exceeds the limit of ${total}`);
  });

  it("caps total table cells, including column headers, at + 1", () => {
    const table = { kind: "table", columns: [] as string[], rows: Array(L.tableCells / L.tableColumns).fill(Array(L.tableColumns).fill("")) };
    expect(PluginPanelReportSchema.safeParse(report(table)).success).toBe(true);
    table.columns = [""];
    rejected(report(table), `report total table cells: ${L.tableCells + 1}`);
  });

  it.each(["table rows", "keyValue rows", "warnings"] as const)("aggregates %s across sections", which => {
    const count = which === "table rows" ? L.tableRows : which === "keyValue rows" ? L.keyValueRows : L.warnings;
    // Minimal raw entries isolate the aggregate preflight, before any per-entry Zod validation.
    const make = (n: number) => which === "warnings" ? { kind: "chemicalName", warnings: Array(n).fill(null) }
      : { kind: which === "table rows" ? "table" : "keyValue", rows: Array(n).fill([]) };
    rejected({ title: "NMR", sections: [make(count), make(1)] }, `report total ${which}: ${count + 1}`);
  });

  it("measures UTF-8 JSON including escaping and accepts exactly the byte cap, rejecting + 1", () => {
    const raw = { title: "NMR", sections: Array.from({ length: 160 }, () => ({ kind: "text", body: "x".repeat(Math.ceil(L.serializedBytes / 160)) })) };
    raw.sections[0]!.body = "μ\n".repeat(100) + raw.sections[0]!.body.slice(300);
    const excess = bytes(raw) - L.serializedBytes;
    raw.sections[159]!.body = raw.sections[159]!.body.slice(excess);
    expect(bytes(raw)).toBe(L.serializedBytes);
    expect(PluginPanelReportSchema.safeParse(raw).success).toBe(true);
    raw.sections[159]!.body += "x";
    expect(bytes(raw)).toBe(L.serializedBytes + 1);
    rejected(raw, `report serialized bytes (at least): ${L.serializedBytes + 1} exceeds the limit of ${L.serializedBytes}`);
  }, 60_000);

  it("includes schema defaults in the final serialized byte budget", () => {
    const raw = { title: "NMR", sections: [
      ...Array.from({ length: 159 }, () => ({ kind: "text", body: "x".repeat(Math.ceil(L.serializedBytes / 159)) })),
      { kind: "prompt", id: "composer", commandId: "plugin.test.run" }
    ] };
    const text = raw.sections[0]!;
    if ("body" in text) text.body = text.body.slice(bytes(raw) - L.serializedBytes);
    expect(bytes(raw)).toBe(L.serializedBytes);
    expect(panelReportLimitIssue(raw)).toBeUndefined();
    rejected(raw, "report serialized bytes (at least)");
  }, 60_000);

  const stringCases = [
    (s: string) => ({ ...report(figure()), title: s }),
    (s: string) => ({ ...report(figure()), source: { objectId: s, sourceFingerprint: "fp" } }),
    (s: string) => ({ ...report(figure()), source: { objectId: "m", sourceFingerprint: s } }),
    (s: string) => ({ ...report(figure()), rerunCommandId: s }),
    ...["title", "caption"].map(key => (s: string) => report({ ...figure(), [key]: s })),
    ...["nucleus", "solvent"].map(key => (s: string) => report({ ...figure(), spectrum: { ...figure().spectrum, [key]: s } })),
    ...["primaryLabel", "alternativeLabel", "alternativeMarker"].map(key => (s: string) => report({ ...figure(), spectrum: { ...figure().spectrum, comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", [key]: s } } })),
    ...["id", "label"].map(key => (s: string) => report({ ...figure(), spectrum: { ...figure().spectrum, peaks: [{ ...peak(), [key]: s }] } })),
    (s: string) => report({ ...figure(), structure: { atoms: [{ index: 0, x: 0, y: 0, element: s }], bonds: [] } }),
    (s: string) => report({ kind: "text", body: s }),
    (s: string) => report({ kind: "keyValue", rows: [{ label: s, value: s }] }),
    (s: string) => report({ kind: "table", columns: [s], rows: [[s]] }),
    (s: string) => report({ kind: "image", dataUri: "data:image/png;base64,AAAA", alt: s, caption: s }),
    (s: string) => report({ kind: "chemicalName", label: s, name: s, kindLabel: s, warnings: [{ code: "abbreviationExpanded", message: s }] }),
    (s: string) => report({ kind: "prompt", id: "composer", commandId: "plugin.test.run", placeholder: s, label: s, hint: s, submitLabel: s }),
    (s: string) => report({ kind: "actions", id: "actions", buttons: [{ id: "run", commandId: "plugin.test.run", label: s }] })
  ];
  it.each(stringCases)("bounds every report string family %#", make => {
    rejected(make("x".repeat(L.stringLength + 1)), "length:");
    expect(panelReportLimitIssue(make("x"))).toBeUndefined();
  });

  it.each([
    [report({ ...figure(), spectrum: { ...figure().spectrum, solvent: "x".repeat(121) } }), "solvent length: 121 exceeds the limit of 120"],
    [report({ ...figure(), spectrum: { ...figure().spectrum, comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "x".repeat(9) } } }), "alternativeMarker length: 9 exceeds the limit of 8"],
    [report({ kind: "prompt", id: "x".repeat(65) }), "id length: 65 exceeds the limit of 64"],
    [report({ kind: "prompt", select: { value: "x".repeat(101) } }), "value length: 101 exceeds the limit of 100"],
    [report({ kind: "prompt", select: { options: Array(21).fill(null) } }), "options: 21 exceeds the limit of 20"],
    [report({ kind: "actions", buttons: Array(9).fill(null) }), "buttons: 9 exceeds the limit of 8"],
    [report({ kind: "prompt", maxLength: 20_001 }), "maxLength: 20001 exceeds the limit of 20000"],
    [report({ kind: "prompt", rows: 13 }), "rows: 13 exceeds the limit of 12"],
    [report({ ...figure(), structure: { atoms: [], bonds: [{ from: 0, to: 0, order: 4 }] } }), "order: 4 exceeds the limit of 3"]
  ])("also names existing smaller limits %#", (raw, message) => rejected(raw, message as string));

  const numberFields = ["min", "max", "ppm", "intensity", "alternativePpm", "atomIndex", "jHz", "partnerCount", "index", "x", "y", "from", "to", "order", "maxLength", "rows", "maxWidthPx"];
  it.each(numberFields)("rejects all non-finite values of %s", field => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const f = figure();
      const p = f.spectrum.peaks[0]!;
      let raw: unknown = report(f);
      if (field === "min" || field === "max") f.spectrum.domain[field] = value;
      else if (field === "ppm" || field === "intensity" || field === "alternativePpm") p[field] = value;
      else if (field === "atomIndex") p.atomIndices = [value];
      else if (field === "jHz" || field === "partnerCount") p.couplings = [{ jHz: 7, partnerCount: 1, [field]: value }];
      else if (field === "index" || field === "x" || field === "y") f.structure!.atoms[0]![field] = value;
      else if (field === "from" || field === "to" || field === "order") f.structure!.bonds = [{ from: 0, to: 0, order: 1, [field]: value }];
      else if (field === "maxWidthPx") raw = report({ kind: "image", dataUri: "data:image/png;base64,AAAA", alt: "", maxWidthPx: value });
      else raw = report({ kind: "prompt", id: "composer", commandId: "plugin.test.run", [field]: value });
      rejected(raw, `${String(value)} must be finite`);
    }
  });

  it.each([-1, 0.5])("rejects non-integer or negative atom IDs: %s", index => {
    const f = figure();
    f.spectrum.peaks[0]!.atomIndices = [index];
    expect(PluginPanelReportSchema.safeParse(report(f)).success).toBe(false);
    f.spectrum.peaks[0]!.atomIndices = [0];
    f.structure!.atoms[0]!.index = index;
    expect(PluginPanelReportSchema.safeParse(report(f)).success).toBe(false);
    f.structure!.atoms[0]!.index = 0;
    for (const key of ["from", "to"] as const) {
      f.structure!.bonds = [{ from: 0, to: 0, order: 1, [key]: index }];
      expect(PluginPanelReportSchema.safeParse(report(f)).success).toBe(false);
    }
  });

  it.each(["from", "to", "peak"] as const)("names a missing atom ID in a %s reference", field => {
    const f = figure();
    f.structure!.atoms.push({ index: 5, x: 1, y: 1, element: "C" });
    if (field === "peak") f.spectrum.peaks[0]!.atomIndices = [42];
    else f.structure!.bonds = [{ from: 0, to: 5, order: 1, [field]: 42 }];
    rejected(report(f), "atom index: 42 is missing from structure atoms");
  });

  it("resolves sparse atom IDs independently of their array positions", () => {
    const f = figure();
    f.structure!.atoms = [5, 0, 2].map(index => ({ index, x: index, y: 0, element: "C" }));
    f.structure!.bonds = [{ from: 0, to: 2, order: 2 }];
    f.spectrum.peaks = [{ ...peak(), atomIndices: [0, 2] }, { ...peak(), id: "h-5", atomIndices: [5] }];
    expect(PluginPanelReportSchema.parse(report(f))).toEqual(report(f));
  });

  it("accepts non-negative assignments without geometry and rejects duplicate structure indices", () => {
    const f = figure();
    f.structure = undefined;
    f.spectrum.peaks[0]!.atomIndices = [123];
    expect(PluginPanelReportSchema.safeParse(report(f)).success).toBe(true);
    f.structure = { atoms: [{ index: 0, x: 0, y: 0, element: "C" }, { index: 0, x: 1, y: 1, element: "C" }], bonds: [] };
    rejected(report(f), "duplicate atom index: 0");
  });

  it("rejects cycles, accessors, hidden data and excessive depth without invoking plugin code", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    rejected({ ...report(figure()), cycle }, "cycle");
    const getter = vi.fn(() => "x".repeat(L.stringLength + 1));
    for (const enumerable of [true, false]) {
      const raw = report(figure());
      Object.defineProperty(raw, "title", { get: getter, enumerable });
      rejected(raw, "accessor");
    }
    expect(getter).not.toHaveBeenCalled();
    const raw = { ...report(figure()), nested: {} };
    let nested: Record<string, unknown> = raw.nested;
    for (let i = 0; i < L.depth; i++) { nested.next = {}; nested = nested.next as Record<string, unknown>; }
    rejected(raw, `report depth: ${L.depth + 1}`);
  });

  it("bounds malformed object fields and traversal nodes at + 1", () => {
    rejected(Object.fromEntries(Array.from({ length: L.objectFields + 1 }, (_, i) => [i, 0])),
      `report object fields: ${L.objectFields + 1}`);
    rejected({ blocks: Array(L.nodes / 50_000).fill(Array(50_000).fill(0)) }, `report nodes: ${L.nodes + 1}`);
    const raw = {};
    Object.defineProperty(raw, "x".repeat(L.stringLength + 1), { get() { throw new Error("must not read"); } });
    rejected(raw, `report field name length: ${L.stringLength + 1}`);
  });

  it("keeps arbitrary control payload keys separate from report schema field names", () => {
    const raw = report({ kind: "actions", id: "actions", buttons: [{ id: "run", label: "Run", commandId: "plugin.test.run",
      payload: { id: "x".repeat(65), value: "x".repeat(101), solvent: "x".repeat(121), buttons: Array(9).fill(0) } }] });
    expect(PluginPanelReportSchema.safeParse(raw).success).toBe(true);
  });

  const arrayCases = [
    { name: "sections", limit: L.sections, wrap: (a: unknown[]) => ({ title: "Test", sections: a }) },
    { name: "peaks", limit: L.peaks, wrap: (a: unknown[]) => report({ ...figure(), spectrum: { ...figure().spectrum, peaks: a } }) },
    { name: "rows", limit: L.tableRows, wrap: (a: unknown[]) => report({ kind: "table", columns: [], rows: a }) },
    { name: "nested row cells", limit: L.tableColumns, wrap: (a: unknown[]) => report({ kind: "table", columns: [], rows: [a] }) },
    { name: "nested assignments", limit: L.atomIndicesPerPeak, wrap: (a: unknown[]) => report({ ...figure(), spectrum: { ...figure().spectrum, peaks: [{ ...peak(), atomIndices: a }] } }) },
    { name: "nested payload arrays", limit: L.tableRows, wrap: (a: unknown[]) => report({ kind: "actions", id: "actions", buttons: [{ id: "run", label: "Run", commandId: "plugin.test.run", payload: { nested: a } }] }) }
  ];

  it.each(arrayCases)("rejects an endless Symbol.iterator getter on $name without calling it", ({ wrap }) => {
    const getter = vi.fn(function* () { while (true) yield { kind: "text", body: "unbounded" }; });
    const iteratorGetter = vi.fn(() => getter);
    const a: unknown[] = [];
    Object.defineProperty(a, Symbol.iterator, { get: iteratorGetter });
    rejected(wrap(a), "symbol keys");
    expect(iteratorGetter).toHaveBeenCalledTimes(0);
    expect(getter).toHaveBeenCalledTimes(0);
  });

  it.each(arrayCases)("rejects accessors, extra keys and non-plain prototypes on $name", ({ wrap }) => {
    const getter = vi.fn(() => { throw new Error("must not execute"); });
    const accessor = [null];
    Object.defineProperty(accessor, 0, { get: getter, enumerable: true });
    rejected(wrap(accessor), "accessors");
    const extra: unknown[] = [];
    Object.defineProperty(extra, "custom", { get: getter });
    rejected(wrap(extra), "only array indices");
    const exotic: unknown[] = [];
    Object.setPrototypeOf(exotic, Object.create(Array.prototype, { [Symbol.iterator]: { get: getter } }));
    rejected(wrap(exotic), "plain JSON array");
    expect(getter).toHaveBeenCalledTimes(0);
  });

  it.each(arrayCases)("stops at the $name count cap before inspecting entries or iterator accessors", ({ wrap, limit }) => {
    const getter = vi.fn(() => { throw new Error("must not execute"); });
    const descriptorRead = vi.fn(Reflect.getOwnPropertyDescriptor);
    const a = Array(limit + 1);
    Object.defineProperty(a, 0, { get: getter });
    Object.defineProperty(a, Symbol.iterator, { get: getter });
    rejected(wrap(new Proxy(a, { getOwnPropertyDescriptor: descriptorRead })),
      `${limit + 1} exceeds the limit of ${limit}`);
    expect(descriptorRead.mock.calls.map(call => call[1])).toEqual(["length"]);
    expect(getter).toHaveBeenCalledTimes(0);
  });

  it("rejects unsupported primitives, hidden data and array holes", () => {
    for (const value of [undefined, Symbol("x"), 1n, () => null]) {
      rejected(report({ kind: "table", columns: [], rows: [[value]] }), "JSON data");
    }
    const raw = report(figure());
    Object.defineProperty(raw, "hidden", { value: 1 });
    rejected(raw, "enumerable JSON data");
    const rows = [""];
    Object.defineProperty(rows, 0, { value: "", enumerable: false });
    rejected(report({ kind: "table", columns: [], rows: [rows] }), "enumerable JSON data");
    rejected(report({ kind: "table", columns: [], rows: [Array(1)] }), "holes");
    rejected(report(Object.create({ kind: "text", body: "inherited" })), "plain JSON object");
    rejected(report({ kind: "actions", id: "actions", buttons: [{ id: "run", label: "Run", commandId: "plugin.test.run", payload: { missing: undefined } }] }), "JSON data");
  });

  it("reads descriptors once and detaches a Proxy payload before Zod sees it", () => {
    const target = { nested: { value: "original" }, list: ["original"] };
    const get = vi.fn(Reflect.get);
    const descriptorRead = vi.fn(Reflect.getOwnPropertyDescriptor);
    const payload = new Proxy(target, { get, getOwnPropertyDescriptor: descriptorRead });
    const raw = report({ kind: "actions", id: "actions", buttons: [{ id: "run", label: "Run", commandId: "plugin.test.run", payload }] });
    const parsed = PluginPanelReportSchema.parse(raw);
    expect(get).toHaveBeenCalledTimes(0);
    expect(descriptorRead.mock.calls.map(call => call[1])).toEqual(["nested", "list"]);
    target.nested.value = "changed";
    target.list.push("x".repeat(L.serializedBytes));
    raw.title = "Changed";
    const section = parsed.sections[0]!;
    expect(section.kind === "actions" && section.buttons[0]!.payload).toEqual({ nested: { value: "original" }, list: ["original"] });
    expect(parsed.title).toBe("NMR");
    expect(bytes(parsed)).toBeLessThan(L.serializedBytes);
  });

  it("does not let Zod probe getters even on the top-level report", async () => {
    const getter = vi.fn(() => { throw new Error("must not execute"); });
    const raw = report(figure());
    Object.defineProperty(raw, "then", { get: getter, enumerable: true });
    rejected(raw, "accessor");
    expect(() => PluginPanelReportSchema.parse(raw)).toThrow("accessor");
    expect((await PluginPanelReportSchema.safeParseAsync(raw)).success).toBe(false);
    await expect(PluginPanelReportSchema.parseAsync(raw)).rejects.toThrow("accessor");
    expect((await PluginPanelReportSchema["~standard"].validate(raw)).issues).toBeDefined();
    expect(getter).toHaveBeenCalledTimes(0);
  });

  it("never re-reads kind or later descriptors after the first exceeded limit", () => {
    const f = figure();
    f.spectrum.peaks = Array(L.peaks + 1);
    const descriptorRead = vi.fn(Reflect.getOwnPropertyDescriptor);
    const raw = report(new Proxy(f, { getOwnPropertyDescriptor: descriptorRead }));
    rejected(raw, `linkedFigure peaks: ${L.peaks + 1}`);
    expect(descriptorRead.mock.calls.map(call => call[1])).toEqual(["kind", "spectrum"]);

    const afterLimit = vi.fn(Reflect.getOwnPropertyDescriptor);
    rejected(new Proxy({ title: "x".repeat(L.stringLength + 1), sections: [] }, { getOwnPropertyDescriptor: afterLimit }), "title length");
    expect(afterLimit.mock.calls.map(call => call[1])).toEqual(["title"]);
  });
});
