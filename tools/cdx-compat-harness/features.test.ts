import { describe, expect, it, vi } from "vitest";
import { describeDocument, describeStructure, rdkitReason, SummaryContext, nativeGraphHash } from "./chemistry";
import { ensureRdkit, type RdkitMinimalModule, type RdkitJsMol } from "../../packages/rdkit-adapter/src/conformer";
import { installNodeRdkitModuleLoader } from "../../packages/rdkit-adapter/src/node";
import { rdkitError, stageError } from "./errors";
import { compare, compareSurvival, warning, guardDifferences, chemistryFeatures, jsonEqual, type MoleculeSummary, type Summary } from "./model";
import { sourceSurvival, nativeSurvival } from "./survival";
import { open, interchange } from "./codec";
import { BracketObjectSchema, createEmptyDocument, deserializeDocument, serializeDocument, GraphicObjectSchema, MoleculeObjectSchema, ReactionObjectSchema, SuperatomObjectSchema, TextObjectSchema } from "../../packages/chem-core/src/index";
import { readFile } from "node:fs/promises";
import { testResonance } from "./resonance";
import { compareSigma } from "./sigma";

const summary = (molecules: MoleculeSummary[]): Summary => ({ molecules, reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } });
const wrap = (content: string) => `<CDXML CreationProgram="ChemDraft"><page id="1" BoundingBox="0 0 612 792">${content}</page></CDXML>`;
const molecule = (nodes: [number, number, number, string?][], edges: [number, number, string?, string?][]) => `<fragment id="2">${nodes.map(([element, x, y, extra = ""], k) => `<n id="${k + 10}" Element="${element}" p="${x} ${y}" ${extra}/>`).join("")}${edges.map(([a, b, order = "1", display], k) => `<b id="${k + 100}" B="${a + 10}" E="${b + 10}" Order="${order}"${display ? ` Display="${display}"` : ""}/>`).join("")}</fragment>`;

describe("synthetic abbreviation and display survival", () => {
  it("counts native superatom records and excludes repeated label-only atoms", () => {
    const document = createEmptyDocument();
    const base = { x: 0, y: 0, width: 30, height: 30 };
    document.pages[0].objects = [
      SuperatomObjectSchema.parse({ ...base, id: "label", type: "superatom", label: "Me", metadata: { label: "Me" } }),
      MoleculeObjectSchema.parse({ ...base, id: "graph", type: "molecule", structureFormat: "smiles", structure: "", superatoms: [{ label: "OMe" }],
        atoms: [0, 1, 2].map(i => ({ id: `a${i}`, element: "OMe", labelLiteral: true, x: i * 30, y: 0 })), bonds: [] })
    ];
    expect(nativeSurvival(document).abbreviations).toBe(2);
  });

  it.each(["Nickname", "Fragment"])("preserves an expanded %s abbreviation on initial import, with unchanged chemistry", async nodeType => {
    const xml = wrap(`<fragment id="2"><n id="10" Element="6" p="0 0"/>
      <n id="11" NodeType="${nodeType}" p="30 0"><t><s>OMe</s></t><fragment id="12">
        <n id="13" NodeType="ExternalConnectionPoint" p="0 0"/><n id="14" Element="8" p="30 0"/>
        <n id="15" Element="6" p="60 0"/><b id="16" B="13" E="14" Order="1"/><b id="17" B="14" E="15" Order="1"/>
      </fragment></n><b id="18" B="10" E="11" Order="1"/></fragment>`);
    const opened = await open(Buffer.from(xml));
    const after = await describeDocument(opened.document!, []);
    expect(after.molecules[0].smiles).toBe((await describeStructure("COC")).smiles);
    const source = sourceSurvival(Buffer.from(xml));
    expect(source.abbreviations).toBe(1);
    expect(after.survival!.abbreviations).toBe(1);
    expect(compareSurvival(source, after.survival!, opened.warnings)).toMatchObject({ verdict: "PASS", differences: [] });
  });

  it.each(["Nickname", "Fragment"])("keeps a labelled %s counted when its drawing survives", async nodeType => {
    const xml = wrap(`<fragment id="2"><n id="10" NodeType="${nodeType}" p="0 0"><t><s>OMe</s></t></n></fragment>`);
    const opened = await open(Buffer.from(xml));
    const before = await describeDocument(opened.document!, []);
    expect(before.survival!.abbreviations).toBe(0);
    expect(compareSurvival(sourceSurvival(Buffer.from(xml)), before.survival!, []).verdict).toBe("PASS");
    for (const format of ["cdx", "cdxml"] as const) {
      const after = await describeDocument((await open((await interchange(opened.document!, format)).bytes)).document!, []);
      expect(compare(before, after, []).verdict, JSON.stringify({ format, before: before.survival, after: after.survival, differences: compare(before, after, []).differences })).toBe("PASS");
    }
  });

  it("classifies loss of an abbreviation drawing after import without hiding equal expanded chemistry", async () => {
    const xml = wrap(`<fragment id="2"><n id="10" Element="6" p="0 0"/><n id="11" NodeType="Nickname" p="30 0"><t><s>OMe</s></t></n><b id="20" B="10" E="11" Order="1"/></fragment>`);
    const before = await describeDocument((await open(Buffer.from(xml))).document!, []);
    const expanded = await describeDocument((await open(Buffer.from(wrap(molecule([[6, 0, 0], [8, 30, 0], [6, 60, 0]], [[0, 1], [1, 2]]))))).document!, []);
    expect(before.molecules[0].smiles).toBe(expanded.molecules[0].smiles);
    expect(compare(before, expanded, []).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compare(before, expanded, [warning({ code: "cdxml.abbreviation_not_expanded", message: "Abbreviation drawing lost" })]).verdict).toBe("WARNED");
    const isomer = { ...expanded, molecules: [await describeStructure("CCO")] };
    expect(isomer.molecules[0].formula).toBe(expanded.molecules[0].formula);
    expect(compare(before, isomer, []).verdict).toBe("FAIL");
  });

  it("reports a dropped ring circle, preserves a surviving circle, and requires a warning naming the kind", async () => {
    const xml = wrap(`${molecule([[6, 0, 0]], [])}<graphic id="50" GraphicType="Oval" OvalType="Circle" BoundingBox="0 0 20 20"/>`);
    const opened = await open(Buffer.from(xml));
    const before = await describeDocument(opened.document!, []);
    const source = sourceSurvival(Buffer.from(xml));
    expect(source.display).toEqual({ "graphic.Oval.Circle": 1 });
    expect(compareSurvival(source, before.survival!, []).verdict).toBe("PASS");
    for (const format of ["cdx", "cdxml"] as const) {
      const after = await describeDocument((await open((await interchange(opened.document!, format)).bytes)).document!, []);
      expect(compare(before, after, []).verdict, JSON.stringify({ format, before: before.survival, after: after.survival, differences: compare(before, after, []).differences })).toBe("PASS");
    }
    opened.document!.pages[0].objects = opened.document!.pages[0].objects.filter(o => o.type !== "graphic");
    const after = await describeDocument(opened.document!, []);
    expect(after.molecules).toEqual(before.molecules);
    expect(compare(before, after, [])).toMatchObject({ verdict: "DRAWN-DIFFERENTLY", drawingLoss: expect.arrayContaining(["other-graphics"]) });
    expect(compareSurvival(source, after.survival!, []).differences).toContainEqual(expect.objectContaining({ feature: "display-object", before: { kind: "graphic.Oval.Circle", count: 1 }, after: { kind: "graphic.Oval.Circle", count: 0 } }));
    expect(compare(before, after, [warning({ code: "cdxml.object_import_unsupported", message: "Circle graphic dropped" })]).verdict).toBe("WARNED");
    expect(compare(before, after, [warning({ code: "cdxml.object_import_unsupported", message: "Text object dropped" })]).verdict).toBe("DRAWN-DIFFERENTLY");
  });
});

