import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fork, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { processCopy } from "./worker";
import { compare, warning, type Result, type Summary, type WorkerProgress } from "./model";
import { child, run, type RunOptions } from "./runner";
import { results, withCopy } from "./io";
import { report, verdict } from "./report";
import { main } from "./cli";
import * as codec from "./codec";
import * as chemistry from "./chemistry";
import { appendOutput, writeOutput, validateDestination } from "./safety";
import { completionLine, stageError } from "./errors";
import { compareSigma } from "./sigma";
import * as sigma from "./sigma";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cdx-harness-test-"));
  directories.push(root);
  const sources = join(root, "sources"), out = join(root, "out");
  await mkdir(sources);
  return { root, sources, out };
}
export const syntheticXml = `<CDXML CreationProgram="ChemDraft"><page id="1" BoundingBox="0 0 612 792"><fragment id="2"><n id="10" Element="6" p="20 30"/><n id="11" Element="8" p="40 30"/><b id="20" B="10" E="11" Order="1"/></fragment></page></CDXML>`;
const defaults = (list: string, out: string): RunOptions => ({ list, out, formats: ["cdx", "cdxml"], timeoutMs: 15000, maxOldSpaceMb: 256, concurrency: 2, batchSize: 2 });
async function collect(out: string) { const rows: Result[] = []; for await (const row of results(out)) rows.push(row); return rows; }
function emptySummary(): Summary { return { molecules: [], reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } }; }
const successful = () => ({ format: "cdxml" as const, size: 1, parseOk: true, status: "ok" as const, warnings: [], roundTrips: [], timings: { totalMs: 0 } });

describe("source-to-native survival reporting", () => {
  it.each(["kept", "partial", "moved", "all"])("reports per-step arrow links and the file verdict when links are %s", async kind => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, `<CDXML><page id="1"><scheme id="90">
      <step id="91" ReactionStepArrows="51 52"/><step id="92" ReactionStepArrows="53"/></scheme>
      <arrow id="51" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      <arrow id="52" Tail3D="0 20 0" Head3D="30 20 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      <arrow id="53" Tail3D="0 40 0" Head3D="30 40 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      </page></CDXML>`);
    await writeFile(list, original);
    const realOpen = codec.open;
    vi.spyOn(codec, "open").mockImplementationOnce(async bytes => {
      const opened = await realOpen(bytes);
      const steps = opened.document!.pages[0].objects.filter(o => o.type === "reaction");
      if (kind === "partial" || kind === "moved") {
        const link = steps[0].arrowObjectIds!.pop()!;
        if (kind === "moved") steps[1].arrowObjectIds!.push(link);
      } else if (kind === "all") steps[0].arrowObjectIds = [];
      return opened;
    });
    const processed = await processCopy(original);
    const expected = kind === "kept" ? "PASS" : "FAIL";
    expect(processed.status, JSON.stringify(processed.errors)).toBe("ok");
    expect(processed.importComparison?.verdict).toBe(expected);
    expect(verdict({ ...processed, id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown" })).toBe(expected);
    await run(defaults(list, out), async () => ({ result: processed }));
    await report(out);
    const publicReport = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    expect(publicReport.survival.afterImport).toMatchObject({
      source: { stepArrows: 3 }, after: { stepArrows: kind === "all" ? 1 : kind === "partial" ? 2 : 3 },
      stepArrowLinksLost: kind === "kept" ? 0 : kind === "all" ? 2 : 1,
      stepsWhoseArrowLinkWasLost: kind === "kept" ? 0 : 1,
      filesLosingAny: kind === "kept" ? 0 : 1
    });
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("import | step arrow links | 3");
    await main(["rescore", "--out", out]);
    expect(verdict((await collect(out))[0])).toBe(expected);
  });

  const arrow = `<scheme id="90"><step id="91" ReactionStepArrows="50" ReactionStepReactants="100" ReactionStepProducts="110"/></scheme>
    <graphic id="50" GraphicType="Line" ArrowType="FullHead" SupersededBy="51" BoundingBox="0 0 30 0"/>
    <arrow id="51" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
    <fragment id="100"><n id="101" Element="6" p="0 0"/></fragment>
    <fragment id="110"><n id="111" Element="8" p="40 0"/></fragment>`;
  const abbreviation = `<fragment id="2"><n id="10" NodeType="Nickname" p="0 0"><t><s>Me</s></t><fragment id="12"><n id="13" Element="6" p="0 0"/></fragment></n></fragment>`;
  const circle = `<graphic id="50" GraphicType="Oval" OvalType="Circle" BoundingBox="0 0 20 20"/>`;
  it.each([
    ["step", arrow, "FAIL"], ["abbreviation", abbreviation, "PASS"],
    ["circle", circle, "DRAWN-DIFFERENTLY"], ["legacy", arrow.replace('ReactionStepArrows="50"', 'ReactionStepArrows="51"'), "PASS"]
  ])("includes initial %s losses in private results, public counts and the file verdict", async (kind, content, expected) => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, `<CDXML><page id="1">${content}<fragment id="120"><n id="121" Element="6" p="90 0"/></fragment></page></CDXML>`);
    await writeFile(list, original);
    const realOpen = codec.open;
    vi.spyOn(codec, "open").mockImplementationOnce(async bytes => {
      const opened = await realOpen(bytes);
      if (kind === "step") for (const object of opened.document!.pages[0].objects) if (object.type === "reaction") object.arrowObjectIds = [];
      if (kind === "circle") opened.document!.pages[0].objects = opened.document!.pages[0].objects.filter(o => o.type !== "graphic");
      return opened;
    });
    const processed = await processCopy(original);
    expect(processed.status, JSON.stringify(processed.errors)).toBe("ok");
    expect(processed.importComparison?.verdict).toBe(expected);
    expect(processed.roundTrips.map(t => t.verdict)).toEqual(["PASS", "PASS", "PASS"]);
    await run(defaults(list, out), async () => ({ result: processed }));
    const row = (await collect(out))[0];
    expect(verdict(row)).toBe(expected);
    await report(out);
    const publicReport = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    const stage = publicReport.survival.afterImport;
    expect(stage.filesMeasured).toBe(1);
    expect(stage.filesLosingAny).toBe(["legacy", "abbreviation"].includes(kind) ? 0 : 1);
    if (kind === "step") {
      expect(stage).toMatchObject({ source: { stepArrows: 1 }, after: { stepArrows: 0 }, stepsWhoseArrowLinkWasLost: 1, filesLosingStepArrows: 1 });
      expect(publicReport.failures["reaction-step-arrow"].count).toBe(1);
    } else if (kind === "abbreviation") expect(stage).toMatchObject({ source: { abbreviations: 1 }, after: { abbreviations: 1 }, abbreviationsLost: 0, filesLosingAbbreviations: 0 });
    else if (kind === "circle") expect(stage).toMatchObject({ source: { display: { "graphic.Oval.Circle": 1 } }, after: { display: {} }, displayLost: { "graphic.Oval.Circle": 1 }, filesLosingDisplay: { "graphic.Oval.Circle": 1 } });
    else expect(stage).toMatchObject({ source: { display: { arrow: 1 } }, after: { display: { arrow: 1 } }, displayLost: {} });
    for (const route of ["cdx", "cdxml", "cdx-cdxml-cdx"]) expect(publicReport.survival.routes[route].filesLosingAny).toBe(["legacy", "abbreviation"].includes(kind) ? 0 : 1);
    const markdown = await readFile(join(out, "report.md"), "utf8");
    expect(markdown).toContain("Stage | Metric | Source | After import | After route | Lost | Files losing any");
    expect(markdown).toContain("import | steps whose arrow link was lost");
    expect(markdown).toContain("cdxml | abbreviations");
    if (kind === "circle") expect(markdown).toContain("import | graphic.Oval.Circle | 1 | 0 | — | 1 | 1");
    await main(["rescore", "--out", out]);
    const rescored = [];
    for await (const result of results(out, true)) rescored.push(result);
    expect(verdict(rescored[0])).toBe(expected);
  });

  it("reports source, import, route and files-losing counts even when an intermediate loss is restored", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml); await writeFile(list, original);
    const counts = { stepArrows: 1, abbreviations: 1, display: { "graphic.Oval.Circle": 1 } };
    const full = { ...emptySummary(), survival: counts };
    const dropped = { ...emptySummary(), survival: { stepArrows: 0, abbreviations: 0, display: {} } };
    await run(defaults(list, out), async () => ({ result: { ...successful(), sourceSurvival: counts, summary: full, roundTrips: [
      { route: "cdxml", ...compare(full, full, []), summary: full, warnings: [], ms: 1 },
      { route: "cdx-cdxml-cdx", ...compare(full, dropped, []), summary: full, warnings: [], legs: [{ before: full, after: dropped, warnings: [] }, { before: dropped, after: full, warnings: [] }], ms: 1 }
    ] } }));
    await report(out);
    const survival = JSON.parse(await readFile(join(out, "report.json"), "utf8")).survival;
    expect(survival.source).toEqual(counts);
    expect(survival.afterImport).toMatchObject({ source: counts, after: counts, filesLosingAny: 0 });
    expect(survival.routes.cdxml).toMatchObject({ source: counts, afterImport: counts, after: counts, filesLosingAny: 0 });
    expect(survival.routes["cdx-cdxml-cdx"]).toMatchObject({ source: counts, afterImport: counts, after: counts,
      stepsWhoseArrowLinkWasLost: 1, abbreviationsLost: 1, displayLost: { "graphic.Oval.Circle": 1 },
      filesLosingAny: 1, filesLosingStepArrows: 1, filesLosingAbbreviations: 1, filesLosingDisplay: { "graphic.Oval.Circle": 1 } });
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("cdx-cdxml-cdx | graphic.Oval.Circle | 1 | 1 | 1 | 1 | 1");
  });

  it("keeps a round-trip link loss when another step gains it and a later leg restores it", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml); await writeFile(list, original);
    const counts = { stepArrows: 3, stepArrowLinks: [2, 1], abbreviations: 0, display: { arrow: 3 } };
    const full = { ...emptySummary(), survival: counts };
    const moved = { ...emptySummary(), survival: { ...counts, stepArrowLinks: [1, 2] } };
    const row: Result = { ...successful(), id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown",
      sourceSurvival: counts, summary: full, roundTrips: [{
        route: "cdx-cdxml-cdx", ...compare(full, moved, []), summary: full, warnings: [], ms: 1,
        legs: [{ before: full, after: moved, warnings: [] }, { before: moved, after: full, warnings: [] }]
      }]
    };
    expect(verdict(row)).toBe("FAIL");
    await run(defaults(list, out), async () => ({ result: row }));
    await report(out);
    const route = JSON.parse(await readFile(join(out, "report.json"), "utf8")).survival.routes["cdx-cdxml-cdx"];
    expect(route).toMatchObject({ source: { stepArrows: 3 }, after: { stepArrows: 3 },
      stepArrowLinksLost: 1, stepsWhoseArrowLinkWasLost: 1, filesLosingStepArrows: 1, filesLosingAny: 1 });
    await main(["rescore", "--out", out]);
    expect(verdict((await collect(out))[0])).toBe("FAIL");
  });
});

