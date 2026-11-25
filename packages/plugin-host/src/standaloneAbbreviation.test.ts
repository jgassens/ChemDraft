// The published plugin-host SDK bundles chem-core and nothing else of the app (scripts/build-sdk.mjs):
// no layout-engine, no label grammar. It must still refuse a hydrogen count stated on an abbreviation
// (OMe, Ph, CF3), because chem-core reads the abbreviation table itself. This file's module graph is
// the SDK's: its first test walks it and fails if anything in it reaches layout-engine, so the refusal
// below cannot pass because some import loaded the grammar.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, applyPatchWithHistory, createDocumentHistory, createEmptyDocument,
  type DocumentHistory, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import { ProposedDocumentPatchSchema, type PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { assertPluginPatchWriteScope, HydrogenCountUnrepresentableReason, PluginHost, PluginHostError,
  type PluginPatchApplicationRequest } from "./index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `file` as a repo-relative, forward-slash path. `pathSep` is passed in so Windows forms can be checked on any host. */
function toRepoRelative(file: string, root: string, pathSep: string): string {
  const forward = (value: string): string => {
    let out = value.replace(/^file:\/\/\/?(?=[A-Za-z]:|\/)/i, "");
    if (/^file:\/\//i.test(value) && /^[A-Za-z]:/.test(out) === false && out.startsWith("/") === false) out = `/${out}`;
    if (pathSep === "\\" || /^[A-Za-z]:[\\/]/.test(out)) out = out.split("\\").join("/");
    return out.replace(/\/+$/, "");
  };
  const f = forward(file);
  const r = forward(root);
  const windows = /^[A-Za-z]:/.test(r);
  const lower = (value: string): string => (windows ? value.toLowerCase() : value);
  if (lower(f) === lower(r)) return "";
  if (lower(f).startsWith(`${lower(r)}/`)) return f.slice(r.length + 1);
  return f;
}

/** Every source file reachable from `entry` by any import (type-only included), and every bare specifier. */
function moduleGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const resolveFile = (base: string): string | undefined =>
    [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      let target: string | undefined;
      if (specifier.startsWith(".")) {
        target = resolveFile(resolve(dirname(file), specifier));
      } else if (specifier.startsWith("@chemdraft/")) {
        bare.add(specifier);
        const [, name, ...subpath] = specifier.split("/");
        target = resolveFile(join(repoRoot, "packages", name!, "src", subpath.length > 0 ? subpath.join("/") : "index"));
        expect(target, `${specifier} (imported by ${toRepoRelative(file, repoRoot, sep)}) resolves to a source file`).toBeDefined();
      } else {
        bare.add(specifier);
      }
      if (target !== undefined && !toRepoRelative(target, repoRoot, sep).split("/").includes("node_modules")) pending.push(target);
    }
  }
  return { files, bare };
}

const now = "2026-11-23T00:00:00.000Z";
const snapshot = (objectIds: string[]): PluginSelectionSnapshot => ({ objectIds, molecules: [] });
/** Atom "g" is typed (`labelLiteral`) when `typed`, and bonded to a2 unless `bonded` is false. */
const molecule = (element: string, { typed = false, bonded = true } = {}): MoleculeObject => ({
  id: "mol_1", type: "molecule", x: 110, y: 120, width: 30, height: 20, rotation: 0, style: {},
  structureFormat: "smiles", structure: "CC",
  atoms: [{ id: "a1", element: "C", x: 110, y: 120, formalCharge: 0 },
    { id: "a2", element: "C", x: 140, y: 120, formalCharge: 0 },
    { id: "g", element, x: 160, y: 120, formalCharge: 0, ...(typed ? { labelLiteral: true } : {}) }],
  bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
    ...(bonded ? [{ id: "bg", fromAtomId: "a2", toAtomId: "g", order: "single" as const }] : [])],
  superatoms: [], rGroups: []
});