describe("synthetic bracket pair survival", () => {
  it("summarizes pairs independently of IDs and order and distinguishes chemistry from drawing", async () => {
    const doc = createEmptyDocument();
    // This checkout's schema predates these fields; their shapes match the native product schema.
    const bracket = (id: string) => Object.assign(BracketObjectSchema.parse({ id, type: "bracket", x: 0, y: 0, width: 10, height: 20, bracketKind: "square", label: "n", containedObjectIds: ["member"] }), { pairId: "pair", bracketUsage: "multiple", repeatCount: 3, repeatUnit: true as boolean | undefined, crossingBondIds: [{ objectId: "member", bondId: "bond" }, { objectId: "member", bondId: "bond2" }] });
    const a = bracket("a"), b = bracket("b");
    const orphan = BracketObjectSchema.parse({ id: "orphan", type: "bracket", x: 0, y: 0, width: 10, height: 20, bracketKind: "square" });
    doc.pages[0].objects = [a, b, orphan];
    const before = await describeDocument(doc, []);
    expect(before.brackets).toMatchObject([{ bracketKind: "square", bracketUsage: ["multiple", "multiple"], repeatCount: [3, 3], label: "n", repeatUnit: [true, true], memberCount: 1, crossingBondCount: 2 }]);
    expect(before.unpairedBrackets).toBe(1);
    doc.pages[0].objects = [b, a, orphan];
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("PASS");
    a.repeatUnit = undefined;
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("FAIL");
    a.repeatUnit = true;
    a.crossingBondIds.pop(); b.crossingBondIds.pop();
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("FAIL");
    a.crossingBondIds.push({ objectId: "member", bondId: "bond2" }); b.crossingBondIds.push({ objectId: "member", bondId: "bond2" });
    a.repeatCount = 4;
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("FAIL");
    a.repeatCount = 3;
    delete (a as { repeatCount?: number }).repeatCount; delete (b as { repeatCount?: number }).repeatCount;
    const lostCount = await describeDocument(doc, []);
    expect(compare(before, lostCount, []).verdict).toBe("FAIL");
    expect(compare(before, lostCount, [warning({ code: "cdxml.bracket_loss", message: "Bracket repeat count was lost" })]).verdict).toBe("WARNED");
    expect(compare(before, lostCount, [warning({ code: "cdxml.bracket_loss", message: "Bracket usage was lost" })]).verdict).toBe("FAIL");
    for (const [key, value] of [["bracketUsage", ["generic", "multiple"]], ["repeatUnit", [false, true]], ["memberCount", 0], ["crossingBondCount", 0]] as const) {
      const changed = structuredClone(before);
      Object.assign(changed.brackets![0], { [key]: value });
      expect(compare(before, changed, []).verdict).toBe("FAIL");
    }
    a.repeatCount = b.repeatCount = 3; a.label = b.label = "m";
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("DRAWN-DIFFERENTLY");
    doc.pages[0].objects = [];
    expect(compare(before, await describeDocument(doc, []), []).verdict).toBe("FAIL");
    expect(compare(before, await describeDocument(doc, []), [warning({ code: "cdxml.bracket_payload_only", message: "Native brackets have no CDXML equivalent", objectId: "b" })]).verdict).toBe("WARNED");
  });
});

describe("comparison identity and invariants", () => {
  it("refuses positional pairing when heavy-element multisets differ", async () => {
    const doc = createEmptyDocument();
    const mol = (id: string, element: string, x: number) => MoleculeObjectSchema.parse({ id, type: "molecule", x: 0, y: 0, width: 40, height: 40, structureFormat: "smiles", structure: "", atoms: [{ id: `${id}a`, element: "C", x, y: 0 }, { id: `${id}b`, element, x: x + 30, y: 0 }], bonds: [{ id: `${id}bond`, fromAtomId: `${id}a`, toAtomId: `${id}b`, order: "single" }] });
    doc.pages[0].objects = [mol("old", "O", 0)];
    const before = await describeDocument(doc, []);
    const changed = mol("new", "O", 0);
    changed.atoms.push({ ...changed.atoms[1], id: "extra", element: "N", x: 15, y: 0 });
    doc.pages[0].objects = [changed];
    const after = await describeDocument(doc, []);
    const result = compare(before, after, []);
    expect(result.verdict).toBe("FAIL");
    expect(new Set(result.differences.map(d => d.molecule?.change))).toEqual(new Set(["added", "removed"]));
    expect(result.differences.every(d => !d.delta)).toBe(true);
    doc.pages[0].objects = [mol("one", "O", 0), mol("two", "N", 100)];
    const originals = await describeDocument(doc, []);
    doc.pages[0].objects = [mol("new-one", "N", 0), mol("new-two", "O", 100)];
    expect(compare(originals, await describeDocument(doc, []), []).verdict).toBe("PASS");
    doc.pages[0].objects = [mol("left", "O", 0), mol("right", "O", 0)];
    const ambiguousBefore = await describeDocument(doc, []);
    doc.pages[0].objects = [changed];
    const ambiguous = compare(ambiguousBefore, await describeDocument(doc, []), []);
    expect(ambiguous.differences.every(d => d.molecule?.change)).toBe(true);
  });
  it("drops and counts deep-equal diagnostics for every chemistry feature", () => {
    const invalid = chemistryFeatures.map(feature => ({ feature, warned: false, before: [{ strict: false, nested: [1, 2] }], after: [{ nested: [1, 2], strict: false }] }));
    expect(guardDifferences(invalid)).toEqual({ differences: [], comparisonInternalErrors: chemistryFeatures.length });
    expect(guardDifferences([{ feature: "other", warned: false, before: 1, after: 2 }]).differences).toHaveLength(1);
  });

  it("pairs reordered identities before reused IDs, ignoring sanitization reason strings", async () => {
    const a = { ...await describeStructure("C"), strict: false, objectId: "one", sanitization: { reason: "other" } };
    const b = { ...await describeStructure("N"), objectId: "two" };
    const before = summary([a, b]);
    const after = summary([{ ...b, objectId: "one" }, { ...a, objectId: "two", sanitization: { reason: "parse" } }]);
    expect(compare(before, after, [])).toMatchObject({ verdict: "PASS", differences: [], comparisonInternalErrors: 0 });
  });

  it("attributes a change among twenty reordered molecules only to that molecule", async () => {
    const molecules = await Promise.all(Array.from({ length: 20 }, async (_, i) => ({ ...await describeStructure("C".repeat(i + 1)), objectId: `m${i}` })));
    const after = structuredClone(molecules).reverse();
    after.find(m => m.objectId === "m7")!.strict = false;
    const result = compare(summary(molecules), summary(after), []);
    expect(result.differences).toEqual([expect.objectContaining({ feature: "sanitization-changed", before: true, after: false, molecule: { before: "m7", after: "m7" } })]);
    expect(result.differences.every(d => !jsonEqual(d.before, d.after))).toBe(true);
    after[after.findIndex(m => m.objectId === "m7")] = { ...await describeStructure("CCCCCCCCO"), objectId: "m7" };
    const chemistryChange = compare(summary(molecules), summary(after), []);
    expect(chemistryChange.differences.map(d => d.feature)).toEqual(["atom-bond-count", "connectivity", "other"]);
    expect(chemistryChange.differences.every(d => d.molecule?.before === "m7" && d.molecule.after === "m7")).toBe(true);
  });

  it("reports unmatched identities as added and removed without positional pairing", async () => {
    const a = { ...await describeStructure("C"), objectId: "removed" };
    const b = { ...await describeStructure("N"), objectId: "added" };
    const compared = compare(summary([a]), summary([b]), []);
    expect(compared.verdict).toBe("FAIL");
    expect(new Set(compared.differences.map(d => d.molecule?.change))).toEqual(new Set(["added", "removed"]));
  });
});

