import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { open, interchange } from "./codec";
import * as chemistry from "./chemistry";
import * as sigma from "./sigma";
import { compare, compareSurvival, pairMolecules, warning, type Result } from "./model";
import { nativeSurvival, sourceSurvival, stepArrowLosses } from "./survival";
import { parseSourceXml } from "./xml";
import { writeCdx } from "../../packages/cdx-compat/src/cdxBinary";
import { processCopy } from "./worker";
import { report, verdict } from "./report";
import { rescore } from "./rescore";
import { results } from "./io";

// All inputs are authored here; temporary files stay beside this test in the worktree.
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const wrap = (content: string) => `<CDXML><page id="1">${content}</page></CDXML>`;
const arrow = '<arrow id="50" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full"/>';
const line = (id: number) => `<graphic id="${id}" GraphicType="Line" BoundingBox="0 ${id} 30 ${id}"/>`;
const fragment = (id: number, x: number, ether = false) => `<fragment id="${id}">
  <n id="${id + 1}" Element="6" p="${x} 0"/>
  <n id="${id + 2}" Element="${ether ? 8 : 6}" p="${x + 30} 0"/>
  <n id="${id + 3}" Element="${ether ? 6 : 8}" p="${x + 60} 0"/>
  <b id="${id + 4}" B="${id + 1}" E="${id + 2}" Order="1"/>
  <b id="${id + 5}" B="${id + 2}" E="${id + 3}" Order="1"/>
</fragment>`;
const diagnostic = (message: string, sourceObjectId?: string) => warning({
  code: "cdxml.object_import_unsupported", message, sourceObjectId
});