/** A host over a one-molecule document with undo history, and a command writing `hydrogenCount` on atom "g"
 * (`undefined` omits it). With `bondInPatch`, "g" starts unbonded and the write also adds bond a2-g:
 * in the same updateObject ("same"), or in a second updateObject of the same batch ("next"). */
function hostSettingCount(element: string, hydrogenCount: number | undefined,
  options?: { typed?: boolean; bonded?: boolean; bondInPatch?: "same" | "next" }) {
  const subject = molecule(element, options?.bondInPatch ? { ...options, bonded: false } : options);
  let history: DocumentHistory = createDocumentHistory(applyPatch(createEmptyDocument({ now }),
    { op: "addObject", pageId: "page_001", object: subject }, { now }));
  history = { ...history, present: { ...history.present, selection: { pageId: "page_001", objectIds: [subject.id] } } };
  const original = history;
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    history = applyPatchWithHistory(history, request.patch.patch as DocumentPatch);
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => history.present, getSelection: () => snapshot([subject.id]), applyDocumentPatch });
  const atoms = subject.atoms.map(atom => atom.id === "g" && hydrogenCount !== undefined ? { ...atom, hydrogenCount } : atom);
  const bonds = options?.bondInPatch ? molecule(element, { ...options, bonded: true }).bonds : undefined;
  const patch = options?.bondInPatch === "same" ? { op: "updateObject" as const, objectId: subject.id, changes: { atoms, bonds } }
    : options?.bondInPatch === "next" ? { op: "batch" as const, patches: [
      { op: "updateObject" as const, objectId: subject.id, changes: { atoms } },
      { op: "updateObject" as const, objectId: subject.id, changes: { bonds } }] }
    : { op: "updateObject" as const, objectId: subject.id, changes: { atoms } };
  host.registerPlugin({ id: "org.test.standalone", name: "Standalone count", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.standalone.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.standalone.run": ctx => ctx.documents.applyPatch!({ reason: "count", patch }) } });
  return { host, applyDocumentPatch, original, history: () => history };
}

describe("toRepoRelative", () => {
  it.each([
    ["D:\\a\\repo\\packages\\layout-engine\\src\\index.ts", "D:\\a\\repo", "\\"],
    ["d:\\a\\repo\\packages\\layout-engine\\src\\index.ts", "D:\\a\\repo\\", "\\"],
    ["file:///D:/a/repo/packages/layout-engine/src/index.ts", "D:\\a\\repo", "\\"],
    ["/home/r/repo/packages/layout-engine/src/index.ts", "/home/r/repo", "/"]
  ])("turns %s into a repo-relative forward-slash path", (file, root, pathSep) => {
    expect(toRepoRelative(file, root, pathSep)).toBe("packages/layout-engine/src/index.ts");
  });
});

describe("the plugin host without layout-engine (the published SDK)", () => {
  it("loads no layout-engine anywhere in this test's module graph, and does reach the abbreviation table", () => {
    const { files, bare } = moduleGraph(fileURLToPath(import.meta.url));
    const reached = [...files].map(file => toRepoRelative(file, repoRoot, sep));
    expect(reached.filter(file => file.startsWith("packages/layout-engine/"))).toEqual([]);
    expect([...bare].filter(specifier => specifier.startsWith("@chemdraft/layout-engine"))).toEqual([]);
    expect(reached).toContain("packages/plugin-host/src/index.ts");
    expect(reached).toContain("packages/chem-core/src/abbreviationLabels.ts");
    expect(reached).toContain("packages/template-library/src/abbreviations.ts");
  });

  it("refuses hydrogenCount 1 on OMe with hydrogen_count_unrepresentable, leaving the document and its undo history as they were", async () => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount("OMe", 1);
    const refused = await host.invokeCommand("plugin.standalone.run").then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginHostError);
    expect(refused).toMatchObject({
      message: 'Plugin write refused: atom "g" of molecule "mol_1" is OMe with hydrogenCount 1, which nothing would count: an abbreviation\'s ' +
        "hydrogens come from what it stands for. Only 0 is allowed on an abbreviation (OMe); omit hydrogenCount or set it to 0. Nothing was changed.",
      reason: HydrogenCountUnrepresentableReason,
      details: { moleculeId: "mol_1", atomId: "g", element: "OMe", hydrogenCount: 1 }
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
    expect(history().past).toHaveLength(0);
    expect(history().future).toHaveLength(0);
  });

  it.each([["Ph", 2], ["CF3", 1], ["Me", 3], ["MeO", 1]] as const)("refuses %s stating %i as an abbreviation", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount);
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { element, hydrogenCount },
      message: expect.stringContaining(`Only 0 is allowed on an abbreviation (${element})`)
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // A typed "Ac", "Pr" or "Ts" on a bond is acetyl, n-propyl or tosyl to the label grammar, and its
  // hydrogens come from the group, so a stated count is refused as on OMe. chem-core reads the
  // table's bonded spellings itself, so the SDK (no layout-engine) refuses it too.
  it.each([["Ac", 2], ["Pr", 1], ["Ts", 3]] as const)("refuses a typed %s on a bond stating %i as an abbreviation", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount, { typed: true });
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element, hydrogenCount },
      message: `Plugin write refused: atom "g" of molecule "mol_1" is ${element} with hydrogenCount ${hydrogenCount}, which nothing would ` +
        `count: an abbreviation's hydrogens come from what it stands for. Only 0 is allowed on an abbreviation (${element}); omit ` +
        "hydrogenCount or set it to 0. Nothing was changed."
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // Unbonded, or not typed (read from a structure file), it is actinium, praseodymium or tennessine,
  // as before; 0 on the bonded group is what it counts anyway. Typed and unbonded, its label text
  // gives it 0 H, so 0 is accepted and any other count is refused (below).
  it.each([
    ["Ac", 0, { typed: true, bonded: false }], ["Pr", 0, { typed: true, bonded: false }], ["Ts", 0, { typed: true, bonded: false }],
    ["Ac", 2, { typed: false, bonded: true }], ["Ts", 0, { typed: true, bonded: true }]
  ] as const)("accepts %s stating %i when %o", async (element, hydrogenCount, options) => {
    const { host, applyDocumentPatch, history } = hostSettingCount(element, hydrogenCount, options);
    await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
    const written = history().present.pages[0]!.objects.find(object => object.id === "mol_1");
    expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBe(hydrogenCount);
  });

  // A typed, unbonded Ac, Pr or Ts is the element, and its label text says its hydrogens (none): the
  // label, formula and molfile read the text, so a stated count other than 0 would be dropped silently.
  it.each([["Ac", 2], ["Pr", 1], ["Ts", 3]] as const)("refuses a typed unbonded %s stating %i, naming the label", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount, { typed: true, bonded: false });
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason,
      details: { moleculeId: "mol_1", atomId: "g", element, hydrogenCount, labelHydrogenCount: 0 },
      message: `Plugin write refused: atom "g" of molecule "mol_1" has label "${element}", which ChemDraft reads as its own hydrogen ` +
        `count (0 H from the label text), but the write states hydrogenCount ${hydrogenCount}. Remove the count (or state 0), or ` +
        "write the element without the literal label. Nothing was changed."
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // The patch engine drops the count of an atom whose bonds change, so a write that bonds an unbonded
  // typed Ac, Pr or Ts (the element, which may carry a count) and states a count on it would commit the
  // group with the stated count silently gone. The host checks the count the patch asked for instead.
  it.each([
    ["Ac", 2, "same"], ["Pr", 1, "same"], ["Ts", 3, "same"], ["Ac", 2, "next"]
  ] as const)("refuses bonding a typed %s stating %i (bond in the %s update)", async (element, hydrogenCount, bondInPatch) => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount, { typed: true, bondInPatch });
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element, hydrogenCount },
      message: `Plugin write refused: atom "g" of molecule "mol_1" is ${element} with hydrogenCount ${hydrogenCount}, which nothing would ` +
        `count: an abbreviation's hydrogens come from what it stands for. Only 0 is allowed on an abbreviation (${element}); omit ` +
        "hydrogenCount or set it to 0. Nothing was changed."
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // 0 or no count on the group is what it counts anyway.
  it.each([
    ["Ac", 0], ["Pr", undefined], ["Ts", 0]
  ] as const)("accepts bonding a typed %s stating %s", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, history } = hostSettingCount(element, hydrogenCount, { typed: true, bondInPatch: "same" });
    await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
    const written = history().present.pages[0]!.objects.find(object => object.id === "mol_1");
    expect(written?.type === "molecule" && written.bonds.map(bond => bond.id)).toEqual(["b1", "bg"]);
  });

  // A count stated on an element atom the same write bonds is dropped by the patch engine too, so the
  // stated count would be lost without a word: refused, wherever in the batch the bond comes. (A plain
  // element C: on a typed C the label text decides, and the refusal says that instead, below.)
  it.each([["same"], ["next"]] as const)("refuses bonding a C stating 2 (bond in the %s update)", async bondInPatch => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount("C", 2, { typed: false, bondInPatch });
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element: "C", hydrogenCount: 2 },
      message: 'Plugin write refused: atom "g" of molecule "mol_1" is C with hydrogenCount 2, which the written molecule would not ' +
        "keep: a change to an atom's bonds, or to what the atom is, drops its stated count. State the count in a later update, once " +
        "that change is made, or omit hydrogenCount. Nothing was changed."
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // A typed C's label text gives it 0 H whatever its bonds, so a count stated on it is refused as such,
  // not as one the bond change drops: no later update could state it either.
  it.each([["same"], ["next"]] as const)("refuses bonding a typed C stating 2 (bond in the %s update), naming the label", async bondInPatch => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount("C", 2, { typed: true, bondInPatch });
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason,
      details: { moleculeId: "mol_1", atomId: "g", element: "C", hydrogenCount: 2, labelHydrogenCount: 0 },
      message: expect.stringContaining('atom "g" of molecule "mol_1" has label "C", which ChemDraft reads as its own hydrogen count')
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // As the refusal says: the count stated in an update after the one that bonds the atom is kept.
  it("accepts a count on an element atom stated in an update after the one that bonds it", async () => {
    const subject = molecule("C", { typed: false, bonded: false });
    const bonded = molecule("C", { typed: false, bonded: true });
    const atoms = bonded.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount: 2 } : atom);
    const { host, history } = hostOver([[subject]], [subject.id], { op: "batch", patches: [
      { op: "updateObject", objectId: subject.id, changes: { bonds: bonded.bonds } },
      { op: "updateObject", objectId: subject.id, changes: { atoms } }] });
    await expect(host.invokeCommand("plugin.over.run")).resolves.toMatchObject({ applied: true });
    const written = history().present.pages[0]!.objects[0];
    expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBe(2);
  });

  // A count a molecule already held, which nothing reads (typed Ac on a bond: acetyl), is let be for
  // edits elsewhere, but never stands in for a count the write states again and the engine drops: here
  // the write moves g's bond from a2 to a1, which clears g's count, while restating 2.
  it("refuses restating a held count on a bonded typed Ac whose bond the same write moves", async () => {
    const held = withCount(molecule("Ac", { typed: true }), 2);
    const moved = held.bonds.map(bond => bond.id === "bg" ? { ...bond, fromAtomId: "a1" } : bond);
    const { host, applyDocumentPatch, original, history } = hostOver([[held]], [held.id],
      { op: "updateObject", objectId: held.id, changes: { atoms: held.atoms, bonds: moved } });
    await expect(host.invokeCommand("plugin.over.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element: "Ac", hydrogenCount: 2 },
      message: expect.stringContaining("Only 0 is allowed on an abbreviation (Ac)")
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  // Two pages may share an id, each holding an object "mol_1". The write removes the first (a bonded
  // typed Ac holding 2), then bonds the second (an unbonded typed Ac) while stating 2, which the
  // engine drops. The removed molecule's held count must not excuse the second's lost one. (A plugin
  // command's pins already refuse this batch as ambiguous; the preflight itself must refuse it too,
  // as an unpinned caller of it relies on.)
  it("refuses a dropped count on a molecule whose page id and object id a removed molecule shared", () => {
    const removed = withCount(molecule("Ac", { typed: true }), 2);
    const subject = molecule("Ac", { typed: true, bonded: false });
    const atoms = subject.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount: 2 } : atom);
    const empty = createEmptyDocument({ now });
    const document = { ...empty, pages: [{ ...empty.pages[0]!, objects: [removed] }, { ...empty.pages[0]!, objects: [subject] }] };
    const proposed = ProposedDocumentPatchSchema.parse({ reason: "count", patch: { op: "batch", patches: [
      { op: "removeObject", objectId: subject.id },
      { op: "updateObject", objectId: subject.id, changes: { atoms, bonds: molecule("Ac").bonds } }] } });
    let refused: unknown;
    try {
      assertPluginPatchWriteScope(document, proposed, [subject.id]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PluginHostError);
    expect(refused).toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element: "Ac", hydrogenCount: 2 }
    });
  });

  // Restating a count the atom keeps (no bond or label change) is accepted, held before or not.
  it.each([["held before", 2], ["not held before", undefined]] as const)(
    "accepts restating hydrogenCount 2 on an untouched bonded element C (%s)", async (_case, before) => {
      const subject = before === undefined ? molecule("C") : withCount(molecule("C"), before);
      const atoms = subject.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount: 2 } : atom.id === "a1" ? { ...atom, x: atom.x - 5 } : atom);
      const { host, applyDocumentPatch, history } = hostOver([[subject]], [subject.id],
        { op: "updateObject", objectId: subject.id, changes: { atoms } });
      await expect(host.invokeCommand("plugin.over.run")).resolves.toMatchObject({ applied: true });
      expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
      const written = history().present.pages[0]!.objects[0];
      expect(written?.type === "molecule" && written.atoms.map(atom => [atom.id, atom.x, atom.hydrogenCount]))
        .toEqual([["a1", 105, undefined], ["a2", 140, undefined], ["g", 160, 2]]);
    });

  // A document may repeat an object id. A count asked for is checked on the object the write reached
  // (chem-core updates an id's first occurrence), never on an untouched molecule that shares its id
  // and atom ids.
  it("accepts hydrogenCount 2 on a bonded elemental Ac whose id a typed acetyl molecule also has", async () => {
    const { host, applyDocumentPatch, history } = hostWithRepeatedId("elemental first");
    await expect(host.invokeCommand("plugin.repeated.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
    const [written, untouched] = history().present.pages[0]!.objects;
    expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")).toMatchObject({ element: "Ac", hydrogenCount: 2 });
    expect(untouched?.type === "molecule" && untouched.atoms.find(atom => atom.id === "g")).toMatchObject({ element: "Ac", labelLiteral: true });
    expect(untouched?.type === "molecule" && untouched.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBeUndefined();
  });

  it("refuses hydrogenCount 2 on a bonded typed acetyl whose id an elemental Ac molecule also has", async () => {
    const { host, applyDocumentPatch, original, history } = hostWithRepeatedId("typed first");
    await expect(host.invokeCommand("plugin.repeated.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { moleculeId: "mol_1", atomId: "g", element: "Ac", hydrogenCount: 2 }
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  it.each([["OMe", 0], ["NHMe", 1], ["CH3", 3], ["O", 1]] as const)("accepts %s stating %i", async (element, hydrogenCount) => {
    const { host, applyDocumentPatch, history } = hostSettingCount(element, hydrogenCount);
    await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
    const written = history().present.pages[0]!.objects.find(object => object.id === "mol_1");
    expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBe(hydrogenCount);
  });

  // A typed literal label says its own hydrogens ("C" none, "CH3" three), and the label, formula and
  // molfile read the text, never a stated count. A write stating another count is refused, naming the
  // atom, the label and the count; one stating exactly what the text gives is accepted. No grammar
  // needed: this file's module graph has no layout-engine.
  it("refuses a typed C stating hydrogenCount 3, naming the atom, its label and the count, and changes nothing", async () => {
    const { host, applyDocumentPatch, original, history } = hostSettingCount("C", 3, { typed: true });
    const refused = await host.invokeCommand("plugin.standalone.run").then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginHostError);
    expect(refused).toMatchObject({
      message: 'Plugin write refused: atom "g" of molecule "mol_1" has label "C", which ChemDraft reads as its own hydrogen count ' +
        "(0 H from the label text), but the write states hydrogenCount 3. Remove the count (or state 0), or write the element " +
        "without the literal label. Nothing was changed.",
      reason: HydrogenCountUnrepresentableReason,
      details: { moleculeId: "mol_1", atomId: "g", element: "C", hydrogenCount: 3, labelHydrogenCount: 0 }
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    expect(history()).toBe(original);
  });

  it.each([["CH3", 2, 3], ["CH3", 0, 3], ["CH", 2, 1], ["NH2", 1, 2], ["OH", 0, 1], ["Cl", 1, 0]] as const)(
    "refuses a typed %s stating %i (its text gives %i)", async (element, hydrogenCount, labelHydrogenCount) => {
      const { host, applyDocumentPatch, original, history } = hostSettingCount(element, hydrogenCount, { typed: true });
      await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
        reason: HydrogenCountUnrepresentableReason, details: { atomId: "g", element, hydrogenCount, labelHydrogenCount },
        message: expect.stringContaining(`has label "${element}"`)
      });
      expect(applyDocumentPatch).not.toHaveBeenCalled();
      expect(history()).toBe(original);
    });

  // An untyped label that is not an element symbol but names one ("NH2") is read from its text too.
  it("refuses an untyped NH2 label stating 1", async () => {
    const { host, applyDocumentPatch } = hostSettingCount("NH2", 1);
    await expect(host.invokeCommand("plugin.standalone.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { atomId: "g", element: "NH2", hydrogenCount: 1, labelHydrogenCount: 2 }
    });
    expect(applyDocumentPatch).not.toHaveBeenCalled();
  });

  it.each([["C", 0], ["CH", 1], ["CH2", 2], ["CH3", 3], ["NH2", 2], ["OH", 1], ["Cl", 0]] as const)(
    "accepts a typed %s stating %i, what its text gives", async (element, hydrogenCount) => {
      const { host, applyDocumentPatch, history } = hostSettingCount(element, hydrogenCount, { typed: true });
      await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
      expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
      const written = history().present.pages[0]!.objects.find(object => object.id === "mol_1");
      expect(written?.type === "molecule" && written.atoms.find(atom => atom.id === "g")?.hydrogenCount).toBe(hydrogenCount);
    });

  // A group label this host does not read as one element and its hydrogens (and no abbreviation) is
  // let be, as before.
  it("accepts a typed group label NHMe stating 2, which it does not judge", async () => {
    const { host } = hostSettingCount("NHMe", 2, { typed: true });
    await expect(host.invokeCommand("plugin.standalone.run")).resolves.toMatchObject({ applied: true });
  });

  // A count the molecule already held on the same typed label (a CDXML literal label keeps its source
  // NumHydrogens) is let be for an edit elsewhere, as an ignored count is; restating another is refused.
  it("lets a held typed C count be for an edit elsewhere, and refuses changing it to another overridden count", async () => {
    const held = withCount(molecule("C", { typed: true }), 2);
    const moved = held.atoms.map(atom => atom.id === "a1" ? { ...atom, x: atom.x - 5 } : atom);
    const edit = hostOver([[held]], [held.id], { op: "updateObject", objectId: held.id, changes: { atoms: moved } });
    await expect(edit.host.invokeCommand("plugin.over.run")).resolves.toMatchObject({ applied: true });
    const restated = held.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount: 1 } : atom);
    const change = hostOver([[held]], [held.id], { op: "updateObject", objectId: held.id, changes: { atoms: restated } });
    await expect(change.host.invokeCommand("plugin.over.run")).rejects.toMatchObject({
      reason: HydrogenCountUnrepresentableReason, details: { atomId: "g", element: "C", hydrogenCount: 1, labelHydrogenCount: 0 }
    });
    expect(change.applyDocumentPatch).not.toHaveBeenCalled();
    expect(change.history()).toBe(change.original);
  });
});

const withCount = (subject: MoleculeObject, hydrogenCount: number): MoleculeObject =>
  ({ ...subject, atoms: subject.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount } : atom) });