describe("resonance-aware identity", () => {
  it("uses the actual Node MinimalLib FixedH binding, not a presumed resonance API", async () => {
    const keto = await describeStructure("O=c1cccc[nH]1"), enol = await describeStructure("Oc1ccccn1");
    const rdkit = await ensureRdkit();
    expect(Object.keys(rdkit).filter(key => /resonance/i.test(key))).toEqual([]);
    expect(keto.species!.inchiKey).toBe(enol.species!.inchiKey);
    expect(keto.species!.fixedHInchi).toContain("/f/h6H");
    expect(enol.species!.fixedHInchi).toContain("/f/h7H");
    expect(keto.species!.explicitHSmiles).toContain("[nH]");
    const result = compare(summary([keto]), summary([enol]), []);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences.every(d => d.identityEvidence?.standardInchi === "match"
      && d.identityEvidence.decision === "fixed-hydrogen-mismatch")).toBe(true);
  });

  it.each([
    ["pentamethine cyanine", "C[N+](C)=CC=CC=CN(C)CC", "CN(C)C=CC=CC=[N+](C)CC"],
    ["carboxylate", "CC(=O)[O-]", "CC([O-])=O"],
    ["nitro", "C[N+](=O)[O-]", "C[N+]([O-])=O"]
  ])("proves %s resonance, including charge swaps hidden by canonical SMILES", async (_name, left, right) => {
    const a = await describeStructure(left), b = await describeStructure(right);
    for (const fallback of [false, true]) {
      if (fallback) { delete a.species!.inchiKey; delete b.species!.inchiKey; }
      const result = compare(summary([a]), summary([b]), []);
      expect(result.verdict).toBe("DRAWN-DIFFERENTLY");
      expect(result.differences.length).toBeGreaterThan(0);
      expect(result.differences.every(d => d.identityEvidence?.resonance === "reachable"
        && d.identityEvidence.fixedHydrogen === "fixed-h-inchi")).toBe(true);
    }
  });

  it("keeps aromaticity-canonicalised benzene Kekule drawings as PASS", async () => {
    const a = await describeStructure("C1=CC=CC=C1"), b = await describeStructure("C1C=CC=CC=1");
    expect(a.smiles).toBe("c1ccccc1");
    expect(b.smiles).toBe(a.smiles);
    expect(testResonance(a.species!.graph!, b.species!.graph!)).toBe("reachable");
    expect(compare(summary([a]), summary([b]), []).verdict).toBe("PASS");
  });

  it.each([
    ["1-butene / 2-butene", "C=CCC", "CC=CC"],
    ["acetone / prop-1-en-2-ol", "CC(=O)C", "C=C(O)C"],
    ["2-pyridone / 2-hydroxypyridine", "O=c1cccc[nH]1", "Oc1ccccn1"],
    ["extra double bond with H loss", "C=CCC", "C=CC=C"]
  ])("rejects %s with and without standard InChI evidence", async (_name, left, right) => {
    const a = await describeStructure(left), b = await describeStructure(right);
    for (const fallback of [false, true]) {
      if (fallback) { delete a.species!.inchiKey; delete b.species!.inchiKey; }
      expect(compare(summary([a]), summary([b]), []).verdict).toBe("FAIL");
      expect(testResonance(a.species!.graph!, b.species!.graph!)).not.toBe("reachable");
    }
  });

  it("uses explicit-H canonical SMILES when FixedH is unavailable and never trusts standard InChI alone", async () => {
    const a = await describeStructure("CC(=O)[O-]"), b = await describeStructure("CC([O-])=O");
    delete a.species!.fixedHInchi; delete b.species!.fixedHInchi;
    expect(a.species!.explicitHSmiles).toBe("[CH3][C](=[O])[O-]");
    const result = compare(summary([a]), summary([b]), []);
    expect(result.verdict).toBe("DRAWN-DIFFERENTLY");
    expect(result.differences[0].identityEvidence?.fixedHydrogen).toBe("explicit-h-smiles");
    const keto = await describeStructure("O=c1cccc[nH]1"), enol = await describeStructure("Oc1ccccn1");
    delete keto.species!.fixedHInchi; delete enol.species!.fixedHInchi;
    expect(compare(summary([keto]), summary([enol]), []).verdict).toBe("FAIL");
    const amide = await describeStructure("CC(=O)N(C)C"), chargedAmide = await describeStructure("CC([O-])=[N+](C)C");
    delete chargedAmide.species!.graph;
    const missing = compare(summary([amide]), summary([chargedAmide]), []);
    expect(missing.verdict).toBe("FAIL");
    expect(missing.differences[0].identityEvidence?.resonance).toBe("undetermined");
  });

  it("rejects electron redistribution across two conjugated systems separated by a saturated atom", async () => {
    const a = await describeStructure("CN(C)C(=O)CC(=O)N(C)C");
    const b = await describeStructure("C[N+](C)=C([O-])CC([O-])=[N+](C)C");
    expect(a.species!.fixedHInchi).toBe(b.species!.fixedHInchi);
    expect(testResonance(a.species!.graph!, b.species!.graph!)).toBe("disconnected-conjugation");
    const result = compare(summary([a]), summary([b]), []);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences[0].identityEvidence?.resonance).toBe("disconnected-conjugation");
  });

  it("fails closed for exhausted search budgets and invalid Lewis structures", async () => {
    const a = await describeStructure("CC(=O)N(C)C"), b = await describeStructure("CC([O-])=[N+](C)C");
    expect(testResonance(a.species!.graph!, b.species!.graph!, 1)).toBe("undetermined");
    const invalid = structuredClone(b.species!.graph!);
    invalid.atoms[2].charge = -2; invalid.atoms[3].charge = 2;
    expect(testResonance(a.species!.graph!, invalid)).toBe("invalid-lewis-structure");
    b.species!.graph = invalid;
    const result = compare(summary([a]), summary([b]), []);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences[0].identityEvidence?.resonance).toBe("invalid-lewis-structure");
  });

  it("requires fixed per-atom H counts even if stale identifiers claim a match", async () => {
    const a = await describeStructure("C=CCC"), b = await describeStructure("CC=CC");
    b.species!.fixedHInchi = a.species!.fixedHInchi; b.species!.inchiKey = a.species!.inchiKey;
    const result = compare(summary([a]), summary([b]), []);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences[0].identityEvidence?.resonance).toBe("atom-or-hydrogen-mismatch");
  });

  it.each([false, true])("classifies cyanine resonance drawings (fallback: %s)", async fallback => {
    const a = await describeStructure("C[N+](C)=CC=CN(C)CC");
    const b = await describeStructure("CN(C)C=CC=[N+](C)CC");
    expect(a.smiles).not.toBe(b.smiles);
    if (fallback) { delete a.species!.inchiKey; delete b.species!.inchiKey; }
    const result = compare(summary([a]), summary([b]), []);
    expect(result.verdict).toBe("DRAWN-DIFFERENTLY");
    expect(result.differences.every(d => d.classification === "same-species-different-drawing" && d.identityCheck === (fallback ? "electron-pair-resonance" : "standard-inchi"))).toBe(true);
  });

  it.each([false, true])("recognises neutral and charge-separated amide resonance drawings (fallback: %s)", async fallback => {
    const a = await describeStructure("CC(=O)N(C)C"), b = await describeStructure("CC([O-])=[N+](C)C");
    if (fallback) { delete a.species!.inchiKey; delete b.species!.inchiKey; }
    expect(compare(summary([a]), summary([b]), []).verdict).toBe("DRAWN-DIFFERENTLY");
  });

  it.each([["[NH4+]", "N"], ["C=CCC", "CC=CC"], ["CC=O", "C=CO"], ["NCC(=O)O", "[NH3+]CC(=O)[O-]"], ["[13CH3]N", "CN"], ["[CH2]C", "CC"], ["N[C@H](C)O", "N[C@@H](C)O"], ["C[N+](C)=CC=CN(C)C[C@H](O)C", "CN(C)C=CC=[N+](C)C[C@@H](O)C"]])("keeps real chemistry changes as FAIL (%s -> %s)", async (left, right) => {
    const a = await describeStructure(left), b = await describeStructure(right);
    expect(compare(summary([a]), summary([b]), []).verdict).toBe("FAIL");
    if (a.species) delete a.species.inchiKey;
    if (b.species) delete b.species.inchiKey;
    expect(compare(summary([a]), summary([b]), []).verdict).toBe("FAIL");
  });

  it("never downgrades protected feature losses even with matching identity metadata", async () => {
    const a = await describeStructure("C[N+](C)=CC=CN(C)CC");
    for (const change of [
      (b: MoleculeSummary) => { b.formula += "H"; },
      (b: MoleculeSummary) => { b.charge++; },
      (b: MoleculeSummary) => { b.atomCount++; },
      (b: MoleculeSummary) => { b.isotopes = [{ atom: 0, mass: 13 }]; },
      (b: MoleculeSummary) => { b.radicals = [{ atom: 0, electrons: 1 }]; },
      (b: MoleculeSummary) => { b.tetrahedral = [{ atom: 0, cip: "S" }]; b.featureKeys.stereo = "changed"; }
    ]) {
      const b = structuredClone(a); change(b);
      expect(compare(summary([a]), summary([b]), []).verdict).toBe("FAIL");
    }
  });
});