describe("synthetic harness correctness regressions", () => {
  it.each(["cdxml", "cdx"] as const)("aligns steps skipped by the %s importer by source ID", async format => {
    const xml = wrap(`<scheme id="90"><step id="91"/><step id="93" ReactionStepArrows="999"/>
      <step id="92" ReactionStepArrows="50"/></scheme>${arrow}`);
    const bytes = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
    const source = sourceSurvival(bytes), imported = await open(bytes);
    const native = nativeSurvival(imported.document!);
    expect(source).toMatchObject({ stepArrowLinks: [0, 0, 1], stepIds: ["91", "93", "92"] });
    expect(native).toMatchObject({ stepArrowLinks: [1], stepIds: ["92"] });
    expect(compareSurvival(source, native, []).verdict).toBe("PASS");
    expect(stepArrowLosses(source, [native])).toMatchObject({ links: 0, steps: 0 });
    const reopened = (await open((await interchange(imported.document!, format)).bytes)).document!;
    expect(stepArrowLosses(source, [native, nativeSurvival(reopened)])).toMatchObject({ links: 0, steps: 0 });
    reopened.pages[0].objects.find(o => o.type === "reaction")!.arrowObjectIds = [];
    expect(stepArrowLosses(source, [nativeSurvival(reopened)])).toMatchObject({ links: 1, steps: 1, lostStepIds: ["92"] });
  });

  it("refuses a warning for the wrong step, including a misleading warning object ID", async () => {
    const bytes = Buffer.from(wrap(`<scheme id="90"><step id="91" ReactionStepArrows="50"/>
      <step id="92" ReactionStepArrows="50"/></scheme>${arrow}`));
    const source = sourceSurvival(bytes), imported = await open(bytes);
    const reactions = imported.document!.pages[0].objects.filter(o => o.type === "reaction");
    reactions[1].arrowObjectIds = [];
    const after = nativeSurvival(imported.document!);
    const named = (step: string, objectId = step) => warning({ code: "cdxml.reaction_reference_unresolved", objectId,
      message: `CDXML step ${step}: ReactionStepArrows id "50" was lost.` });
    for (const w of [named("91"), named("91", "92"), named("192")]) {
      expect(compareSurvival(source, after, [w])).toMatchObject({ verdict: "FAIL", differences: [{ warned: false }] });
    }
    expect(compareSurvival(source, after, [named("92", reactions[1].id)]).verdict).toBe("WARNED");
    const aggregateOnly = { ...after }; delete aggregateOnly.stepArrowLinks; delete aggregateOnly.stepIds;
    expect(compareSurvival(source, aggregateOnly, [named("91")]).verdict).toBe("FAIL");
    reactions[0].arrowObjectIds = [];
    expect(compareSurvival(source, nativeSurvival(imported.document!), [named("92")]).verdict).toBe("FAIL");
  });

  it("requires one display warning per lost object, scoped to source IDs when supplied", async () => {
    const bytes = Buffer.from(wrap(line(50) + line(51) + line(52)));
    const source = sourceSurvival(bytes), imported = await open(bytes);
    imported.document!.pages[0].objects = imported.document!.pages[0].objects.filter(o => o.compatibility?.originalId === "52");
    const after = nativeSurvival(imported.document!);
    expect(source.displayObjectIds).toEqual({ "graphic.Line": ["50", "51", "52"] });
    expect(after.displayObjectIds).toEqual({ "graphic.Line": ["52"] });
    const a = diagnostic("Line graphic dropped", "50"), b = diagnostic("Line graphic dropped", "51");
    expect(compareSurvival(source, after, [a]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(source, after, [a, { ...a }]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(source, after, [a, diagnostic("Line graphic dropped", "52")]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(source, after, [a, b]).verdict).toBe("WARNED");
    expect(compareSurvival(source, after, [diagnostic("Lines dropped")]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(source, after, [diagnostic("Lines dropped"), diagnostic("Line dropped")]).verdict).toBe("WARNED");
    const legacy = { ...source }; delete legacy.displayObjectIds;
    expect(compareSurvival(legacy, after, [a]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(legacy, after, [a, b]).verdict).toBe("WARNED");
  });

  it("matches display kinds as whole words", async () => {
    const bytes = Buffer.from(wrap(line(50))), imported = await open(bytes);
    imported.document!.pages[0].objects = [];
    const source = sourceSurvival(bytes), after = nativeSurvival(imported.document!);
    expect(compareSurvival(source, after, [diagnostic("Underlined text graphic dropped", "50")]).verdict).toBe("DRAWN-DIFFERENTLY");
    expect(compareSurvival(source, after, [diagnostic("Line graphic dropped", "50")]).verdict).toBe("WARNED");
  });

  it("retains a definite FAIL beside undetermined checks in workers, reports and rescore", async () => {
    const root = await mkdtemp(join(fileURLToPath(new URL(".", import.meta.url)), ".correctness-test-"));
    directories.push(root);
    const input = join(root, "synthetic.cdxml"), out = join(root, "out");
    await writeFile(input, wrap(fragment(20, 0) + fragment(30, 150, true)));
    const describe = chemistry.describeDocument;
    let calls = 0;
    vi.spyOn(chemistry, "describeDocument").mockImplementation(async (...args) => {
      const summary = await describe(...args);
      if (calls++ > 0) {
        // Synthetic recovered identity requires a bounded graph check; an independent
        // measured charge loss is definite even if that check cannot finish.
        summary.molecules[0].smiles += " (synthetic recovered identity)";
        summary.molecules[0].connectivity += " (synthetic recovered key)";
        summary.molecules[1].charge++;
      }
      return summary;
    });
    vi.spyOn(sigma, "compareExactGraph").mockReturnValue("undetermined");
    const processed = await processCopy(input);
    expect(processed.status).toBe("ok");
    expect(processed.roundTrips.map(t => t.verdict)).toEqual(["FAIL", "FAIL", "FAIL"]);
    for (const trip of processed.roundTrips) {
      expect(trip.undetermined?.map(u => u.feature)).toEqual(["connectivity", "bond-order"]);
      expect(trip.differences).toContainEqual(expect.objectContaining({ feature: "charge", warned: false }));
    }
    const row: Result = { ...processed, id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown" };
    const unfinished = { ...structuredClone(row.roundTrips[0]), verdict: "ERROR" as const, differences: [] };
    expect(verdict({ ...row, roundTrips: [unfinished, row.roundTrips[1]] })).toBe("FAIL");
    expect(verdict({ ...row, roundTrips: [unfinished], sourceSurvival: {
      stepArrows: 1, stepArrowLinks: [1], stepIds: ["91"], abbreviations: 0, display: {}
    } })).toBe("FAIL");
    expect(verdict({ ...row, roundTrips: [unfinished] })).toBe("error");
    await mkdir(join(out, "private"), { recursive: true });
    // Old scorers recorded ERROR for this mix: rescore must repair the precedence.
    row.roundTrips.forEach(trip => { trip.verdict = "ERROR"; });
    await writeFile(join(out, "private", "results.jsonl"), `${JSON.stringify(row)}\n`);
    await rescore(out);
    const rescored: Result[] = [];
    for await (const result of results(out, true)) rescored.push(result);
    expect(rescored[0].roundTrips.map(t => t.verdict)).toEqual(["FAIL", "FAIL", "FAIL"]);
    await report(out);
    const publicReport = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    expect(publicReport.totals).toMatchObject({ fail: 1, error: 0 });
    expect(publicReport.undetermined.connectivity.count).toBe(1);
  }, 30000);

  it.each([true, false])("pairs source identities or geometry before shifted native IDs (source IDs: %s)", async sourceIds => {
    const imported = await open(Buffer.from(wrap('<t id="10" p="0 60"><s>synthetic</s></t>' + fragment(20, 0) + fragment(30, 150, true))));
    const before = await chemistry.describeDocument(imported.document!, []);
    expect(before.molecules.map(m => m.originalId)).toEqual(["20", "30"]);
    imported.document!.pages[0].objects = imported.document!.pages[0].objects.filter(o => o.type !== "text");
    const reopened = (await open((await interchange(imported.document!, "cdxml")).bytes)).document!;
    const after = await chemistry.describeDocument(reopened, []);
    expect(after.molecules[1].objectId).toBe(before.molecules[0].objectId);
    for (const [index, molecule] of after.molecules.entries()) {
      // Recovery identities may differ while exact graph evidence proves preservation.
      molecule.smiles += " (synthetic recovered identity)";
      if (sourceIds) molecule.originalId = before.molecules[index].originalId;
      else delete molecule.originalId;
    }
    if (!sourceIds) before.molecules.forEach(m => { delete m.originalId; });
    const pairs = pairMolecules(before.molecules, after.molecules);
    expect(pairs.map(p => [p.before?.pairing?.centroid, p.after?.pairing?.centroid])).toEqual(
      before.molecules.map(m => [m.pairing!.centroid, m.pairing!.centroid]));
    const comparison = compare(before, after, []);
    expect(comparison.differences.filter(d => d.feature === "connectivity")).toEqual([]);
    expect(comparison.verdict).toBe("DRAWN-DIFFERENTLY");
    if (sourceIds) {
      // A stable source identity still wins if geometry would suggest a different pair.
      after.molecules.reverse();
      [after.molecules[0].pairing, after.molecules[1].pairing] = [after.molecules[1].pairing, after.molecules[0].pairing];
      expect(pairMolecules(before.molecules, after.molecules).map(p => p.after?.originalId)).toEqual(["20", "30"]);
    }
  });
});