describe("stored-summary rescore", () => {
  it("retains undetermined graph checks through chained routes, reports and rescore", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml);
    await writeFile(list, original);
    const describe = chemistry.describeDocument;
    let calls = 0;
    vi.spyOn(chemistry, "describeDocument").mockImplementation(async (...args) => {
      const summary = await describe(...args);
      if (calls++ > 0) {
        summary.molecules[0].smiles += " (synthetic reordered recovery identity)";
        summary.molecules[0].connectivity += " (synthetic reordered recovery key)";
      }
      return summary;
    });
    vi.spyOn(sigma, "compareExactGraph").mockReturnValue("undetermined");
    const processed = await processCopy(original);
    expect(processed.roundTrips.map(t => t.verdict)).toEqual(["ERROR", "ERROR", "ERROR"]);
    for (const trip of processed.roundTrips) {
      expect(trip.differences).toEqual([]);
      expect(trip.undetermined?.map(u => u.feature)).toEqual(["connectivity", "bond-order"]);
    }
    await run(defaults(list, out), async () => ({ result: processed }));
    await report(out);
    const publicReport = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    for (const feature of ["connectivity", "bond-order"]) {
      expect(publicReport.undetermined[feature].count).toBe(1);
      expect(publicReport.failures[feature].count).toBe(0);
    }
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("Undetermined graph checks");
    await main(["rescore", "--out", out]);
    const rescored = (await collect(out))[0];
    expect(rescored.roundTrips.map(t => t.verdict)).toEqual(["ERROR", "ERROR", "ERROR"]);
    expect(rescored.roundTrips.every(t => t.differences.length === 0 && t.undetermined?.length === 2)).toBe(true);
  });

  it("short-circuits an identical symmetric ring and falls through on chemistry or display changes", async () => {
    const molecule = await chemistry.describeStructure(`C1${"C".repeat(298)}C1`);
    const before = { ...emptySummary(), molecules: [molecule] };
    const after = structuredClone(before);
    after.molecules[0].objectId = "different-layout-id";
    const reordered = structuredClone(molecule);
    reordered.species!.graph!.bonds.reverse();
    expect(compareSigma(molecule, reordered)?.status).toBe("undetermined");
    expect(compare(before, after, [])).toMatchObject({ verdict: "PASS", identityPasses: 1, chemistryPassReason: "identity" });
    const charged = structuredClone(after);
    charged.molecules[0].charge = 1;
    expect(compare(before, charged, [])).toMatchObject({ verdict: "FAIL" });
    expect(compare(before, charged, []).identityPasses).toBeUndefined();
    const chargeBefore = structuredClone(before), chargeAfter = structuredClone(after);
    chargeBefore.molecules[0].species!.graph!.atoms[0].charge = 1;
    chargeAfter.molecules[0].species!.graph!.atoms[1].charge = 1;
    // Edited synthetic graphs cannot retain the neutral ring's identity evidence.
    for (const edited of [chargeBefore, chargeAfter]) {
      delete edited.molecules[0].species!.fixedHInchi;
      delete edited.molecules[0].species!.explicitHSmiles;
      delete edited.molecules[0].species!.inchiKey;
    }
    expect(compare(chargeBefore, chargeAfter, [])).toMatchObject({ verdict: "FAIL" });
    expect(compare(chargeBefore, chargeAfter, []).identityPasses).toBeUndefined();
    const wedge = structuredClone(after);
    wedge.molecules[0].displays.wedge++;
    expect(compare(before, wedge, []).identityPasses).toBeUndefined();
    const changedDrawing = structuredClone(after);
    changedDrawing.drawing.pages = 2;
    expect(compare(before, changedDrawing, [])).toMatchObject({ identityPasses: 1, drawingLoss: ["pages"] });
  });
  it("rescoring uses stored geometry to pair changed molecules", async () => {
    const { out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const left = await chemistry.describeStructure("CCO"), right = await chemistry.describeStructure("COC");
    left.objectId = "old"; right.objectId = "new";
    left.pairing = { page: 0, centroid: [15, 0], bondLength: 30, elements: ["C", "C", "O"], labels: ["O"], bonds: 2 };
    right.pairing = { ...left.pairing };
    const before = { ...emptySummary(), molecules: [left] }, after = { ...emptySummary(), molecules: [right] };
    const row: Result = { ...successful(), id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown", summary: before,
      roundTrips: [{ route: "cdxml", verdict: "FAIL", warnings: [], differences: [], drawingLoss: [], summary: after, ms: 1 }] };
    await writeFile(join(out, "private", "results.jsonl"), JSON.stringify(row) + "\n");
    expect(await main(["rescore", "--out", out])).toBe(0);
    const rescored: Result[] = [];
    for await (const result of results(out, true)) rescored.push(result);
    expect(rescored[0].roundTrips[0].verdict).toBe("FAIL");
    expect(rescored[0].roundTrips[0].differences.map(d => d.feature)).toEqual(["connectivity"]);
    expect(rescored[0].roundTrips[0].differences[0].molecule).toEqual({ before: "old", after: "new" });
    expect(rescored[0].roundTrips[0].differences[0].delta?.atomsAdded).toEqual([]);
  });
  it("applies fixed-H and electron-pair proofs when rescoring current and legacy identity evidence", async () => {
    const { out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const cases = [
      ["C=CCC", "CC=CC", "FAIL"],
      ["CC(=O)C", "C=C(O)C", "FAIL"],
      ["O=c1cccc[nH]1", "Oc1ccccn1", "FAIL"],
      ["C[N+](C)=CC=CC=CN(C)CC", "CN(C)C=CC=CC=[N+](C)CC", "DRAWN-DIFFERENTLY"],
      ["CC(=O)[O-]", "CC([O-])=O", "DRAWN-DIFFERENTLY"],
      ["C[N+](=O)[O-]", "C[N+]([O-])=O", "DRAWN-DIFFERENTLY"],
      ["C1=CC=CC=C1", "C1C=CC=CC=1", "PASS"],
      ["[NH4+]", "N", "FAIL"],
      ["C=CCC", "C=CC=C", "FAIL"]
    ];
    const rows: Result[] = [];
    for (const [left, right] of cases) {
      const before = { ...emptySummary(), molecules: [await chemistry.describeStructure(left)] };
      const after = { ...emptySummary(), molecules: [await chemistry.describeStructure(right)] };
      rows.push({ ...successful(), id: (rows.length + 1).toString(16).padStart(12, "0"), group: "ungrouped", era: "unknown", summary: before,
        roundTrips: [{ route: "cdxml", verdict: "DRAWN-DIFFERENTLY", warnings: [], differences: [], drawingLoss: [], summary: after, ms: 1 }] });
    }
    // An old ledger/InChI match is deliberately untrustworthy. Refresh from stored
    // SMILES rather than allowing existing species metadata to bypass the new proof.
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const legacy = structuredClone(rows[index]);
      legacy.id = (rows.length + 1).toString(16).padStart(12, "0");
      for (const m of [...legacy.summary!.molecules, ...legacy.roundTrips[0].summary!.molecules]) {
        m.species = { inchiKey: "LEGACY-MATCH", skeleton: "legacy-match", resonanceKey: "legacy-match", ...(index >= 4 ? { graph: m.species?.graph } : {}) };
      }
      rows.push(legacy);
    }
    await writeFile(join(out, "private", "results.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const importer = vi.spyOn(codec, "open");
    expect(await main(["rescore", "--out", out])).toBe(0);
    expect(importer).not.toHaveBeenCalled();
    const rescored: Result[] = [];
    for await (const row of results(out, true)) rescored.push(row);
    expect(rescored.map(row => row.roundTrips[0].verdict)).toEqual([...cases.map(c => c[2]), "FAIL", "FAIL", "FAIL", "DRAWN-DIFFERENTLY", "DRAWN-DIFFERENTLY", "DRAWN-DIFFERENTLY"]);
    expect(rescored[2].roundTrips[0].differences.every(d => d.identityEvidence?.decision === "fixed-hydrogen-mismatch")).toBe(true);
    expect(rescored.at(-1)!.summary!.molecules[0].species?.version).toBe(2);
  });

  it("removes false equal diagnostics, classifies resonance, preserves chemistry failures and reports rescored results", async () => {
    const { out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const wrap = async (smiles: string): Promise<Summary> => ({ ...emptySummary(), molecules: [await chemistry.describeStructure(smiles)] });
    const simple = await wrap("C");
    const resonanceBefore = await wrap("C[N+](C)=CC=CN(C)CC"), resonanceAfter = await wrap("CN(C)C=CC=[N+](C)CC");
    // Legacy summaries have no precomputed species metadata; rescore derives only identity
    // evidence from their stored SMILES and retains every originally measured feature.
    delete resonanceBefore.molecules[0].species; delete resonanceAfter.molecules[0].species;
    const create = (id: string, before: Summary, after: Summary): Result => ({
      ...successful(), id, group: "ungrouped", era: "unknown", summary: before,
      roundTrips: [{ route: "cdxml", verdict: "FAIL", warnings: [], differences: [{ feature: "sanitization-changed", warned: false, before: [true], after: [true] }], drawingLoss: [], summary: after, ms: 1 }]
    });
    const rows = [
      create("aaaaaaaaaaaa", simple, structuredClone(simple)),
      create("bbbbbbbbbbbb", resonanceBefore, resonanceAfter),
      create("cccccccccccc", await wrap("C=CCC"), await wrap("CC=CC"))
    ];
    const chained = create("dddddddddddd", simple, simple);
    const intermediate = structuredClone(simple); intermediate.molecules[0].charge++;
    chained.roundTrips[0].route = "cdx-cdxml-cdx";
    chained.roundTrips[0].legs = [
      { before: simple, after: intermediate, warnings: [] },
      { before: intermediate, after: simple, warnings: [warning({ code: "cdxml.charge_loss", message: "Charge changed on this leg." })] }
    ];
    rows.push(chained);
    const original = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(join(out, "private", "results.jsonl"), original);
    const importer = vi.spyOn(codec, "open");
    expect(await main(["rescore", "--out", out])).toBe(0);
    expect(importer).not.toHaveBeenCalled();
    const rescored: Result[] = [];
    for await (const row of results(out, true)) rescored.push(row);
    expect(rescored.map(r => r.roundTrips[0].verdict)).toEqual(["PASS", "DRAWN-DIFFERENTLY", "FAIL", "FAIL"]);
    expect(rescored[0].roundTrips[0]).toMatchObject({ differences: [], comparisonInternalErrors: 1 });
    expect(rescored[1].roundTrips[0].differences.every(d => d.identityCheck === "standard-inchi")).toBe(true);
    expect(await readFile(join(out, "private", "results.jsonl"), "utf8")).toBe(original);
    await report(out);
    const reported = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    expect(reported.totals).toMatchObject({ total: 4, pass: 1, drawnDifferently: 1, fail: 2, error: 0, drawnDifferentlyRate: 0.25 });
    expect(reported.sameSpecies["standard-inchi"].count).toBe(1);
    expect(reported.identityPasses).toBe(1);
    expect(reported.failures.charge.count).toBe(1);
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("## DRAWN-DIFFERENTLY");
  });

  it("preserves incomplete summaries and conversion errors as ERROR", async () => {
    const { out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const incomplete = { ...emptySummary(), summaryErrors: [{ objectId: "bad", summaryError: stageError("summary", new Error("synthetic failure")) }] };
    const row: Result = { ...successful(), id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown", summary: incomplete,
      roundTrips: [{ route: "cdxml", verdict: "ERROR", warnings: [], differences: [], drawingLoss: [], summary: emptySummary(), ms: 1 }] };
    await writeFile(join(out, "private", "results.jsonl"), JSON.stringify(row) + "\n");
    await main(["rescore", "--out", out]);
    for await (const rescored of results(out, true)) expect(rescored.roundTrips[0].verdict).toBe("ERROR");
  });

  it("does not clear an unequal legacy chained loss using only the restored final state", async () => {
    const { out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const unchanged = { ...emptySummary(), molecules: [await chemistry.describeStructure("C")] };
    const row: Result = { ...successful(), id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown", summary: unchanged,
      roundTrips: [{ route: "cdx-cdxml-cdx", verdict: "FAIL", warnings: [], differences: [{ feature: "charge", before: [0], after: [1], warned: false }], drawingLoss: [], summary: unchanged, ms: 1 }] };
    await writeFile(join(out, "private", "results.jsonl"), JSON.stringify(row) + "\n");
    await main(["rescore", "--out", out]);
    for await (const rescored of results(out, true)) expect(rescored.roundTrips[0]).toMatchObject({ verdict: "ERROR", reason: expect.stringContaining("intermediate summaries") });
  });
});

describe("stage diagnostics and partial results", () => {
  it("processes the external graph fixture with both warnings and a native-graph summary", async () => {
    const row = await processCopy(fileURLToPath(new URL("./fixtures/external-graph.cdxml", import.meta.url)));
    expect(row.warnings.map(w => w.category)).toEqual(expect.arrayContaining(["cdxml.external_subset_imported", "cdxml.structure_string_not_derived"]));
    expect(row.status, JSON.stringify(row.errors)).toBe("ok");
    expect(row.summary?.molecules.map(m => m.smiles).sort()).toEqual(["CO", "c1ccccc1"]);
    expect(row.roundTrips.every(t => t.verdict === "PASS")).toBe(true);
  }, 30000);

  it("keeps the original summary and XML leg when binary exports throw, including file exports", async () => {
    const { sources, root } = await setup();
    const input = join(sources, "synthetic.cdxml"), exports = join(root, "exports");
    await writeFile(input, syntheticXml);
    await mkdir(exports);
    const actual = codec.interchange;
    vi.spyOn(codec, "interchange").mockImplementation(async (doc, format) => {
      if (format === "cdx") throw Object.assign(new TypeError(`Cannot export '${input}' or 'C:\\private dir\\secret.cdx'`), { code: "EACCES" });
      return actual(doc, format);
    });
    const row = await processCopy(input, ["cdx", "cdxml"], exports);
    expect(row.status).toBe("processing-error");
    expect(row.summary?.molecules[0].smiles).toBe("CO");
    expect(row.error).toMatchObject({ stage: "export-cdx", code: "EACCES", category: "filesystem.permission", message: expect.stringContaining("Cannot export") });
    expect(row.error?.stack?.length).toBeGreaterThan(0);
    expect(row.error!.stack!.length).toBeLessThanOrEqual(5);
    expect(row.roundTrips.map(t => [t.route, t.verdict])).toEqual([["cdx", "ERROR"], ["cdxml", "PASS"], ["cdx-cdxml-cdx", "ERROR"]]);
    expect(row.roundTrips[0].error).toMatchObject({ stage: "export-cdx", code: "EACCES" });
    expect(await readdir(exports)).toEqual(["export.cdxml"]);
    expect(JSON.stringify(row)).not.toContain(input);
    expect(JSON.stringify(row)).not.toContain("private dir");
  }, 30000);

  it.each([false, true])("records a refused or thrown reimport without losing the other route (throws=%s)", async throws => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const actual = codec.open;
    const opened = vi.spyOn(codec, "open");
    opened.mockImplementationOnce(actual).mockImplementationOnce(async () => {
      if (throws) throw new RangeError("Synthetic reimport failure.");
      return { format: "cdx", document: undefined, warnings: [warning({ code: "cdx.invalid_binary", message: "Synthetic refused binary." })] };
    });
    const row = await processCopy(input);
    expect(row.status).toBe("processing-error");
    expect(row.summary?.molecules[0].smiles).toBe("CO");
    expect(row.roundTrips[0]).toMatchObject({ verdict: "ERROR", error: { stage: "reimport-cdx", code: throws ? "RangeError" : "ImportRejectedError", message: expect.stringContaining("Synthetic") } });
    expect(row.roundTrips[1].verdict).toBe("PASS");
  }, 30000);

  it("keeps per-molecule failures and runs exports after an incomplete original summary", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const before = (await processCopy(input, [])).summary!;
    before.summaryErrors = [{ objectId: "bad", summaryError: stageError("summary", new TypeError("Synthetic bad molecule.")) }];
    vi.spyOn(chemistry, "describeDocument").mockResolvedValueOnce(before);
    const row = await processCopy(input);
    expect(row.status).toBe("processing-error");
    expect(row.error).toMatchObject({ stage: "summary", code: "TypeError", category: "runtime.type_error" });
    expect(row.summary?.molecules[0].smiles).toBe("CO");
    expect(row.summary?.summaryErrors?.[0].objectId).toBe("bad");
    expect(row.roundTrips.every(t => t.verdict === "ERROR" && t.summary?.molecules.length)).toBe(true);
  }, 30000);

  it("summarises unknown bond orders as query bonds and keeps the other native molecule", async () => {
    const input = fileURLToPath(new URL("./fixtures/external-graph.cdxml", import.meta.url));
    const source = await codec.open(await readFile(input));
    const molecule = source.document!.pages[0].objects.find(o => o.type === "molecule")!;
    if (molecule.type !== "molecule") throw new Error("Synthetic molecule missing.");
    molecule.bonds[0].order = "unknown";
    vi.spyOn(codec, "open").mockResolvedValueOnce(source);
    const row = await processCopy(input, []);
    expect(row).toMatchObject({ parseOk: true, status: "ok" });
    expect(row.summary?.molecules).toHaveLength(2);
    expect(row.summary?.molecules[0]).toMatchObject({ strict: false, sanitization: { reason: "query-bond" } });
    expect(row.summary?.molecules[1].smiles).toBe("c1ccccc1");
    expect(row.summary?.summaryErrors).toEqual([]);
  }, 30000);

  it("retains successful reimports when the whole original summary throws", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    vi.spyOn(chemistry, "describeDocument").mockRejectedValueOnce(new SyntaxError("Synthetic baseline failure."));
    const row = await processCopy(input);
    expect(row.error).toMatchObject({ stage: "summary", code: "SyntaxError", category: "runtime.syntax_error" });
    expect(row.summary).toBeUndefined();
    expect(row.roundTrips.every(t => t.summary?.molecules[0].smiles === "CO" && t.verdict === "ERROR")).toBe(true);
  }, 30000);

  it("retains earlier chained summaries and differences if a later export fails", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const actual = codec.interchange;
    let binary = 0;
    vi.spyOn(codec, "interchange").mockImplementation(async (doc, format) => {
      if (format === "cdx" && ++binary === 3) throw new Error("Synthetic final export failure.");
      return actual(doc, format);
    });
    const row = await processCopy(input);
    expect(row.roundTrips[2]).toMatchObject({ verdict: "ERROR", error: { stage: "export-cdx", code: "Error" }, summary: { molecules: [{ smiles: "CO" }] } });
  }, 30000);

  it("records detect and import refusals, including returned diagnostics", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, "synthetic unsupported input");
    expect(await processCopy(input)).toMatchObject({ status: "import-error", error: { stage: "detect", code: "UnsupportedFormatError", category: "input.unsupported_format", message: expect.any(String) } });
    await writeFile(input, "<CDXML><page id=\"1\"/></CDXML>");
    const refused = await processCopy(input);
    expect(refused).toMatchObject({ status: "import-error", error: { stage: "import", code: "ImportRejectedError", category: "import.rejected", message: expect.any(String) } });
    vi.spyOn(codec, "open").mockRejectedValueOnce(new SyntaxError("Synthetic parser failure."));
    expect(await processCopy(input)).toMatchObject({ error: { stage: "import", code: "SyntaxError", message: "Synthetic parser failure." } });
  });

  it("redacts platform paths and limits private stacks while categories ignore content", () => {
    const error = new TypeError("Read '/private/synthetic dir/file.cdxml', C:\\synthetic\\a.cdx, \\\\server\\share\\file, ./relative/input and file:///private/input");
    error.stack = `TypeError: private\n${Array.from({ length: 8 }, (_, i) => `    at frame${i} (${i % 2 ? "C:\\private\\worktree\\packages\\chem-core\\src\\molfile.ts" : "/private/worktree/tools/cdx-compat-harness/worker.ts"}:${i + 1}:2)`).join("\n")}`;
    const detail = stageError("summary", error);
    expect(detail).toMatchObject({ stage: "summary", code: "TypeError", category: "runtime.type_error" });
    expect(detail.stack).toHaveLength(5);
    expect(detail.stack?.[0]).toContain("tools/cdx-compat-harness/worker.ts:1:2");
    expect(JSON.stringify(detail)).not.toMatch(/private|synthetic|server|relative\/input/);
    expect(stageError("summary", new TypeError("different chemical content")).category).toBe(detail.category);
    expect(completionLine({ ...successful(), id: "0123456789ab", error: detail })).toBe("0123456789ab ok summary/runtime.type_error\n");
  });

  it("writes private reasons to results, counts stage/category only in reports, and logs every file", async () => {
    const { sources, root, out } = await setup();
    const good = join(sources, "good.cdxml"), bad = join(sources, "bad.cdxml"), missing = join(sources, "missing.cdxml"), list = join(root, "list.txt");
    await writeFile(good, syntheticXml);
    await writeFile(bad, "synthetic bad");
    await writeFile(list, [good, bad, missing].join("\n"));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await run(defaults(list, out), async copy => {
      if ((await readFile(copy, "utf8")) === syntheticXml) return { result: successful() };
      const error = stageError("export-cdxml", new TypeError(`Synthetic chemistry detail '${bad}'`));
      const second = stageError("reimport-cdx", new RangeError("Other private detail"));
      return { result: { ...successful(), status: "processing-error", error, errors: [error, second] } };
    });
    const rows = await collect(out);
    expect(rows).toHaveLength(3);
    expect(rows.filter(r => r.status !== "ok").every(r => r.error?.stage && r.error.code && r.error.category && r.error.message)).toBe(true);
    expect(rows.find(r => r.status === "copy-error")?.error).toMatchObject({ stage: "copy", code: "ENOENT", category: "filesystem.not_found" });
    expect(await readFile(join(out, "private", "results.jsonl"), "utf8")).not.toContain(sources);
    const logs = stderr.mock.calls.map(c => String(c[0]));
    expect(logs).toHaveLength(3);
    expect(logs.every(line => /^(?:[0-9a-f]{12}|unavailable) (?:ok|processing-error|copy-error)(?: [a-z/-]+[a-z._/,\-]*)?\n$/.test(line))).toBe(true);
    expect(logs.join("")).not.toMatch(/Synthetic|chemistry|private|\.cdxml|\.cdx/);
    await report(out);
    const json = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    expect(json.errorCounts).toEqual({ "export-cdxml": { "runtime.type_error": 1 }, "reimport-cdx": { "runtime.range_error": 1 }, copy: { "filesystem.not_found": 1 } });
    const md = await readFile(join(out, "report.md"), "utf8");
    expect(md).toContain("Stage | Category | Errors");
    expect(md).toContain("export-cdxml | runtime.type_error | 1");
    expect(md).not.toMatch(/Synthetic|Other private detail|TypeError|good.cdxml|bad.cdxml/);
  });
});