describe("feature-specific chemistry differences", () => {
  const orderWarning = (objectId = "new") => warning({ code: "cdxml.aromatic_bond_approximation", message: "Aromatic bond order was approximated.", objectId });
  // Synthetic stored-summary evidence: pin every atom/H count and vary only one
  // order. Feature relocation tests independently change the labelled atoms.
  const orderPair = (left: MoleculeSummary, right = structuredClone(left)) => {
    const a = structuredClone(left), b = structuredClone(right);
    a.objectId = "old"; b.objectId = "new";
    const graph = a.species!.graph!;
    const chain = graph.bonds.findIndex(bond => bond.atoms.every(i => graph.atoms[i].z === 6 && graph.atoms[i].h === 1));
    const bondIndex = chain < 0 ? 0 : chain;
    graph.bonds[bondIndex].order = 1.5;
    b.species!.graph!.bonds[bondIndex].order = 1;
    a.connectivity += " (synthetic Order=1.5)";
    b.connectivity += " (synthetic Order=1)";
    // Keep synthetic identities consistent with the deliberately changed orders.
    a.smiles += " (synthetic Order=1.5)";
    b.smiles += " (synthetic Order=1)";
    a.pairing = b.pairing = { page: 0, centroid: [0, 0], bondLength: 30, elements: a.featureAtoms!.filter(a => a.z > 1).map(a => String(a.z)), labels: [], bonds: a.bonds };
    return [summary([a]), summary([b])] as const;
  };
  const reverseAtoms = (m: MoleculeSummary) => {
    const remap = (i: number) => m.atomCount - 1 - i;
    m.featureAtoms?.reverse();
    m.species?.graph?.atoms.reverse();
    for (const bonds of [m.species?.graph?.bonds, m.featureBonds]) for (const bond of bonds ?? []) bond.atoms = bond.atoms.map(remap) as [number, number];
    for (const atom of [...m.isotopes, ...m.radicals, ...m.tetrahedral]) atom.atom = remap(atom.atom);
    for (const bond of m.doubleBonds) bond.atoms = bond.atoms.map(remap);
  };

  it("rejects CCO / COC at identical positions despite a new-ID bond-order warning", async () => {
    const a = { ...await describeStructure("CCO"), objectId: "old" };
    const b = { ...await describeStructure("COC"), objectId: "new" };
    a.pairing = b.pairing = { page: 0, centroid: [0, 0], bondLength: 30, elements: ["C", "C", "O"], labels: ["O"], bonds: 2 };
    const result = compare(summary([a]), summary([b]), [orderWarning()]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences).toContainEqual(expect.objectContaining({ feature: "connectivity", warned: false }));
    expect(result.differences[0].delta).toEqual({ atomsAdded: [], atomsRemoved: [], bondsAdded: 0, bondsRemoved: 0, labelsAdded: [], labelsRemoved: [] });
    const tied = compare(summary([a, { ...a, objectId: "also-old" }]), summary([b]), [orderWarning()]);
    expect(tied.differences.every(d => d.molecule?.change)).toBe(true);
  });

  it("rejects charge relocation between carbonyl and alkoxide fragments with a bond-order warning", async () => {
    const a = { ...await describeStructure("CC(=O)C.CCC[O-]"), objectId: "m1" };
    const b = { ...await describeStructure("CC([O-])C.CCC=O"), objectId: "m1" };
    expect(compare(summary([a]), summary([b]), [orderWarning("m1")]).verdict).toBe("FAIL");
  });

  it.each([
    ["stereo", "C[C@H](O)CC[C@H](F)C", "C[C@@H](O)CC[C@@H](F)C"],
    ["isotope", "[13CH3]CCOC", "CCCO[13CH3]"]
  ] as const)("detects mapped %s relocation alongside a warned bond-order change", async (feature, left, right) => {
    const [a, b] = orderPair(await describeStructure(left), await describeStructure(right));
    const result = compare(a, b, [orderWarning()]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences).toContainEqual(expect.objectContaining({ feature, warned: false }));
  });

  it("warns for a cyanine chain Order 1.5 -> 1 with identical atoms, H and features", async () => {
    const [a, b] = orderPair(await describeStructure("C[N+](C)=CC=CC=CN(C)CC"));
    expect(compare(a, b, [orderWarning()]).verdict).toBe("WARNED");
    expect(compare(a, b, [orderWarning("unrelated")]).verdict).toBe("FAIL");
    expect(compare(a, b, [orderWarning("")]).verdict).toBe("FAIL");
  });

  it("resolves symmetric p-xylene under a warned order change", async () => {
    const m = await describeStructure("[13CH3]c1ccc(C)cc1"), reordered = structuredClone(m);
    reverseAtoms(reordered);
    expect(compare(summary([m]), summary([reordered]), []).verdict).toBe("PASS");
    const [a, b] = orderPair(m);
    reverseAtoms(b.molecules[0]);
    expect(compareSigma(a.molecules[0], b.molecules[0])?.changes).toEqual({});
    expect(compare(a, b, [orderWarning()]).verdict).toBe("WARNED");
  });

  it.each(["charge", "radical"] as const)("maps %s relocation after atom reordering, even with identical H counts", async feature => {
    const [a, b] = orderPair(await describeStructure("CCCOC"));
    for (const [m, index] of [[a.molecules[0], 0], [b.molecules[0], 4]] as const) {
      m.featureAtoms![index][feature] = 1;
      m.species!.graph!.atoms[index][feature] = 1;
      if (feature === "charge") m.charge = 1;
      else m.radicals = [{ atom: index, electrons: 1 }];
    }
    reverseAtoms(b.molecules[0]);
    const mapped = compareSigma(a.molecules[0], b.molecules[0]);
    expect(mapped?.status).toBe("isomorphic");
    expect(mapped?.changes).toHaveProperty(feature);
    const result = compare(a, b, [orderWarning()]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences).toContainEqual(expect.objectContaining({ feature, warned: false }));
    const featureWarning = warning({ code: "cdx.property_skipped", message: `${feature} was lost.`, objectId: "new" });
    expect(compare(a, b, [orderWarning(), featureWarning]).verdict).toBe("WARNED");
    expect(compare(a, b, [orderWarning(), { ...featureWarning, objectId: "unrelated" }]).verdict).toBe("FAIL");
  });

  it("maps E/Z labels to bonds rather than comparing their multiset", async () => {
    const [a, b] = orderPair(await describeStructure("C/C=C/CC/C=C\\CCO"), await describeStructure("C/C=C\\CC/C=C/CCO"));
    reverseAtoms(b.molecules[0]);
    const result = compare(a, b, [orderWarning()]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences).toContainEqual(expect.objectContaining({ feature: "stereo", warned: false }));
  });

  it("fails closed when graph evidence is missing, even with a bond-order warning", async () => {
    const [a, b] = orderPair(await describeStructure("CCCOC"));
    delete b.molecules[0].species;
    const result = compare(a, b, [orderWarning()]);
    expect(result.verdict).toBe("ERROR");
    expect(result.undetermined).toContainEqual(expect.objectContaining({ feature: "connectivity" }));
    expect(result.differences).toEqual([]);
  });

  it("ignores a changed connectivity key when canonical identity is equal", async () => {
    const m = { ...await describeStructure("CCCOC"), objectId: "m1" };
    const b = { ...structuredClone(m), connectivity: "changed without bond-order evidence" };
    const result = compare(summary([m]), summary([b]), [orderWarning("m1")]);
    expect(result.verdict).toBe("PASS");
    expect(result.differences).toEqual([]);
  });

  it("checks per-atom H counts even when total H and the heavy skeleton agree", async () => {
    const [a, b] = orderPair(await describeStructure("CCCOC"));
    const atoms = b.molecules[0].species!.graph!.atoms;
    [atoms[0].h, atoms[1].h] = [atoms[1].h, atoms[0].h];
    expect(compare(a, b, [orderWarning()]).verdict).toBe("FAIL");
    expect(compareSigma(a.molecules[0], b.molecules[0])?.status).toBe("different");
  });

  it("uses one atom mapping for all protected features and bounds unresolved automorphisms", async () => {
    const m = await describeStructure("C.C.C.C.C.C.C.C.C.C");
    const a = structuredClone(m), b = structuredClone(m);
    a.species!.graph!.atoms[0].isotope = b.species!.graph!.atoms[0].isotope = 13;
    a.species!.graph!.atoms[0].charge = b.species!.graph!.atoms[1].charge = 1;
    expect(compareSigma(a, b, new Set(), 1)?.status).toBe("undetermined");
    expect(compareSigma(a, b)?.status).toBe("undetermined");
    a.objectId = b.objectId = "m1";
    const result = compare(summary([a]), summary([b]), [orderWarning("m1")]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences.filter(d => d.feature === "connectivity")).toEqual([]);
    expect(result.differences).toContainEqual(expect.objectContaining({ feature: "charge", warned: false }));
    const smallA = await describeStructure("CC"), smallB = structuredClone(smallA);
    smallA.species!.graph!.atoms[0].isotope = smallB.species!.graph!.atoms[0].isotope = 13;
    smallA.species!.graph!.atoms[0].charge = smallB.species!.graph!.atoms[1].charge = 1;
    const mapped = compareSigma(smallA, smallB);
    expect(mapped?.status).toBe("isomorphic");
    expect(Object.keys(mapped!.changes!)).toHaveLength(1);
  });

  it("retains sigma evidence for non-strict summaries", async () => {
    const strict = await describeStructure("C[N+](C)=CC=CC=CN(C)CC");
    const m = await describeStructure(strict.smiles, "aromaticity");
    expect(m.species).toBeUndefined();
    expect(m.featureBonds).toHaveLength(m.bonds);
    const a = summary([{ ...structuredClone(m), objectId: "m1" }]), b = structuredClone(a);
    a.molecules[0].featureBonds![0].order = 1.5;
    a.molecules[0].connectivity += " (synthetic Order=1.5)";
    a.molecules[0].smiles += " (synthetic Order=1.5)";
    expect(compare(a, b, [orderWarning("m1")]).verdict).toBe("WARNED");
  });

  it("isolates a warned bond-order change from charge, stereo and strictness", async () => {
    const m = { ...await describeStructure("C[NH2+]CC"), objectId: "m1" };
    m.displays.wedge = 1;
    const [before, after] = orderPair(m);
    for (const key of ["charge", "isotope", "radical", "stereo"] as const) after.molecules[0].featureKeys[key] += "-bond-order";
    const w = orderWarning();
    expect(compare(before, after, []).differences.map(d => d.feature)).toEqual(["bond-order"]);
    expect(compare(before, after, [w]).verdict).toBe("WARNED");
    expect(compare(before, after, [{ ...w, objectId: "other" }]).verdict).toBe("FAIL");
    after.molecules[0].displays.wedge = 0;
    expect(compare(before, after, [w]).differences).toContainEqual(expect.objectContaining({ feature: "stereo-display", warned: false }));
    expect(compare(before, after, [w]).verdict).toBe("FAIL");
  });

  it("checks net charge independently when atoms and hydrogens are unchanged", async () => {
    const before = summary([await describeStructure("CN")]);
    const after = structuredClone(before);
    after.molecules[0].charge++;
    expect(compare(before, after, []).differences.map(d => d.feature)).toEqual(["charge"]);
    expect(compare(before, after, []).verdict).toBe("FAIL");
  });

  it("fails when two molecules lose charge but only one object has a warning", async () => {
    const charged = await describeStructure("[NH4+]");
    const neutral = await describeStructure("N");
    const before = summary([ { ...charged, objectId: "m1" }, { ...charged, objectId: "m2" } ]);
    const after = summary([ { ...neutral, objectId: "m1" }, { ...neutral, objectId: "m2" } ]);
    // Isolate charge: the real summaries also measure the accompanying hydrogen change.
    after.molecules.forEach((m, i) => {
      m.connectivity = before.molecules[i].connectivity; m.hydrogenCount = charged.hydrogenCount;
      m.featureAtoms![0].h = charged.featureAtoms![0].h;
      m.species!.graph!.atoms[0].h = charged.species!.graph!.atoms[0].h;
    });
    const loss = (objectId?: string) => warning({ code: "cdxml.charge_loss", message: "Charge was lost.", objectId });
    expect(compare(before, after, [loss("m1")]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss(), loss()]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss("m1"), loss("m1")]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss("m1"), loss("m2")]).verdict).toBe("WARNED");
  }, 30000);

  it("excuses a single changed molecule only with its own or an unscoped warning", async () => {
    const m = await describeStructure("CO");
    const before = summary([{ ...m, objectId: "m1" }, { ...m, objectId: "m2" }]);
    const after = structuredClone(before);
    after.molecules[0].charge = 1;
    const loss = (objectId?: string) => warning({ code: "cdxml.charge_loss", message: "Charge was lost.", objectId });
    expect(compare(before, after, [loss("m2")]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss("m1")]).verdict).toBe("WARNED");
    expect(compare(before, after, [loss()]).verdict).toBe("WARNED");
  }, 30000);

  it("requires two warnings when charge moves between two molecules", async () => {
    const m = await describeStructure("CO");
    const before = summary([{ ...m, objectId: "m1", charge: 1, featureKeys: { ...m.featureKeys, charge: "charged-first" } }, { ...m, objectId: "m2" }]);
    const after = structuredClone(before);
    after.molecules[0].charge = 0;
    after.molecules[0].featureKeys.charge = m.featureKeys.charge;
    after.molecules[1].charge = 1;
    after.molecules[1].featureKeys.charge = "charged-second";
    const loss = (objectId?: string) => warning({ code: "cdxml.charge_loss", message: "Charge changed.", objectId });
    expect(compare(before, after, [loss()]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss("m1")]).verdict).toBe("FAIL");
    expect(compare(before, after, [loss("m1"), loss("m2")]).verdict).toBe("WARNED");
  }, 30000);
  it("detects positional isotope and charge changes even with unchanged totals", async () => {
    const isotopeBefore = summary([await describeStructure("[13CH3]CCO")]);
    const isotopeAfter = summary([await describeStructure("CC[13CH2]O")]);
    expect(compare(isotopeBefore, isotopeAfter, []).differences.map(d => d.feature)).toContain("isotope");
    expect(compare(isotopeBefore, isotopeAfter, [warning({ code: "cdxml.isotope_loss", message: "Isotopes were lost." })]).verdict).toBe("WARNED");
    const charged = summary([await describeStructure("[NH3+]CC(N)O")]);
    const relocated = summary([await describeStructure("NCC([NH3+])O")]);
    expect(charged.molecules[0].charge).toBe(relocated.molecules[0].charge);
    expect(compare(charged, relocated, []).differences.map(d => d.feature)).toContain("charge");
    expect(compare(charged, relocated, []).verdict).toBe("FAIL");
    const radical = await describeStructure("[CH3]");
    expect(radical.radicals).toEqual([{ atom: 0, electrons: 1 }]);
  }, 30000);

  it("a warning about charge cannot hide an additional stereo inversion", async () => {
    const before = summary([await describeStructure("[NH3+]C[C@H](O)C(=O)O")]);
    const after = summary([await describeStructure("NC[C@@H](O)C(=O)O")]);
    const result = compare(before, after, [warning({ code: "cdxml.charge_loss", message: "Formal charge was not preserved." })]);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences.some(d => d.feature === "stereo" && !d.warned)).toBe(true);
  }, 30000);
});