/** A host over a document whose pages (all with the id "page_001") hold `pages`' objects, with undo
 * history, `selected` selected on the first page, and a command ("plugin.over.run") writing `patch`. */
function hostOver(pages: MoleculeObject[][], selected: string[], patch: DocumentPatch) {
  const empty = createEmptyDocument({ now });
  const document = { ...empty, pages: pages.map(objects => ({ ...empty.pages[0]!, objects })),
    selection: { pageId: empty.pages[0]!.id, objectIds: selected } };
  let history: DocumentHistory = createDocumentHistory(document);
  const original = history;
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    history = applyPatchWithHistory(history, request.patch.patch as DocumentPatch);
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => history.present, getSelection: () => snapshot(selected), applyDocumentPatch });
  host.registerPlugin({ id: "org.test.over", name: "Count over a document", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.over.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.over.run": ctx => ctx.documents.applyPatch!({ reason: "count", patch }) } });
  return { host, applyDocumentPatch, original, history: () => history };
}

/** A host over a document holding two molecules with the same id ("mol_1") and the same atom ids, both
 * bonded at "g": one an elemental Ac (not typed), one a typed acetyl. `order` says which comes first,
 * the one an updateObject of "mol_1" reaches. The command writes hydrogenCount 2 on "g" of the first. */
function hostWithRepeatedId(order: "elemental first" | "typed first") {
  const elemental = molecule("Ac");
  const typed = molecule("Ac", { typed: true });
  const [first, second] = order === "elemental first" ? [elemental, typed] : [typed, elemental];
  const empty = createEmptyDocument({ now });
  const document = { ...empty, pages: [{ ...empty.pages[0]!, objects: [first, second] }],
    selection: { pageId: empty.pages[0]!.id, objectIds: [first.id] } };
  let history: DocumentHistory = createDocumentHistory(document);
  const original = history;
  const applyDocumentPatch = vi.fn((request: PluginPatchApplicationRequest) => {
    history = applyPatchWithHistory(history, request.patch.patch as DocumentPatch);
    return { applied: true as const, objectIds: [] };
  });
  const host = new PluginHost({ getActiveDocument: () => history.present, getSelection: () => snapshot([first.id]), applyDocumentPatch });
  const atoms = first.atoms.map(atom => atom.id === "g" ? { ...atom, hydrogenCount: 2 } : atom);
  const patch = { op: "updateObject" as const, objectId: first.id, changes: { atoms } };
  host.registerPlugin({ id: "org.test.repeated", name: "Repeated id count", version: "0.0.1", apiVersion: "^0.1.8", entry: "plugin.js",
    permissions: ["document.write"], contributes: { commands: [{ id: "plugin.repeated.run", title: "Run" }] }
  }, { commandHandlers: { "plugin.repeated.run": ctx => ctx.documents.applyPatch!({ reason: "count", patch }) } });
  return { host, applyDocumentPatch, original, history: () => history };
}