describe("builds without binary CDX exports", () => {
  it("runs CDXML with missing exports, skips binary routes, and rejects explicit CDX", async () => {
    const { sources, root, out } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    vi.resetModules();
    vi.doMock("../../packages/cdx-compat/src/index", async () => {
      const actual = await vi.importActual<Record<string, unknown>>("../../packages/cdx-compat/src/index");
      const exports = { ...actual };
      delete exports.importCdx;
      delete exports.exportDocumentToCdx;
      return exports;
    });
    try {
      const missingCodec = await import("./codec");
      expect(await missingCodec.loadCdxSupport()).toBeUndefined();
      const { processCopy: processWithoutCdx } = await import("./worker");
      for (const formats of [["cdxml"], ["cdx", "cdxml"]] as const) {
        const row = await processWithoutCdx(input, [...formats]);
        expect(row.status).toBe("ok");
        expect(row.roundTrips.find(trip => trip.route === "cdxml")?.verdict).toBe("PASS");
        expect(row.roundTrips.filter(trip => trip.route !== "cdxml").map(trip => [trip.route, trip.verdict, trip.reason])).toEqual([
          ["cdx", "SKIPPED", "no CDX support in this build"],
          ["cdx-cdxml-cdx", "SKIPPED", "no CDX support in this build"]
        ]);
        const result = { ...row, id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown" };
        expect(verdict(result)).toBe("PASS");
        expect(verdict({ ...result, roundTrips: row.roundTrips.filter(trip => trip.verdict === "SKIPPED") })).not.toBe("PASS");
      }
      const runner = await import("./runner");
      const execute = vi.spyOn(runner, "run").mockResolvedValue({ processed: 1, skipped: 0 });
      const { main: missingMain } = await import("./cli");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      expect(await missingMain(["run", "--list", join(root, "list.txt"), "--out", out, "--formats", "cdxml"])).toBe(0);
      stdout.mockRestore();
      expect(execute).toHaveBeenCalledOnce();
      await expect(missingMain(["run", "--list", join(root, "list.txt"), "--out", out, "--formats", "cdx"])).rejects.toThrow("--formats cdx unavailable: no CDX support in this build");
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../../packages/cdx-compat/src/index");
      vi.resetModules();
    }
  }, 30000);
});

describe("visible interchange chemistry", () => {
  it("fails round-trip isotope loss despite an import-time isotope warning", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const after = (await processCopy(input, [])).summary!;
    const before = structuredClone(after);
    before.molecules[0].isotopes = [{ atom: 0, mass: 13 }];
    before.molecules[0].featureKeys.isotope = "[13C]O";
    const actualOpen = codec.open;
    vi.spyOn(codec, "open").mockImplementationOnce(async bytes => ({ ...await actualOpen(bytes), warnings: [warning({ code: "cdxml.isotope_loss", message: "Isotope lost on initial import." })] }));
    vi.spyOn(chemistry, "describeDocument").mockResolvedValueOnce(before).mockResolvedValue(after);
    const row = await processCopy(input);
    expect(row.warnings[0].features).toContain("isotope");
    expect(row.roundTrips.map(t => t.verdict)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(row.roundTrips.every(t => !t.warnings.some(w => w.message.includes("initial import")))).toBe(true);
  }, 30000);

  it("warns only the same leg and object; another route's warning cannot excuse charge loss", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const before = (await processCopy(input, [])).summary!;
    const after = structuredClone(before);
    after.molecules[0].charge = 1;
    const actualInterchange = codec.interchange;
    vi.spyOn(codec, "interchange").mockImplementation(async (doc, format) => ({ ...await actualInterchange(doc, format), warnings: format === "cdx" ? [warning({ code: "cdxml.charge_loss", message: "Charge lost on this leg.", objectId: before.molecules[0].objectId })] : [] }));
    vi.spyOn(chemistry, "describeDocument").mockResolvedValueOnce(before).mockResolvedValue(after);
    const row = await processCopy(input);
    expect(row.roundTrips.map(t => t.verdict)).toEqual(["WARNED", "FAIL", "WARNED"]);
  }, 30000);

  it("does not excuse an earlier cross-route stage with a later stage's warning", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const before = (await processCopy(input, [])).summary!;
    const after = structuredClone(before);
    after.molecules[0].charge = 1;
    const actualInterchange = codec.interchange;
    vi.spyOn(codec, "interchange").mockImplementation(async (doc, format) => ({ ...await actualInterchange(doc, format), warnings: format === "cdxml" ? [warning({ code: "cdxml.charge_loss", message: "Charge lost on this leg.", objectId: before.molecules[0].objectId })] : [] }));
    vi.spyOn(chemistry, "describeDocument").mockResolvedValueOnce(before).mockResolvedValue(after);
    const row = await processCopy(input);
    expect(row.roundTrips.map(t => t.verdict)).toEqual(["FAIL", "WARNED", "FAIL"]);
  }, 30000);
  it("passes a real RDKit clean round trip through both formats and the chained route", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const row = await processCopy(input);
    expect(row.status).toBe("ok");
    expect(row.summary?.molecules[0].smiles).toBe("CO");
    expect(row.summary?.molecules[0].formula).toBe("CH4O");
    expect(row.roundTrips.map(t => [t.route, t.verdict])).toEqual([["cdx", "PASS"], ["cdxml", "PASS"], ["cdx-cdxml-cdx", "PASS"]]);
    expect(row.roundTrips.every(t => !t.drawingLoss.length)).toBe(true);
  }, 30000);

  it("fails silent chemistry loss and only excuses warnings naming that feature", async () => {
    const { sources } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const original = (await processCopy(input)).summary!;
    const changed = structuredClone(original);
    changed.molecules[0].charge = 1;
    expect(compare(original, changed, []).verdict).toBe("FAIL");
    expect(compare(original, changed, [warning({ code: "cdxml.object_export_unsupported", message: "Unsupported object was skipped." })]).verdict).toBe("FAIL");
    expect(compare(original, changed, [warning({ code: "cdxml.charge_not_saved", message: "Formal charge was not saved." })]).verdict).toBe("WARNED");
    expect(compare(original, changed, [warning({ code: "cdxml.isotope_not_saved", message: "Isotope was not saved." })]).verdict).toBe("FAIL");
    const wrongFormula = structuredClone(original);
    wrongFormula.molecules[0].formula = "CH6O";
    expect(compare(original, wrongFormula, []).verdict).toBe("FAIL");
    const drawing = structuredClone(original);
    drawing.drawing.pages = 2;
    expect(compare(original, drawing, [])).toMatchObject({ verdict: "PASS", drawingLoss: ["pages"] });
  }, 30000);
});