describe("synthetic format features", () => {
  const nativeCase = (elements: string[], edges: [number, number, string?, string?][]) => MoleculeObjectSchema.parse({
    id: "synthetic", type: "molecule", x: 0, y: 0, width: 100, height: 100, structureFormat: "smiles", structure: "",
    atoms: elements.map((element, i) => ({ id: `a${i}`, element, x: Math.cos(i) * 30, y: Math.sin(i) * 30, ...(["ProtectingGroup", "R1", "R2", "*"].includes(element) ? { labelLiteral: true } : {}) })),
    bonds: edges.map(([a, b, order = "single", style], i) => ({ id: `b${i}`, fromAtomId: `a${a}`, toAtomId: `a${b}`, order, ...(style ? { display: { bondStyle: style } } : {}) }))
  });

  it.each([false, true])("shares WASM log captures across module wrappers (wrapper first: %s)", async wrapperFirst => {
    installNodeRdkitModuleLoader();
    const real = await ensureRdkit();
    const wrapper = Object.create(real) as RdkitMinimalModule;
    const contexts = (wrapperFirst ? [wrapper, real] : [real, wrapper]).map(module => new SummaryContext(async () => module));
    const rejected = await describeStructure("C(C)(C)(C)(C)C", undefined, contexts[0]);
    expect(rejected).toMatchObject({ strict: false, sanitization: { reason: "valence:C", message: expect.stringMatching(/valence/i) } });
    const accepted = await describeStructure("O", undefined, contexts[1]);
    expect(accepted).toMatchObject({ strict: true, smiles: "O" });
    expect(accepted.sanitization).toBeUndefined();
    const anotherWrapper = new SummaryContext(async () => Object.create(real) as RdkitMinimalModule);
    const ring = await describeStructure("c1cccc1", undefined, anotherWrapper);
    expect(ring).toMatchObject({ strict: false, sanitization: { reason: "kekulize", message: expect.stringMatching(/kekulize/i) } });
    expect(ring.sanitization?.message).not.toMatch(/valence/i);
  });

  it("summarises 200 molecules quickly, reuses only matching graph hashes, and frees every handle", async () => {
    // Capture the real memory export: this MinimalLib does not expose HEAPU8.
    let memory: WebAssembly.Memory | undefined;
    const instantiate = WebAssembly.instantiate;
    const spy = vi.spyOn(WebAssembly, "instantiate").mockImplementation((async (...args: [BufferSource | WebAssembly.Module, WebAssembly.Imports?]) => {
      const result = await Reflect.apply(instantiate, WebAssembly, args) as WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance;
      const instance = result instanceof WebAssembly.Instance ? result : result.instance;
      memory = Object.values(instance.exports).find(value => value instanceof WebAssembly.Memory) as WebAssembly.Memory | undefined;
      return result;
    }) as typeof WebAssembly.instantiate);
    let real: RdkitMinimalModule;
    try { installNodeRdkitModuleLoader(); real = await ensureRdkit(); }
    finally { spy.mockRestore(); }
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    let live = 0, created = 0, stereoCalls = 0;
    const module = Object.create(real) as RdkitMinimalModule;
    module.get_mol = (structure, options) => {
      const handle = real.get_mol(structure, options);
      if (!handle) return null;
      live++; created++;
      let deleted = false;
      return new Proxy(handle, { get(target, key) {
        if (key === "delete") return () => {
          expect(deleted).toBe(false);
          deleted = true;
          live--;
          target.delete();
        };
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          expect(deleted).toBe(false);
          if (key === "get_stereo_tags") stereoCalls++;
          return value.apply(target, args);
        };
      } });
    };
    const document = createEmptyDocument();
    document.pages[0].objects = Array.from({ length: 200 }, (_, index) => {
      const molecule = nativeCase(["C", "O"], [[0, 1]]);
      molecule.id = `copy-${index}`;
      const ids = new Map(molecule.atoms.map(atom => [atom.id, `${index}-${atom.id}`]));
      molecule.atoms.forEach(atom => { atom.id = ids.get(atom.id)!; });
      molecule.bonds.forEach(bond => { bond.id = `${index}-${bond.id}`; bond.fromAtomId = ids.get(bond.fromAtomId)!; bond.toAtomId = ids.get(bond.toAtomId)!; });
      return molecule;
    });
    const context = new SummaryContext(async () => module);
    const started = performance.now();
    const first = await describeDocument(document, [], context);
    expect(first.molecules).toHaveLength(200);
    expect(first.summaryErrors).toEqual([]);
    expect(new Set(first.molecules.map(m => m.objectId)).size).toBe(200);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(live).toBe(0);
    expect(created).toBe(2); // native molecule and feature-stripped identity; resonance evidence is plain data
    expect(stereoCalls).toBe(1);
    const unchanged = deserializeDocument(serializeDocument(document));
    await describeDocument(unchanged, [], context);
    expect(created).toBe(2);
    const edited = unchanged.pages[0].objects[0];
    if (edited.type !== "molecule") throw new Error("Expected molecule");
    const oldHash = nativeGraphHash(edited);
    edited.atoms[1].formalCharge = -1;
    expect(nativeGraphHash(edited)).not.toBe(oldHash);
    const changed = await describeDocument(unchanged, [], context);
    expect(changed.molecules[0].charge).toBe(-1);
    expect(changed.molecules[1].charge).toBe(0);
    expect(created).toBeGreaterThan(4);
    // New contexts force fresh work, so handle/heap checks cannot pass just from caching.
    await describeDocument(document, [], new SummaryContext(async () => module));
    const warmedHeap = memory!.buffer.byteLength;
    for (let run = 0; run < 10; run++) {
      const result = await describeDocument(document, [], new SummaryContext(async () => module));
      expect(result.summaryErrors).toEqual([]);
      expect(live).toBe(0);
    }
    expect(memory!.buffer.byteLength).toBe(warmedHeap);
  }, 30000);

  it.each([37, Object.defineProperty({ detail: "bad synthetic graph" }, "reason", { value: "native parse failure" })])("decodes RDKit non-Error throws (%s)", async thrown => {
    await describeStructure("C");
    const real = await ensureRdkit();
    const injected = Object.create(real) as RdkitMinimalModule & { getExceptionMessage: (value: unknown) => [string, string] };
    injected.get_mol = () => { throw thrown; };
    injected.getExceptionMessage = () => ["RDKit", "synthetic native exception"];
    const context = new SummaryContext(async () => injected);
    const document = createEmptyDocument();
    document.pages[0].objects = [nativeCase(["C"], [])];
    const result = await describeDocument(document, [], context);
    expect(result.summaryErrors?.[0].summaryError).toMatchObject({
      stage: "summary", code: "RdkitException", category: typeof thrown === "number" ? "rdkit.exception_number" : "rdkit.exception_object",
      message: "RDKit: synthetic native exception"
    });
    const fallback = stageError("summary", rdkitError(thrown));
    expect(fallback.message).toBe(typeof thrown === "number" ? "37" : '{"detail":"bad synthetic graph","reason":"native parse failure"}');
    expect(fallback.message).not.toContain("[object Object]");
  });

  it("retries an OOB molecule in a fresh instance, deletes its handle, and continues", async () => {
    await describeStructure("C");
    const real = await ensureRdkit();
    let loads = 0, restarts = 0, deletes = 0;
    const poisoned = Object.create(real) as RdkitMinimalModule;
    poisoned.get_mol = () => ({ get_json: () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); }, get_smiles: () => "C", get_stereo_tags: () => "{}", delete: () => { deletes++; } } as unknown as RdkitJsMol);
    const context = new SummaryContext(async () => ++loads === 1 ? poisoned : real, () => { restarts++; });
    const document = createEmptyDocument();
    const bad = nativeCase(["C"], []), good = nativeCase(["O"], []);
    bad.id = "bad"; good.id = "good";
    document.pages[0].objects = [bad, good];
    const result = await describeDocument(document, [], context);
    expect(result.summaryErrors).toEqual([]);
    expect(result.molecules.map(m => [m.objectId, m.smiles])).toEqual([["bad", "C"], ["good", "O"]]);
    expect(result.molecules[0].recovery).toBe("fresh-molfile");
    expect(compare(summary([await describeStructure("C")]), summary([result.molecules[0]]), []).verdict).toBe("PASS");
    expect({ loads, restarts, deletes }).toEqual({ loads: 2, restarts: 1, deletes: 1 });
  });

  it("replaces the default WASM singleton after an injected parser OOB", async () => {
    await describeStructure("C");
    const poisoned = await ensureRdkit();
    const spy = vi.spyOn(poisoned, "get_mol").mockImplementationOnce(() => { throw new WebAssembly.RuntimeError("memory access out of bounds"); });
    const document = createEmptyDocument();
    const bad = nativeCase(["C"], []), good = nativeCase(["N"], []);
    bad.id = "bad"; good.id = "good";
    document.pages[0].objects = [bad, good];
    try {
      const result = await describeDocument(document, []);
      expect(result.summaryErrors).toEqual([]);
      expect(result.molecules.map(m => m.smiles)).toEqual(["C", "N"]);
      expect(result.molecules[0].recovery).toBe("fresh-molfile");
      expect(await ensureRdkit()).not.toBe(poisoned);
    } finally { spy.mockRestore(); }
  });

  it("retries with sanitize false after a fresh strict rejection, without extra RDKit calls", async () => {
    await describeStructure("C");
    const real = await ensureRdkit();
    const poisoned = Object.create(real) as RdkitMinimalModule;
    poisoned.get_mol = () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); };
    const fresh = Object.create(real) as RdkitMinimalModule;
    const inputs: { structure: string; options: Record<string, unknown> }[] = [];
    fresh.get_mol = (structure, options) => {
      const parsed = JSON.parse(options ?? "{}");
      inputs.push({ structure, options: parsed });
      if (parsed.sanitize !== false) return null;
      const mol = real.get_mol(structure, options)!;
      return new Proxy(mol, { get(target, key) {
        if (!["get_json", "get_smiles", "delete"].includes(String(key))) throw new Error(`Unexpected recovery call: ${String(key)}`);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    let loads = 0;
    const context = new SummaryContext(async () => ++loads === 1 ? poisoned : fresh, () => {});
    const document = createEmptyDocument();
    document.pages[0].objects = [nativeCase(["C", "O"], [[0, 1]])];
    const result = await describeDocument(document, [], context);
    expect(result.summaryErrors).toEqual([]);
    expect(result.molecules[0]).toMatchObject({ smiles: "CO", strict: false, recovery: "fresh-molfile-unsanitized" });
    expect(inputs.map(i => i.options.sanitize)).toEqual([true, false]);
    expect(inputs.every(i => i.structure.includes("V3000"))).toBe(true);
    expect(loads).toBe(2);
  });

  it("bounds retries and retains OOB errors when every fresh attempt fails", async () => {
    await describeStructure("C");
    const real = await ensureRdkit();
    let loads = 0;
    const context = new SummaryContext(async () => {
      loads++;
      const poisoned = Object.create(real) as RdkitMinimalModule;
      poisoned.get_mol = () => { throw new WebAssembly.RuntimeError("memory access out of bounds"); };
      return poisoned;
    }, () => {});
    await expect(describeStructure("C", undefined, context)).rejects.toMatchObject({ category: "rdkit.wasm_oob" });
    expect(loads).toBe(3);
  });

  it("caches an unsuccessful graph once and frees handles even when capabilities are missing", async () => {
    await describeStructure("C");
    const real = await ensureRdkit();
    let created = 0, deleted = 0;
    const module = Object.create(real) as RdkitMinimalModule;
    module.get_mol = () => { created++; return { delete: () => { deleted++; } } as RdkitJsMol; };
    const document = createEmptyDocument();
    const first = nativeCase(["C"], []), second = structuredClone(first);
    first.id = "first"; second.id = "second";
    document.pages[0].objects = [first, second];
    const context = new SummaryContext(async () => module);
    const result = await describeDocument(document, [], context);
    expect(result.molecules).toEqual([]);
    expect(result.summaryErrors?.map(e => [e.objectId, e.summaryError.category])).toEqual([["first", "summary.rdkit_capability"], ["second", "summary.rdkit_capability"]]);
    expect({ created, deleted }).toEqual({ created: 1, deleted: 1 });
  });
  it.each([
    ["over-valent carbon", "valence:C", nativeCase(["C", "F", "F", "F", "F", "F"], [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]])],
    ["unkekulisable ring", "kekulize", nativeCase(["C", "C", "C", "C", "C"], [[0, 1, "aromatic"], [1, 2, "aromatic"], [2, 3, "aromatic"], [3, 4, "aromatic"], [4, 0, "aromatic"]])],
    ["metal coordination", "dative", nativeCase(["N", "Cu"], [[0, 1, "single", "dashed"]])],
    ["unexpanded abbreviation", "abbreviation", nativeCase(["C", "ProtectingGroup"], [[0, 1]])],
    ["R-group", "r-group", nativeCase(["C", "R1"], [[0, 1]])],
    ["generic atom", "generic", nativeCase(["C", "*"], [[0, 1]])],
    ["query bond", "query-bond", nativeCase(["C", "C"], [[0, 1, "unknown"]])]
  ])("compares %s through unsanitized summaries and detects a dropped atom", async (_label, reason, molecule) => {
    const document = createEmptyDocument();
    document.pages[0].objects = [molecule];
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    const described = before.molecules[0];
    expect(described).toMatchObject({ strict: false, sanitization: { reason }, atomCount: molecule.atoms.length, bonds: molecule.bonds.length });
    if (reason === "valence:C" || reason === "kekulize") {
      expect(described.sanitization).toMatchObject({ rdkitReason: reason, message: expect.stringMatching(/valence|kekulize/i) });
    }
    if (["abbreviation", "r-group", "generic"].includes(reason)) {
      expect(described.dummyAtoms).toEqual([{ kind: reason, label: molecule.atoms[1].element, count: 1 }]);
      expect(described.smiles).toContain("*");
    }
    const unchanged = deserializeDocument(serializeDocument(document));
    expect(compare(before, await describeDocument(unchanged, []), []).verdict).toBe("PASS");
    for (const format of ["cdx", "cdxml"] as const) {
      const exported = await interchange(document, format);
      const reopened = await open(exported.bytes);
      const after = await describeDocument(reopened.document!, []);
      expect(after.summaryErrors).toEqual([]);
      // Query bonds are preserved per bond by the compatibility fix; labels also survive both formats.
      expect(compare(before, after, []).verdict, JSON.stringify({ format, differences: compare(before, after, []).differences })).toBe("PASS");
      const edited = reopened.document!.pages[0].objects[0];
      if (edited.type !== "molecule") throw new Error("Expected synthetic molecule");
      const removed = edited.atoms.pop()!;
      edited.bonds = edited.bonds.filter(b => b.fromAtomId !== removed.id && b.toAtomId !== removed.id);
      expect(compare(before, await describeDocument(reopened.document!, []), []).verdict).toBe("FAIL");
    }
  }, 30000);

  it("classifies RDKit diagnostics without exposing indices or structure text", async () => {
    expect(rdkitReason("Explicit valence for atom # 92 N, 5, is greater than permitted")).toBe("valence:N");
    expect(rdkitReason("non-ring atom 3 marked aromatic")).toBe("aromaticity");
    expect(rdkitReason("RingInfo not initialized")).toBe("ring-info");
    expect(rdkitReason("SMILES Parse Error: secret structure")).toBe("parse");
    expect(rdkitReason("secret unknown error")).toBe("other");
    const before = summary([await describeStructure("C(C)(C)(C)(C)C")]);
    const after = structuredClone(before);
    after.molecules[0].strict = true;
    expect(compare(before, after, [])).toMatchObject({ verdict: "FAIL", differences: [expect.objectContaining({ feature: "sanitization-changed", warned: false })] });
  }, 30000);

  it.each([0, 1, -1])("keeps dummy labels attached to their graph positions with charge %s", async (charge) => {
    const document = createEmptyDocument();
    const molecule = nativeCase(["R1", "C", "O", "R2"], [[0, 1], [1, 2], [2, 3]]);
    molecule.atoms[0].formalCharge = charge;
    molecule.atoms[3].formalCharge = charge;
    document.pages[0].objects = [molecule];
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    expect(before.molecules[0].charge).toBe(2 * charge);
    expect(before.molecules[0].smiles.match(/:\d+\]/g)).toHaveLength(2);
    [molecule.atoms[0].element, molecule.atoms[3].element] = [molecule.atoms[3].element, molecule.atoms[0].element];
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
    molecule.atoms.reverse();
    const reordered = await describeDocument(document, []);
    molecule.atoms.reverse();
    expect(compare(reordered, await describeDocument(document, []), []).verdict).toBe("PASS");
  }, 30000);

  it("preserves both a charged abbreviation's charge and its mapped label identity", async () => {
    const document = createEmptyDocument();
    const molecule = nativeCase(["C", "ProtectingGroup"], [[0, 1]]);
    molecule.atoms[1].formalCharge = 1;
    document.pages[0].objects = [molecule];
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    expect(before.molecules[0]).toMatchObject({ charge: 1, isotopes: [], dummyAtoms: [{ kind: "abbreviation", label: "ProtectingGroup", count: 1 }] });
    expect(before.molecules[0].smiles).toMatch(/\[\*\+:\d+\]/);
    molecule.atoms[1].element = "OtherProtectingGroup";
    const relabelled = await describeDocument(document, []);
    expect(relabelled.summaryErrors).toEqual([]);
    expect(relabelled.molecules[0].charge).toBe(1);
    expect(relabelled.molecules[0].smiles).not.toBe(before.molecules[0].smiles);
    expect(compare(before, relabelled, []).verdict).toBe("FAIL");
    molecule.atoms[1].element = "ProtectingGroup";
    molecule.atoms[1].formalCharge = 0;
    const neutral = await describeDocument(document, []);
    expect(neutral.molecules[0].smiles.match(/:\d+\]/g)).toEqual(before.molecules[0].smiles.match(/:\d+\]/g));
    expect(compare(before, neutral, []).verdict).toBe("FAIL");
  }, 30000);

  it("preserves radical counts beyond the MDL transport limit in an unsanitized summary", async () => {
    const document = createEmptyDocument();
    const molecule = nativeCase(["C"], []);
    molecule.atoms[0].markRadicals = 3;
    molecule.atoms[0].isotope = 13;
    document.pages[0].objects = [molecule];
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    expect(before.molecules[0]).toMatchObject({ strict: false, sanitization: { reason: "other" }, radicals: [{ atom: 0, electrons: 3 }], isotopes: [{ atom: 0, mass: 13 }], formula: "[13C]H" });
    expect(compare(before, await describeDocument(deserializeDocument(serializeDocument(document)), []), []).verdict).toBe("PASS");
    molecule.atoms[0].markRadicals = 2;
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
  }, 30000);

  it("detects strictness swapping between distinguishable molecules even with equal totals", async () => {
    const a = await describeStructure("C"), b = await describeStructure("N");
    const before = summary([{ ...a, strict: false }, b]);
    const after = summary([a, { ...b, strict: false }]);
    expect(compare(before, after, []).differences).toContainEqual(expect.objectContaining({ feature: "sanitization-changed", warned: false }));
    expect(compare(before, summary([b, { ...a, strict: false }]), []).verdict).toBe("PASS");
  }, 30000);

  it("summarises graph-only external CDXML despite structure-string and aromatic warnings", async () => {
    const bytes = await readFile(new URL("./fixtures/external-graph.cdxml", import.meta.url));
    const source = await open(bytes);
    expect(source.warnings.map(w => w.category)).toEqual(expect.arrayContaining([
      "cdxml.structure_string_not_derived", "cdxml.external_subset_imported", "cdxml.aromatic_bond_import_approximation"
    ]));
    const molecules = source.document!.pages.flatMap(p => p.objects).filter(o => o.type === "molecule");
    expect(molecules).toHaveLength(2);
    expect(molecules.every(m => !m.structure)).toBe(true);
    // A deliberately wrong stored string must not affect native-graph summaries.
    molecules.forEach(m => { m.structureFormat = "smiles"; m.structure = "N"; });
    const described = await describeDocument(source.document!, []);
    expect(described.summaryErrors).toEqual([]);
    expect(described.molecules.map(m => m.smiles).sort()).toEqual(["CO", "c1ccccc1"]);
  }, 30000);

  it("retains the other molecules and drawing when one native graph cannot be summarised", async () => {
    const document = createEmptyDocument();
    const base = { type: "molecule", x: 0, y: 0, width: 100, height: 30, structureFormat: "smiles", structure: "CO" };
    document.pages[0].objects = [
      MoleculeObjectSchema.parse({ ...base, id: "before", atoms: [{ id: "a", element: "O", x: 0, y: 0 }] }),
      MoleculeObjectSchema.parse({ ...base, id: "bad", atoms: [{ id: "b", element: "C", x: 0, y: 0 }, { id: "b2", element: "O", x: 30, y: 0 }], bonds: [{ id: "duplicate1", fromAtomId: "b", toAtomId: "b2", order: "single" }, { id: "duplicate2", fromAtomId: "b", toAtomId: "b2", order: "single" }] }),
      MoleculeObjectSchema.parse({ ...base, id: "after", atoms: [{ id: "c", element: "N", x: 0, y: 0 }] })
    ];
    const described = await describeDocument(document, []);
    expect(described.molecules.map(m => m.objectId)).toEqual(["before", "after"]);
    expect(described.summaryErrors).toEqual([{ objectId: "bad", summaryError: expect.objectContaining({ stage: "summary", code: "Error", category: "summary.rdkit_rejected", message: expect.stringContaining("RDKit rejected") }) }]);
    expect(described.drawing.pages).toBe(1);
  }, 30000);

  it.each([
    ["isotope", molecule([[6, 20, 30, 'Isotope="13"'], [8, 40, 30]], [[0, 1]])],
    ["radical", molecule([[6, 20, 30, 'Radical="Doublet"']], [])],
    ["charge", molecule([[7, 20, 30, 'Charge="1"'], [6, 40, 30], [6, 20, 10], [6, 0, 30], [6, 20, 50]], [[0, 1], [0, 2], [0, 3], [0, 4]])],
    ["stereo", molecule([[6, 20, 30], [6, 40, 30], [8, 40, 10], [6, 60, 30], [8, 70, 10], [8, 70, 50]], [[0, 1], [1, 2, "1", "WedgeBegin"], [1, 3], [3, 4, "2"], [3, 5]])],
    ["alkene", molecule([[6, 20, 10], [6, 40, 30], [6, 60, 30], [6, 80, 50]], [[0, 1], [1, 2, "2"], [2, 3]])],
    ["wavy", molecule([[6, 20, 10], [6, 40, 30]], [[0, 1, "1", "Wavy"]])]
  ])("summarises and visibly round-trips %s without silent losses", async (_feature, content) => {
    const source = await open(Buffer.from(wrap(content)));
    expect(source.document).toBeDefined();
    const original = await describeDocument(source.document!, []);
    if (_feature === "isotope") expect(original.molecules[0].isotopes).toEqual([{ atom: 0, mass: 13 }]);
    if (_feature === "stereo") expect(original.molecules[0].tetrahedral).toHaveLength(1);
    if (_feature === "alkene") expect(original.molecules[0].doubleBonds[0].stereo).toBe("E");
    if (_feature === "wavy") expect(original.molecules[0].displays.wavy).toBe(1);
    for (const format of ["cdx", "cdxml"] as const) {
      const exported = await interchange(source.document!, format);
      const reopened = await open(exported.bytes);
      expect(reopened.document).toBeDefined();
      const result = compare(original, await describeDocument(reopened.document!, []), [...exported.warnings, ...reopened.warnings]);
      expect(result.verdict, JSON.stringify(result.differences)).toBe("PASS");
      if (_feature === "wavy") expect((await describeDocument(reopened.document!, [])).molecules[0].displays.wavy).toBe(1);
    }
  }, 30000);

  it("fails when a wavy single bond display is removed after reopening", async () => {
    const source = await open(Buffer.from(wrap(molecule([[6, 20, 10], [6, 40, 30]], [[0, 1, "1", "Wavy"]]))));
    const before = await describeDocument(source.document!, []);
    const exported = await interchange(source.document!, "cdxml");
    const reopened = await open(exported.bytes);
    const reopenedMolecule = reopened.document!.pages[0].objects.find(o => o.type === "molecule");
    if (reopenedMolecule?.type !== "molecule") throw new Error("Expected synthetic molecule");
    const bond = reopenedMolecule.bonds.find(candidate => candidate.display?.bondStyle === "wavy");
    if (!bond) throw new Error("Expected wavy single bond to survive CDXML round trip");
    bond.display = undefined;
    const after = await describeDocument(reopened.document!, []);
    expect(after.molecules[0].displays.wavy).toBe(0);
    expect(compare(before, after, []).differences).toContainEqual(expect.objectContaining({ feature: "stereo-display", warned: false }));
    expect(compare(before, after, []).verdict).toBe("FAIL");
  }, 30000);

  it("preserves native either intent across visible export and detects a later loss", async () => {
    const source = await open(Buffer.from(wrap(molecule([[6, 20, 10], [6, 40, 30], [6, 60, 30], [6, 80, 50]], [[0, 1], [1, 2, "2"], [2, 3]]))));
    const drawn = source.document!.pages[0].objects.find(o => o.type === "molecule")!;
    if (drawn.type !== "molecule") throw new Error("Synthetic molecule missing.");
    drawn.bonds[1].stereo = "either";
    const before = await describeDocument(source.document!, []);
    expect(before.molecules[0].doubleBonds[0].stereo).toBe("either");
    expect(before.molecules[0].displays.either).toBe(1);
    for (const format of ["cdx", "cdxml"] as const) {
      const exported = await interchange(source.document!, format), reopened = await open(exported.bytes);
      const after = await describeDocument(reopened.document!, []);
      expect(compare(before, after, []).verdict).toBe("PASS");
      const reopenedMolecule = reopened.document!.pages[0].objects.find(o => o.type === "molecule");
      if (reopenedMolecule?.type !== "molecule") throw new Error("Expected synthetic molecule");
      const eitherBond = reopenedMolecule.bonds.find(bond => bond.stereo === "either");
      if (!eitherBond) throw new Error("Expected either bond to survive visible export");
      eitherBond.stereo = undefined;
      expect(compare(before, await describeDocument(reopened.document!, []), []).verdict).toBe("FAIL");
    }
  }, 30000);

  it("counts rich text, bracket labels, reaction roles, graphics, colours and pages", async () => {
    const document = createEmptyDocument();
    const base = { x: 0, y: 0, width: 100, height: 30 };
    document.pages[0].objects = [
      TextObjectSchema.parse({ ...base, id: "text", type: "text", text: "synthetic", style: { fontFamily: "Arial" }, spans: [
        { text: "a", style: { fontWeight: 700, fontStyle: "italic", fontFamily: "Serif" }, script: "subscript" },
        { text: "b", script: "superscript" }
      ] }),
      BracketObjectSchema.parse({ ...base, id: "bracket", type: "bracket", bracketKind: "polymer", label: "n" }),
      GraphicObjectSchema.parse({ ...base, id: "arrow", type: "graphic", graphicKind: "line", style: { strokeColor: "#ff0000" }, data: { artToolId: "equilibriumArrow" } }),
      GraphicObjectSchema.parse({ ...base, id: "box", type: "graphic", graphicKind: "rect", style: { strokeColor: "#0000ff" } }),
      ...["m1", "m2", "m3"].map((id, i) => MoleculeObjectSchema.parse({ ...base, id, type: "molecule", structureFormat: "molfile-v2000", structure: "", atoms: [{ id: `${id}-a`, element: ["C", "O", "N"][i], x: 0, y: 0 }] })),
      ReactionObjectSchema.parse({ ...base, id: "reaction", type: "reaction", components: [{ role: "reactant", objectId: "m1" }, { role: "product", objectId: "m2" }, { role: "agent", objectId: "m3" }] })
    ];
    document.pages.push({ ...document.pages[0], id: "second", objects: [] });
    const described = await describeDocument(document, []);
    expect(described.drawing.pages).toBe(2);
    expect(described.drawing["text-styling"]).toMatchObject({ objects: 1, styled: 1, bold: 1, italic: 1, subscript: 1, superscript: 1, fontChanges: 1 });
    expect(described.drawing.brackets).toEqual([{ kind: "polymer", repeatUnitLabel: "n" }]);
    expect(described.drawing.colours).toEqual(["#0000ff", "#ff0000"]);
    expect(described.drawing["other-graphics"]).toEqual(["graphic.rect"]);
    expect(described.reactions).toEqual([{ objectId: "reaction", reactants: ["C"], products: ["O"], agents: ["N"], conditions: [], arrowKinds: ["equilibrium"] }]);
  });

  it("fails swapped reactant and product identities and equal-count component replacements; passes reordered components", async () => {
    const document = createEmptyDocument();
    const base = { x: 0, y: 0, width: 100, height: 30 };
    document.pages[0].objects = [
      ...["C", "O", "N", "F"].map((element, i) => MoleculeObjectSchema.parse({ ...base, id: `m${i}`, type: "molecule", structureFormat: "molfile-v2000", structure: "", atoms: [{ id: `a${i}`, element, x: 0, y: 0 }] })),
      ReactionObjectSchema.parse({ ...base, id: "r", type: "reaction", components: [{ role: "reactant", objectId: "m0" }, { role: "reactant", objectId: "m0" }, { role: "reactant", objectId: "m1" }, { role: "product", objectId: "m2" }, { role: "agent", objectId: "m3" }] })
    ];
    const before = await describeDocument(document, []);
    const reaction = document.pages[0].objects.find(o => o.type === "reaction")!;
    if (reaction.type !== "reaction") throw new Error("Synthetic reaction missing.");
    reaction.components.reverse();
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("PASS");
    const reactant = reaction.components.find(c => c.role === "reactant")!;
    const product = reaction.components.find(c => c.role === "product")!;
    [reactant.objectId, product.objectId] = [product.objectId, reactant.objectId];
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
    [reactant.objectId, product.objectId] = [product.objectId, reactant.objectId];
    product.objectId = "m3";
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
    product.objectId = "m2";
    reaction.components.splice(reaction.components.findIndex(c => c.role === "reactant"), 1);
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
  }, 30000);

  it("expands abbreviation labels and retains R-group labels in molecule summaries", async () => {
    const document = createEmptyDocument();
    const base = { x: 0, y: 0, width: 100, height: 30, type: "molecule", structureFormat: "molfile-v2000", structure: "" };
    document.pages[0].objects = [
      MoleculeObjectSchema.parse({ ...base, id: "abbreviation", atoms: [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "OMe", x: 30, y: 0 }], bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single" }] }),
      MoleculeObjectSchema.parse({ ...base, id: "rgroup", atoms: [{ id: "r", element: "R1", x: 0, y: 0 }] })
    ];
    const described = await describeDocument(document, []);
    expect(described.molecules[0].smiles).toBe("COC");
    expect(described.molecules[0].abbreviations).toEqual([{ label: "OMe", expandedFragment: "CO" }]);
    expect(described.molecules[1].rGroups).toEqual([{ label: "R1", semantics: "unknown" }]);
  }, 30000);
});
