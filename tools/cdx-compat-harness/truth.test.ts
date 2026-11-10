import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeDocument, describeStructure, describeTruthSru } from "./chemistry";
import { BracketObjectSchema, createEmptyDocument, MoleculeObjectSchema } from "../../packages/chem-core/src/index";
import { groundTruth, matchTruth } from "./truth";
import { report } from "./report";
import type { Result } from "./model";
import { installNodeRdkitModuleLoader } from "../../packages/rdkit-adapter/src/node";
import { ensureRdkit } from "../../packages/rdkit-adapter/src/conformer";

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });

it("accepts only explicitly listed alternative forms", async () => {
  const dative = await describeStructure("N->B(F)(F)F");
  const charged = await describeStructure("[NH3+][B-](F)(F)F");
  expect(matchTruth([dative], [[dative, charged]]).matched).toBe(1);
  expect(matchTruth([dative], [[charged]]).matched).toBe(0);
});

it("projects only listed SRU crossing endpoints and leaves incomplete pairs unchanged", async () => {
  const doc = createEmptyDocument();
  const mol = MoleculeObjectSchema.parse({ id: "m", type: "molecule", x: 0, y: 0, width: 120, height: 20, structureFormat: "smiles", structure: "", atoms: [0, 1, 2, 3, 4].map(i => ({ id: `a${i}`, element: "C", x: i * 30, y: 0 })), bonds: [0, 1, 2, 3].map(i => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })) });
  mol.bonds[3].fromAtomId = "a2";
  const bracket = (id: string) => BracketObjectSchema.parse({ id, type: "bracket", x: 0, y: 0, width: 10, height: 20, bracketKind: "square", pairId: "p", bracketUsage: "sru", containedObjectIds: ["m"], crossingBondIds: [{ objectId: "m", bondId: "b0" }, { objectId: "m", bondId: "b2" }], compatibility: { sourceFormat: "cdxml", unknown: { cdxmlBracketMembers: [{ objectId: "m", atomId: "a1" }, { objectId: "m", atomId: "a2" }] } } });
  const a = bracket("left"), b = bracket("right");
  doc.pages[0].objects = [mol, a, b];
  const baseline = await describeDocument(doc, []);
  const projected = await describeTruthSru(doc, baseline);
  expect(projected?.molecules[0].smiles).toBe((await describeStructure("*CC(*)C")).smiles);
  // Removing the unlisted branch yields polyethylene's two repeat-unit ends.
  mol.atoms.pop(); mol.bonds.pop();
  const polyethylene = await describeTruthSru(doc, await describeDocument(doc, []));
  expect(polyethylene?.molecules[0].smiles).toBe((await describeStructure("*CC*")).smiles);
  a.crossingBondIds = []; b.crossingBondIds = [];
  const unchanged = await describeDocument(doc, []);
  expect(await describeTruthSru(doc, unchanged)).toMatchObject({ molecules: unchanged.molecules, notes: ["sru.missing_crossing_data"] });
}, 30000);

it("matches reordered molecule multisets and classifies a stereo near-miss", async () => {
  const left = await describeStructure("C[C@H](O)C(=O)O");
  const right = await describeStructure("C[C@@H](O)C(=O)O");
  const alcohol = await describeStructure("CO");
  expect(matchTruth([left, alcohol], [alcohol, left])).toMatchObject({ matched: 2, missing: [], extra: [] });
  const mismatch = matchTruth([left, alcohol], [right, alcohol]);
  expect(mismatch.matched).toBe(1);
  expect(mismatch.missing).toHaveLength(1);
  expect(mismatch.extra).toHaveLength(1);
  expect(mismatch.categories).toEqual(["stereo"]);
  expect(left.tetrahedral[0].cip).not.toBe(right.tetrahedral[0].cip);
}, 30000);