describe("isolation, failure supervision and private output", () => {
  it.each(["SIGTERM", "SIGINT", "exit"] as const)("kills running children and removes copies on parent %s", async signal => {
    const { root, sources } = await setup();
    const input = join(sources, "synthetic.cdxml"), parentFile = join(root, "parent.mjs"), workerFile = join(root, "hanging.mjs"), ready = join(root, "ready.json");
    await writeFile(input, syntheticXml);
    const ioUrl = new URL("./io.ts", import.meta.url).href;
    const runnerUrl = new URL("./runner.ts", import.meta.url).href;
    await writeFile(workerFile, `import { appendFileSync } from 'node:fs'; import { dirname } from 'node:path';
    process.once('message', job => {
      appendFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, directory: dirname(job.copy)}) + '\\n');
      setInterval(() => {}, 1000);
    });`);
    await writeFile(parentFile, `import { withCopy } from ${JSON.stringify(ioUrl)};
      import { child } from ${JSON.stringify(runnerUrl)};
      process.once('message', value => value === 'exit' ? process.exit(0) : process.emit(value));
      await Promise.all(Array.from({length: 2}, () => withCopy(${JSON.stringify(input)}, async copy => {
        await child(copy, { timeoutMs: 60000, maxOldSpaceMb: 256, formats: [] }, ${JSON.stringify(workerFile)});
      }, ${JSON.stringify(root)})));`);
    const parentOptions: ForkOptions & { windowsHide: boolean } = {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true
    };
    const parent = fork(parentFile, [], parentOptions);
    let pids: number[] = [];
    try {
      const infos = await vi.waitFor(async () => {
        const rows = (await readFile(ready, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; directory: string });
        expect(rows).toHaveLength(2);
        return rows;
      }, { timeout: 8000, interval: 25 });
      pids = infos.map(info => info.pid);
      for (const info of infos) expect(await stat(info.directory)).toBeDefined();
      const closed = once(parent, "close");
      // Windows OS kill requests forcibly terminate Node without delivering a signal
      // event. Exercise its same handlers via IPC; POSIX hosts receive real signals.
      if (signal === "exit" || process.platform === "win32") parent.send(signal); else parent.kill(signal);
      await closed;
      // SIGKILL delivery on explicit exit is asynchronous; allow the OS to reap it.
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 5000, interval: 25 });
      for (const info of infos) await expect(stat(info.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      parent.kill("SIGKILL");
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }, 15000);

  it("refuses a resumed results file hardlinked to an original without changing it", async () => {
    const { sources, root, out } = await setup();
    const input = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(input, syntheticXml);
    await writeFile(list, input);
    await mkdir(join(out, "private"), { recursive: true });
    const target = join(out, "private", "results.jsonl");
    await link(input, target);
    const before = await stat(input);
    const execute = vi.fn();
    await expect(run({ ...defaults(list, out), resume: true }, execute)).rejects.toThrow("hardlinked");
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(input, "utf8")).toBe(syntheticXml);
    expect((await stat(input)).mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a collected original inode even when its link count is one", async () => {
    const { sources, out } = await setup();
    const input = join(sources, "synthetic.cdxml"), target = join(out, "report.md");
    await writeFile(input, syntheticXml);
    const before = await stat(input);
    await validateDestination(input, out);
    await mkdir(out);
    // Move the collected inode to output to exercise the identity guard independently of nlink.
    await rename(input, target);
    expect((await stat(target)).nlink).toBe(1);
    await expect(writeOutput(target, "replacement")).rejects.toThrow("original's inode");
    await expect(appendOutput(target, "append")).rejects.toThrow("original's inode");
    expect(await readFile(target, "utf8")).toBe(syntheticXml);
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(["index.tsv", "report.md", "export.cdx"])("refuses writes and appends to a hardlinked %s", async name => {
    const { root, out } = await setup();
    await mkdir(out);
    const target = join(out, name), other = join(root, "other");
    await writeFile(other, "synthetic output");
    await link(other, target);
    expect((await stat(target)).nlink).toBe(2);
    await expect(writeOutput(target, "replacement")).rejects.toThrow("hardlinked");
    await expect(appendOutput(target, "append")).rejects.toThrow("hardlinked");
    expect(await readFile(other, "utf8")).toBe("synthetic output");
  });

  it("runs the actual child and leaves original bytes and mtime unchanged; removes copies on exceptions", async () => {
    const { sources, root } = await setup();
    const input = join(sources, "synthetic.cdxml");
    await writeFile(input, syntheticXml);
    const before = await stat(input);
    let temporaryDirectory = "";
    await withCopy(input, async (copy, id, _size, directory) => {
      temporaryDirectory = directory;
      expect((await stat(copy)).mode & 0o222).toBe(0);
      expect(id).toBe(createHash("sha256").update(syntheticXml).digest("hex").slice(0, 12));
      const outcome = await child(copy, defaults("", root));
      expect(outcome.status).toBeUndefined();
      expect(outcome.result?.roundTrips.map(t => t.verdict)).toEqual(["PASS", "PASS", "PASS"]);
    });
    await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withCopy(input, async (_copy, _id, _size, directory) => { temporaryDirectory = directory; throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
    await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(input, "utf8")).toBe(syntheticXml);
    expect((await stat(input)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(sources)).toEqual(["synthetic.cdxml"]);
  }, 30000);

  it("reports detected format and elapsed time for every actual conversion stage", async () => {
    const { sources } = await setup();
    const input = join(sources, "progress.cdxml");
    await writeFile(input, syntheticXml);
    const updates: WorkerProgress[] = [];
    const result = await processCopy(input, ["cdxml"], undefined, value => updates.push(value));
    expect(result.status).toBe("ok");
    expect(updates.find(p => p.stage === "import")).toMatchObject({ format: "cdxml", parseOk: false });
    expect(updates.find(p => p.stage === "summary")).toMatchObject({ format: "cdxml", parseOk: true });
    expect(updates.map(p => p.stage)).toEqual(expect.arrayContaining(["export-cdxml", "reimport-cdxml", "cross"]));
    expect(result.timings.stageMs).toMatchObject({ import: expect.any(Number), summary: expect.any(Number), "export-cdxml": expect.any(Number), "reimport-cdxml": expect.any(Number), cross: expect.any(Number) });
    expect(updates.every(p => Object.values(p.stageMs).every(ms => ms! >= 0))).toBe(true);
  });

  it("records timeout, crash and OOM, continues, resumes, and removes every temporary directory", async () => {
    const { root, sources, out } = await setup();
    const worker = join(root, "fake.mjs");
    await writeFile(worker, `import { readFileSync } from 'node:fs';
process.once('message', job => {
 const mode = readFileSync(job.copy, 'utf8');
 if (mode === 'hang') { setInterval(() => {}, 1000); return; }
 if (mode === 'crash') process.exit(17);
 if (mode === 'oom') { process.stderr.write('FATAL ERROR: heap out of memory'); process.exit(1); }
 process.send(${JSON.stringify(successful())}, () => process.exit(0));
});`);
    const originals: string[] = [];
    for (const mode of ["hang", "crash", "oom", "ok"]) { const file = join(sources, `${mode}.cdxml`); await writeFile(file, mode); originals.push(file); }
    const list = join(root, "list.txt");
    await writeFile(list, originals.join("\n"));
    const copies: string[] = [];
    const execute: typeof child = async (copy, options) => { copies.push(copy); return child(copy, { ...options, timeoutMs: 1500 }, worker); };
    expect(await run(defaults(list, out), execute)).toEqual({ processed: 4, skipped: 0 });
    const rows = await collect(out);
    expect(rows.map(r => r.status).sort()).toEqual(["crash", "ok", "oom", "timeout"]);
    for (const row of rows.filter(r => r.status !== "ok")) expect(row.error).toMatchObject({ stage: "detect", code: expect.any(String), category: `worker.${row.status}`, message: expect.any(String) });
    for (const copy of copies) await expect(stat(copy)).rejects.toMatchObject({ code: "ENOENT" });
    await appendFile(join(out, "private", "results.jsonl"), '{"interrupted":');
    expect(await run({ ...defaults(list, out), resume: true }, () => { throw new Error("resume must not invoke a child"); })).toEqual({ processed: 0, skipped: 4 });
    expect(await collect(out)).toHaveLength(4);
    for (const file of await readdir(join(out, "private"))) {
      if ((await stat(join(out, "private", file))).isDirectory()) continue;
      const text = await readFile(join(out, "private", file), "utf8");
      for (const original of originals) expect(text.includes(original)).toBe(file === "index.tsv");
    }
  }, 30000);

  it("calls after-batch with one temporary path-list argument and logs failures without stopping", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml);
    await writeFile(list, `${original}\n`);
    const preload = join(root, "hook.cjs"), capture = join(root, "capture.json");
    await writeFile(preload, `const fs = require('node:fs'); fs.writeFileSync(process.env.CDX_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(1), text: fs.readFileSync(process.argv[1], 'utf8')})); process.exit(7);`);
    const savedOptions = process.env.NODE_OPTIONS, savedCapture = process.env.CDX_TEST_CAPTURE;
    try {
      process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
      process.env.CDX_TEST_CAPTURE = capture;
      await run({ ...defaults(list, out), afterBatch: process.execPath }, async () => ({ result: successful() }));
    } finally {
      if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions;
      if (savedCapture === undefined) delete process.env.CDX_TEST_CAPTURE; else process.env.CDX_TEST_CAPTURE = savedCapture;
    }
    const called = JSON.parse(await readFile(capture, "utf8"));
    expect(called.args).toHaveLength(1);
    expect(called.text).toBe(`${original}\n`);
    await expect(stat(called.args[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(out, "private", "events.jsonl"), "utf8")).toContain("after_batch_failed");
    expect((await collect(out))[0].status).toBe("ok");
  }, 15000);

  it("keeps paths only in the index and emits reports without SMILES, formulae, names or slash paths", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt"), groups = join(root, "groups.tsv");
    await writeFile(original, syntheticXml);
    await writeFile(list, original);
    await writeFile(groups, `${original}\tprivate-name-${original}\t1990-1999\n`);
    await run({ ...defaults(list, out), groupMap: groups }, async () => ({ result: {
      ...successful(), summary: { ...emptySummary(), molecules: [{ smiles: "C[C@H](O)C(=O)O", formula: "C3H6O3" } as never] },
      warnings: [warning({ code: "cdxml.import_warning", message: `Private name ${original} C[C@H](O)C(=O)O` })]
    } }));
    await report(out);
    for (const name of ["report.md", "report.json"]) {
      const text = await readFile(join(out, name), "utf8");
      expect(text).not.toMatch(/[\\/]/);
      expect(text).not.toMatch(/C\[C@H\]|C3H6O3|private-name|smiles|formula/i);
      expect(text).not.toMatch(/(?:\[[0-9]*[A-Z][a-z]?(?:@|[+-])|c1cc|C[CNO](?:[CNO]|\())/);
      expect(text).toContain("1990-1999");
    }
    expect(JSON.parse(await readFile(join(out, "report.json"), "utf8")).totals.total).toBe(1);
    for (const name of await readdir(join(out, "private"))) {
      if ((await stat(join(out, "private", name))).isDirectory()) continue;
      const text = await readFile(join(out, "private", name), "utf8");
      expect(text.includes(original)).toBe(name === "index.tsv");
    }
  });

  it("reports original wavy single bonds and those surviving every leg", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml);
    await writeFile(list, original);
    const molecule = await chemistry.describeStructure("CC");
    molecule.displays.wavy = 1;
    const summary = { ...emptySummary(), molecules: [molecule] };
    await run(defaults(list, out), async () => ({ result: {
      ...successful(), summary,
      roundTrips: [{ route: "cdxml", verdict: "PASS", warnings: [], differences: [], drawingLoss: [], summary: structuredClone(summary), ms: 1 }]
    } }));
    await report(out);
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("Wavy single bonds: 1 in originals; 1 survived every leg.");
  });

  it("reports bracket usage and per-route survival across intermediate legs", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml);
    await writeFile(list, original);
    const bracket = { bracketKind: "square", bracketUsage: ["sru", "sru"], repeatCount: [2, 2], label: "n", repeatUnit: [true, true], memberCount: 1, crossingBondCount: 2 };
    const summary = { ...emptySummary(), brackets: [bracket], unpairedBrackets: 1 };
    const dropped = { ...summary, brackets: [] };
    await run(defaults(list, out), async () => ({ result: { ...successful(), summary, roundTrips: [
      { route: "cdxml", verdict: "PASS", warnings: [], differences: [], drawingLoss: [], summary, ms: 1 },
      { route: "cdx-cdxml-cdx", verdict: "FAIL", warnings: [], differences: [], drawingLoss: [], summary, legs: [{ before: summary, after: dropped, warnings: [] }, { before: dropped, after: summary, warnings: [] }], ms: 1 }
    ] } }));
    await report(out);
    expect(JSON.parse(await readFile(join(out, "report.json"), "utf8")).brackets).toMatchObject({ pairs: 1, unpaired: 1, byUsage: { sru: 1 }, routes: { cdxml: { survivingUnchanged: 1, filesLosingPairs: 0 }, "cdx-cdxml-cdx": { survivingUnchanged: 0, filesLosingPairs: 1 } } });
    expect(await readFile(join(out, "report.md"), "utf8")).toContain("Brackets: 1 pairs after import");
  });

  it("rejects output beside an original before creating it", async () => {
    const { sources, root } = await setup();
    const input = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(input, syntheticXml);
    await writeFile(list, input);
    const output = join(sources, "out");
    await expect(run(defaults(list, output))).rejects.toThrow("outside every original");
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["out", "private", "result", "temp"])("refuses a symlinked %s without writing any files", async kind => {
    const { sources, root, out } = await setup();
    const input = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(input, syntheticXml);
    await writeFile(list, input);
    if (kind === "out") await symlink(sources, out, "junction");
    else {
      await mkdir(out);
      if (kind === "private") await symlink(sources, join(out, "private"), "junction");
      else {
        await mkdir(join(out, "private"));
        await symlink(kind === "temp" ? sources : input, join(out, "private", kind === "temp" ? "tmp" : "results.jsonl"), kind === "temp" ? "junction" : "file");
      }
    }
    const execute = vi.fn();
    await expect(run(defaults(list, out), execute)).rejects.toThrow("symlink");
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(sources)).toEqual(["synthetic.cdxml"]);
    expect(await readFile(input, "utf8")).toBe(syntheticXml);
    if (kind !== "out" && kind !== "private") expect(await readdir(join(out, "private"))).toEqual([kind === "temp" ? "tmp" : "results.jsonl"]);
    else if (kind === "private") expect(await readdir(out)).toEqual(["private"]);
  });

  it("resolves every listed original parent before processing any file", async () => {
    const { sources, root, out } = await setup();
    await mkdir(out);
    const alias = join(root, "alias");
    await symlink(out, alias, "junction");
    const first = join(sources, "first.cdxml"), second = join(alias, "second.cdxml"), list = join(root, "list.txt");
    await writeFile(first, syntheticXml); await writeFile(second, syntheticXml);
    await writeFile(list, `${first}\n${second}`);
    const execute = vi.fn();
    await expect(run(defaults(list, out), execute)).rejects.toThrow("outside every original");
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(out)).toEqual(["second.cdxml"]);
  });

  it("rejects output inside originals through an ancestor alias without writing files", async () => {
    const { sources, root } = await setup();
    const input = join(sources, "synthetic.cdxml"), list = join(root, "list.txt"), alias = join(root, "alias");
    await writeFile(input, syntheticXml); await writeFile(list, input);
    await mkdir(join(sources, "existing-output"));
    await symlink(sources, alias, "junction");
    await expect(run(defaults(list, join(alias, "existing-output")))).rejects.toThrow("outside every original");
    expect(await readdir(join(sources, "existing-output"))).toEqual([]);
    expect(await readFile(input, "utf8")).toBe(syntheticXml);
  });

  it("refuses an original whose realpath is inside output", async () => {
    const { sources, root, out } = await setup();
    await mkdir(out);
    const target = join(out, "original.cdxml"), input = join(sources, "alias.cdxml"), list = join(root, "list.txt");
    await writeFile(target, syntheticXml);
    await symlink(target, input, "file");
    await writeFile(list, input);
    await expect(run(defaults(list, out))).rejects.toThrow("contain an original");
    expect(await readdir(out)).toEqual(["original.cdxml"]);
  });

  it("refuses export-set --to outside private without writing files", async () => {
    const { sources, root, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt"), ids = join(root, "ids.txt");
    await writeFile(original, syntheticXml); await writeFile(list, original);
    await run(defaults(list, out), async () => ({ result: successful() }));
    await writeFile(ids, (await collect(out))[0].id);
    const to = join(root, "public-exports");
    const files = await readdir(join(out, "private"));
    await expect(main(["export-set", "--list", ids, "--out", out, "--to", to])).rejects.toThrow("inside <out>/private");
    await expect(stat(to)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(out, "private"))).toEqual(files);
    expect(await readdir(sources)).toEqual(["synthetic.cdxml"]);
  });

  it("refuses a private export symlink to a public directory without writing files", async () => {
    const { root, out } = await setup();
    await mkdir(join(out, "private"), { recursive: true });
    const publicDirectory = join(root, "public"), ids = join(root, "ids.txt");
    await mkdir(publicDirectory); await writeFile(ids, "0123456789ab");
    const to = join(out, "private", "exports");
    await symlink(publicDirectory, to, "junction");
    await expect(main(["export-set", "--list", ids, "--out", out, "--to", to])).rejects.toThrow("symlink");
    expect(await readdir(publicDirectory)).toEqual([]);
    expect(await readdir(join(out, "private"))).toEqual(["exports"]);
  });

  it("logs an unreadable source privately and continues with the next synthetic file", async () => {
    const { root, sources, out } = await setup();
    const missing = join(sources, "missing.cdxml"), good = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(good, syntheticXml);
    await writeFile(list, `${missing}\n${good}\n`);
    expect(await run(defaults(list, out), async () => ({ result: successful() }))).toEqual({ processed: 1, skipped: 0, copyErrors: 1 });
    expect(await readFile(join(out, "private", "index.tsv"), "utf8")).toContain(`unavailable\t${missing}`);
    expect(await readFile(join(out, "private", "events.jsonl"), "utf8")).toContain("ENOENT");
    expect(await readFile(join(out, "private", "events.jsonl"), "utf8")).not.toContain(missing);
  });

  it("exports selected IDs through the real supervised child", async () => {
    const { root, sources, out } = await setup();
    const original = join(sources, "synthetic.cdxml"), list = join(root, "list.txt");
    await writeFile(original, syntheticXml);
    await writeFile(list, original);
    await run(defaults(list, out), async () => ({ result: successful() }));
    const id = (await collect(out))[0].id, ids = join(root, "ids.txt"), to = join(out, "private", "exports");
    await writeFile(ids, id);
    expect(await main(["export-set", "--list", ids, "--out", out, "--to", to])).toBe(0);
    expect(await readdir(to)).toEqual([`${id}.cdx`, `${id}.cdxml`]);
    const cdx = await processCopy(join(to, `${id}.cdx`));
    expect(cdx.summary?.molecules[0].smiles).toBe("CO");
    expect(await readFile(join(to, `${id}.cdxml`), "utf8")).not.toContain("org.chemdraft/");
  }, 30000);
});