it("reads independent SMILES, MOL and SDF truth sets and writes only safe aggregates to the report", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdx-truth-test-")); directories.push(root);
  const out = join(root, "out"), truth = join(root, "truth");
  await mkdir(join(out, "private"), { recursive: true }); await mkdir(truth);
  const m = await describeStructure("CO"), stereo = await describeStructure("C[C@H](O)C(=O)O");
  const row: Result = { id: "0123456789ab", group: "ungrouped", era: "unknown", format: "cdxml", size: 1, parseOk: true, status: "ok", warnings: [], timings: { totalMs: 1 }, roundTrips: [], summary: { molecules: [m, stereo], reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } } };
  await writeFile(join(out, "private", "results.jsonl"), `${JSON.stringify(row)}\n`);
  await writeFile(join(truth, `${row.id}.smi`), `${stereo.smiles}\nC || ${m.smiles}\n`);
  await installNodeRdkitModuleLoader();
  const engine = await ensureRdkit(), mol = engine.get_mol("CO")!;
  try {
    const block = mol.get_molblock!();
    await writeFile(join(truth, `${row.id}.mol`), block);
    await writeFile(join(truth, `${row.id}.sdf`), `${block}\n$$$$\n`);
  } finally { mol.delete(); }
  await groundTruth(out, truth);
  const rows = (await readFile(join(out, "private", "groundtruth.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(rows).toHaveLength(1);
  expect(rows[0].comparisons).toHaveLength(3);
  expect(rows[0].comparisons.find((r: { truthFormat: string }) => r.truthFormat === "smi")).toMatchObject({ status: "ok", matched: 2, missing: [], extra: [] });
  expect(rows[0].comparisons.find((r: { truthFormat: string }) => r.truthFormat === "mol")).toMatchObject({ status: "ok", matched: 1, missing: [] });
  expect(rows[0].comparisons.find((r: { truthFormat: string }) => r.truthFormat === "sdf")).toMatchObject({ status: "ok", matched: 1, missing: [] });
  const summary = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  expect(summary.groundTruth).toMatchObject({ total: 1, agreed: 0, matched: 1, extra: 1 });
  expect(await readFile(join(out, "report.md"), "utf8")).not.toContain(stereo.smiles);
}, 30000);

it("compares CDXML baseline IDs and distinguishes regressions and new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdx-baseline-test-")); directories.push(root);
  const out = join(root, "new"), old = join(root, "old");
  await mkdir(join(out, "private"), { recursive: true }); await mkdir(join(old, "private"), { recursive: true });
  const base: Result = { id: "aaaaaaaaaaaa", group: "ungrouped", era: "unknown", format: "cdxml", size: 1, parseOk: true, status: "ok", warnings: [], timings: { totalMs: 1 }, roundTrips: [{ route: "cdxml", verdict: "PASS", warnings: [], differences: [], drawingLoss: [], ms: 1 }] };
  await writeFile(join(old, "private", "results.jsonl"), `${JSON.stringify(base)}\n`);
  const changed = structuredClone(base); changed.roundTrips[0].verdict = "FAIL";
  await writeFile(join(out, "private", "results.jsonl"), `${JSON.stringify(changed)}\n${JSON.stringify({ ...base, id: "bbbbbbbbbbbb" })}\n`);
  await report(out, old);
  expect(JSON.parse(await readFile(join(out, "report.json"), "utf8")).cdxmlRegression).toMatchObject({ compared: 1, regressions: 1, newIds: 1 });
});

it("records private truth error reasons and counts their stage/category without leaking messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdx-truth-error-test-")); directories.push(root);
  const out = join(root, "out"), truth = join(root, "truth");
  await mkdir(join(out, "private"), { recursive: true }); await mkdir(truth);
  const row: Result = { id: "0123456789ab", group: "ungrouped", era: "unknown", format: "cdxml", size: 1, parseOk: true, status: "ok", warnings: [], timings: { totalMs: 1 }, roundTrips: [], summary: { molecules: [await describeStructure("CO")], reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } } };
  await writeFile(join(out, "private", "results.jsonl"), `${JSON.stringify(row)}\n`);
  await writeFile(join(truth, `${row.id}.smi`), "synthetic invalid structure");
  await groundTruth(out, truth);
  const result = JSON.parse(await readFile(join(out, "private", "groundtruth.jsonl"), "utf8"));
  expect(result).toMatchObject({ status: "error", error: { stage: "truth", code: "Error", category: "summary.rdkit_rejected", rdkitReason: "parse", message: expect.stringContaining("RDKit rejected") }, comparisons: [{ status: "error", error: { stage: "truth" } }] });
  expect(result.error.stack.length).toBeLessThanOrEqual(5);
  const json = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  expect(json.errorCounts).toEqual({ truth: { "summary.rdkit_rejected": 1 } });
  expect(json.rdkitErrors).toEqual({ parse: 1 });
  expect(JSON.stringify(json)).not.toMatch(/RDKit rejected|synthetic invalid|\.smi|stack/);
}, 30000);

it("reports strict and fallback rates and safe reason categories without private RDKit messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdx-reasons-test-")); directories.push(root);
  const out = join(root, "out");
  await mkdir(join(out, "private"), { recursive: true });
  const strict = await describeStructure("CO");
  const valence = await describeStructure("C(C)(C)(C)(C)C");
  const ring = await describeStructure("c1cccc1");
  expect(valence.sanitization?.message).toContain("Explicit valence");
  expect(ring.sanitization?.message).toContain("Unkekulized atoms");
  const summary = { molecules: [strict, valence, ring], reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } };
  const row: Result = { id: "0123456789ab", group: "ungrouped", era: "unknown", format: "cdxml", size: 1, parseOk: true, status: "ok", warnings: [], timings: { totalMs: 1 }, roundTrips: [{ route: "cdxml", verdict: "PASS", warnings: [], differences: [], drawingLoss: [], summary, ms: 1 }], summary };
  await writeFile(join(out, "private", "results.jsonl"), `${JSON.stringify(row)}\n`);
  await report(out);
  const json = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  expect(json.sanitization).toMatchObject({ total: 3, strict: 1, nonStrict: 2, strictRate: 1 / 3, nonStrictRate: 2 / 3, reasons: { "valence:C": 1, kekulize: 1 }, rdkitReasons: { "valence:C": 1, kekulize: 1 } });
  expect(json.roundTripSanitization).toEqual(json.sanitization);
  expect(json.byFormat.cdxml.pass).toBe(1);
  for (const name of ["report.json", "report.md"]) {
    const text = await readFile(join(out, name), "utf8");
    expect(text).not.toMatch(/Explicit valence|Unkekulized atoms|atom #|rdkitRejected|message|smiles|formula/i);
    expect(text).toContain("valence:C");
    expect(text).toContain("kekulize");
  }
}, 30000);
