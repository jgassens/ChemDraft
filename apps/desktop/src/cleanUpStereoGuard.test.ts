// Clean Up 2D stereo guard (1.2.4 stopgap). The polygon-and-tree layout used for molecules
// without a fused ring system can hand back another stereoisomer; the guard keeps any molecule
// whose CIP reading would change exactly as drawn. Each molecule is pasted as SMILES the way the
// desktop paste does it, cleaned up, and run through MainWindow's commit funnel; what the app
// writes for it (RDKit isomeric canonical SMILES of the drawn graph, and the formula) is compared
// before and after. Harness adapted from the 2026-11-25 silent-chemistry sweep.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { insertSmilesMolecule, moleculeSmiles, nativeSingleBondGraphMetadata, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import * as ocl from "@chemdraft/ocl-adapter";
import { generateSmiles2DMolfile, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import * as w from "./documentWorkflow";
import { PRESERVE_CHEMISTRY, policyChemistryRefusals } from "./commitChemistryGuard";
import { cleanUpStereoRefusal, cleanUpStereoSignature, cleanUpStereoSkipStatus, sameCleanUpStereo, type CleanUpStereoRefusal } from "./cleanUpStereoGuard";
import type { StereoEngine } from "./stereoReadout";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

const engine: StereoEngine = ocl;
type Skipped = { objectId: string; reason: CleanUpStereoRefusal }[];

const moleculesOf = (d: ChemDraftDocument) => d.pages[0]!.objects.filter((o): o is MoleculeObject => o.type === "molecule");
const last = (d: ChemDraftDocument) => moleculesOf(d).at(-1)!;
const byId = (d: ChemDraftDocument, id: string) => moleculesOf(d).find(m => m.id === id)!;
const coordinates = (m: MoleculeObject) => JSON.stringify(m.atoms.map(a => [a.id, a.x, a.y]));

/** MainWindow `prepareDocumentCommit` + `commitChemistryRefusal`. */
function committed(before: ChemDraftDocument, next: ChemDraftDocument): ChemDraftDocument {
  const after = w.normalizeCommittedDocument(w.carryElectronMarksWithMovedAtoms(before, next, PRESERVE_CHEMISTRY));
  expect(policyChemistryRefusals(PRESERVE_CHEMISTRY, { before, next, after, normalize: w.committedNormalForm, markAtoms: w.committedElectronMarkAtoms })).toEqual([]);
  return after;
}
/** What Copy As SMILES writes for the molecule, and its formula. */
async function written(m: MoleculeObject): Promise<string> {
  const smiles = await moleculeSmiles(m, 0, [] as never, computeStructureIdentifiers);
  return `${smiles} ${nativeSingleBondGraphMetadata(m.atoms, m.bonds).formula}`;
}
/** The desktop SMILES paste, optionally into an existing document. */
async function drawn(smiles: string, into = w.createPhase4Document("t"), at = { x: 300, y: 300 }): Promise<{ d: ChemDraftDocument; m: MoleculeObject }> {
  const depiction = pastedStructureDepictionFromMolfile(await generateSmiles2DMolfile(smiles));
  const d = w.normalizeCommittedDocument(insertSmilesMolecule(into, at, depiction, smiles, w.SMILES_PASTE_OPTIONS));
  return { d, m: last(d) };
}
/** Clean Up 2D with the guard, as MainWindow runs it. */
function guardedCleanUp(d: ChemDraftDocument, ids: readonly string[], stereoEngine: StereoEngine = engine) {
  const skipped: Skipped = [];
  return { document: w.cleanUpNativeMolecules2d(d, ids, { stereoEngine, skipped }), skipped };
}
/** Nudge every atom so an already tidy paste has something to clean up. Deterministic. */
function scuffed(d: ChemDraftDocument, id: string): ChemDraftDocument {
  return {
    ...d,
    pages: d.pages.map(page => ({
      ...page,
      objects: page.objects.map(o => o.type === "molecule" && o.id === id
        ? { ...o, atoms: o.atoms.map((a, i) => ({ ...a, x: a.x + ((i * 7) % 5) - 2, y: a.y + ((i * 11) % 7) - 3 })) }
        : o)
    }))
  };
}
function countingEngine() {
  const calls = { count: 0 };
  const counted: StereoEngine = {
    perceiveStereoCentersFromMolfile: ((molfile: string) => { calls.count++; return ocl.perceiveStereoCentersFromMolfile(molfile); }) as StereoEngine["perceiveStereoCentersFromMolfile"],
    perceiveDoubleBondStereoFromMolfile: ((molfile: string) => { calls.count++; return ocl.perceiveDoubleBondStereoFromMolfile(molfile); }) as StereoEngine["perceiveDoubleBondStereoFromMolfile"]
  };
  return { calls, counted };
}

// The 16 recorded flips from the 2026-11-25 sweep (glucose, menthol, a sulfoxide, 1-phenylethanol,
// ibuprofen, cinnamic acid, an imine, an oxime ...). Whether a molecule breaks depends on how the
// paste happens to draw it.
const CLEAN_UP_BREAKS = ["O[C@H]1[C@H](O)[C@@H](O)[C@H](O)[C@H](CO)O1", "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O", "C[S@](=O)c1ccccc1", "C[C@@H](O)c1ccccc1", "C[C@H](O)c1ccccc1", "C[C@H]1CCCCO1", "C[C@H](N)c1ccccc1",
  "C[C@H](O)c1ccncc1", "CC(C)Cc1ccc(cc1)[C@H](C)C(=O)O", "C[C@@H](C(=O)O)c1ccc(cc1)CC(C)C", "O=C(O)/C=C/c1ccccc1", "C/N=C/c1ccccc1", "C1=C/CCCCCC/1", "C/C=C/c1ccccc1", "CC/C=C/C1CCCCC1", "O/N=C/c1ccccc1"];

// Common stereo molecules with at most one ring per component (so Clean Up 2D takes the
// polygon-and-tree route), drawn as pasted SMILES.
const COMMON_STEREO = [
  // amino acids
  "C[C@H](N)C(=O)O", "C[C@@H](N)C(=O)O", "N[C@@H](CO)C(=O)O", "C[C@@H](O)[C@H](N)C(=O)O", "CC(C)[C@H](N)C(=O)O", "CC(C)C[C@H](N)C(=O)O",
  "CC[C@H](C)[C@H](N)C(=O)O", "N[C@@H](Cc1ccccc1)C(=O)O", "N[C@@H](CS)C(=O)O", "CSCC[C@H](N)C(=O)O", "N[C@@H](CC(=O)O)C(=O)O", "N[C@@H](CCC(=O)O)C(=O)O",
  "NCCCC[C@H](N)C(=O)O", "OC(=O)[C@@H]1CCCN1", "N[C@@H](Cc1ccc(O)cc1)C(=O)O", "NC(=O)CC[C@H](N)C(=O)O", "NC(=N)NCCC[C@H](N)C(=O)O",
  // sugars and hydroxy acids
  "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O", "OC[C@@H](O)[C@@H](O)[C@H](O)[C@@H](O)C=O", "OC[C@@H](O)[C@@H](O)[C@@H](O)C=O", "OC[C@@H](O)C=O",
  "OC[C@H]1O[C@@](O)(CO)[C@@H](O)[C@@H]1O", "OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@H]1O", "OC[C@H]1O[C@H](O)[C@@H](O)[C@@H](O)[C@@H]1O", "OC[C@H]1OC(O)C[C@@H]1O",
  "C[C@H](O)C(=O)O", "O[C@@H](CC(=O)O)C(=O)O", "O[C@H]([C@@H](O)C(=O)O)C(=O)O", "C[C@@H](O)CC(=O)O", "OC[C@H](O)[C@H]1OC(=O)C(O)=C1O",
  // terpenes
  "C=C(C)[C@@H]1CC=C(C)CC1", "CC1=CC[C@@H](CC1=O)C(C)=C", "CC(C)=CCC[C@@H](C)CCO", "CC(C)=CCC/C(C)=C/CO", "CC(C)=CCC/C(C)=C\\CO", "C=C[C@](C)(O)CCC=C(C)C",
  "CC1=CC[C@H](CC1)C(C)(C)O", "CC(C)[C@@H]1CC[C@@H](C)CC1=O", "CC(C)=CCC/C(C)=C/CC/C(C)=C/CO", "CC(C)=CCC[C@@H](C)CC=O", "CC1=C(C(C)(C)CCC1)/C=C/C(C)=O",
  // profens and other benzylic centers
  "C[C@H](C(=O)O)c1ccccc1", "C[C@@H](C(=O)O)c1ccccc1", "O[C@@H](C(=O)O)c1ccccc1", "C[C@H](N)Cc1ccccc1", "C[C@H](NC)[C@@H](O)c1ccccc1", "C[C@H](NC)[C@H](O)c1ccccc1",
  // E/Z alkenes
  "C/C=C/C", "C/C=C\\C", "C/C=C\\C(=O)O", "C/C=C/C(=O)O", "F/C=C/F", "Cl/C=C\\Cl", "CC/C=C/CC", "O=C/C=C/c1ccccc1", "COC(=O)/C=C/c1ccccc1",
  "C/C=C(\\C)C(=O)O", "C/C=C(/C)C(=O)O", "OC(=O)/C=C/C(=O)O", "OC(=O)/C=C\\C(=O)O", "CCC/C=C/C=O", "C/C=C/C=C/C(=O)O", "C/C=C\\c1ccccc1",
  // imines, oximes, hydrazones
  "C/N=C\\c1ccccc1", "O/N=C\\c1ccccc1", "C/C=N/O", "C/C=N\\O", "CC/C(C)=N/O", "C/C=N/N",
  // sulfoxides and other heteroatom centers
  "C[S@@](=O)c1ccccc1", "CC[S@](=O)CC1CC1", "Cc1ccc(cc1)[S@@](=O)C", "C[S@@](=O)CCCCN=C=S", "C[P@](=O)(OC)c1ccccc1",
  // small aliphatic centers and rings
  "CC[C@H](C)O", "C[C@@H]1CCCCC1=O", "ClC[C@@H]1CO1", "C[C@H]1CO1", "C[C@H]1CCCC[C@@H]1C", "C[C@H]1CCCC[C@H]1C", "F[C@H](Cl)Br",
  "C[N+](C)(C)C[C@@H](O)CC(=O)[O-]", "CC[C@@H](C)Cl"
];
const STEREO_SET = [...new Set([...CLEAN_UP_BREAKS, ...COMMON_STEREO])];

const NON_STEREO = ["CCO", "CCCCCC", "OC(=O)c1ccccc1", "OC1CCCCC1", "Cc1ccccc1", "CC(=O)c1ccccc1", "Nc1ccccc1", "c1ccncc1", "CCCC(=O)O", "CC(C)CO"];

describe("Clean Up 2D stereo guard", () => {
  it("refuses every recorded flip and leaves each molecule exactly as drawn", async () => {
    for (const smiles of CLEAN_UP_BREAKS) {
      const { d, m } = await drawn(smiles);
      expect(w.moleculeHasFusedRingSystem(m), smiles).toBe(false);
      const before = await written(m);
      // The unguarded layout really does hand back another stereoisomer for this drawing.
      const unguarded = w.cleanUpNativeMolecules2d(d, [m.id]);
      expect(await written(last(committed(d, unguarded))), `${smiles} breaks without the guard`).not.toBe(before);

      const { document, skipped } = guardedCleanUp(d, [m.id]);
      expect(skipped, smiles).toEqual([{ objectId: m.id, reason: "changed" }]);
      expect(document, smiles).toBe(d);
      const after = byId(committed(d, document), m.id);
      expect(coordinates(after), smiles).toBe(coordinates(m));
      expect(await written(after), smiles).toBe(before);
    }
  }, 120000);

  it("never changes the stereochemistry of any of about 80 common stereo molecules", async () => {
    expect(STEREO_SET.length).toBeGreaterThanOrEqual(80);
    let cleaned = 0;
    const refused: string[] = [];
    for (const smiles of STEREO_SET) {
      const { d, m } = await drawn(smiles);
      expect(w.moleculeHasFusedRingSystem(m), smiles).toBe(false);
      expect(w.cleanUpMayChangeStereo(m), `${smiles} has stereo the guard must see`).toBe(true);
      const before = await written(m);
      const { document, skipped } = guardedCleanUp(d, [m.id]);
      const after = byId(committed(d, document), m.id);
      if (skipped.length > 0) {
        refused.push(smiles);
        expect(document, smiles).toBe(d);
        expect(coordinates(after), smiles).toBe(coordinates(m));
      } else if (document !== d) {
        cleaned++;
      }
      expect(await written(after), smiles).toBe(before);
    }
    for (const smiles of CLEAN_UP_BREAKS) expect(refused).toContain(smiles);
    console.info(`Clean Up stereo guard: ${STEREO_SET.length} stereo molecules, ${cleaned} cleaned, ${refused.length} refused, ` +
      `${STEREO_SET.length - cleaned - refused.length} already clean.`);
  }, 240000);

  it("cleans non-stereo molecules as before, without reading stereo or reporting a skip", async () => {
    for (const smiles of NON_STEREO) {
      const pasted = await drawn(smiles);
      const d = scuffed(pasted.d, pasted.m.id);
      const m = byId(d, pasted.m.id);
      expect(w.cleanUpMayChangeStereo(m), smiles).toBe(false);
      const { calls, counted } = countingEngine();
      const { document, skipped } = guardedCleanUp(d, [m.id], counted);
      expect(calls.count, `${smiles}: no stereo perception`).toBe(0);
      expect(skipped, smiles).toEqual([]);
      expect(document, smiles).toEqual(w.cleanUpNativeMolecules2d(d, [m.id]));
      expect(coordinates(byId(document, m.id)), smiles).not.toBe(coordinates(m));
      expect(await written(byId(committed(d, document), m.id)), smiles).toBe(await written(m));
    }
  }, 120000);

  it("skips only the molecule that would flip in a mixed selection", async () => {
    const first = await drawn("C[S@](=O)c1ccccc1");
    const second = await drawn("CC(=O)c1ccccc1", first.d, { x: 600, y: 300 });
    const d = scuffed(second.d, second.m.id);
    const breaking = first.m, ordinary = byId(d, second.m.id);
    const { document, skipped } = guardedCleanUp(d, [breaking.id, ordinary.id]);
    expect(skipped).toEqual([{ objectId: breaking.id, reason: "changed" }]);
    expect(byId(document, breaking.id)).toEqual(byId(d, breaking.id));
    expect(coordinates(byId(document, ordinary.id))).not.toBe(coordinates(ordinary));
    const after = committed(d, document);
    expect(coordinates(byId(after, breaking.id))).toBe(coordinates(breaking));
    expect(await written(byId(after, breaking.id))).toBe(await written(breaking));
    expect(cleanUpStereoSkipStatus(skipped)).toBe("Clean Up skipped 1 structure: tidying it would have changed its stereochemistry.");
  }, 60000);

  it("keeps a stereo molecule as drawn when no perceiver is available", async () => {
    const { d, m } = await drawn("C[S@](=O)c1ccccc1");
    const skipped: Skipped = [];
    expect(w.cleanUpNativeMolecules2d(d, [m.id], { skipped })).toBe(d);
    expect(skipped).toEqual([{ objectId: m.id, reason: "unchecked" }]);
  });

  it("compares descriptors by drawn atom and bond, and names each kind of skip", async () => {
    const { m } = await drawn("C[C@H](O)c1ccccc1");
    const signature = cleanUpStereoSignature(m, engine);
    expect([...signature.centers.values()]).toEqual(["S"]);
    const mirrored = { ...m, atoms: m.atoms.map(a => ({ ...a, x: 600 - a.x })) };
    expect(cleanUpStereoRefusal(m, mirrored, engine)).toBe("changed");
    expect(cleanUpStereoRefusal(m, m, engine)).toBeUndefined();
    const unwedged = { ...m, bonds: m.bonds.map(b => ({ ...b, display: undefined })) };
    expect(cleanUpStereoRefusal(m, unwedged, engine)).toBe("changed");
    const failing: StereoEngine = { ...engine, perceiveStereoCentersFromMolfile: (() => { throw new Error("engine down"); }) as never };
    expect(cleanUpStereoRefusal(m, m, failing)).toBe("unchecked");

    const { m: alkene } = await drawn("C/C=C/C");
    expect([...cleanUpStereoSignature(alkene, engine).doubleBonds.values()]).toEqual(["E"]);

    expect(cleanUpStereoSkipStatus([])).toBeUndefined();
    expect(cleanUpStereoSkipStatus([{ reason: "changed" }, { reason: "changed" }]))
      .toBe("Clean Up skipped 2 structures: tidying them would have changed their stereochemistry.");
    expect(cleanUpStereoSkipStatus([{ reason: "unchecked" }]))
      .toBe("Clean Up skipped 1 structure: its stereochemistry couldn't be checked.");
  });
});

// A query bond (order "unknown") makes the perception molfile refuse, so the guard cannot read
// the molecule's stereo. It must then keep the molecule as drawn, never fall back to an unguarded
// Clean Up: the stereo the drawing still carries elsewhere would go unchecked.
describe("Clean Up 2D stereo guard with a query bond", () => {
  /** The single bond from a terminal oxygen (a hydroxyl), away from every stereo element. */
  function hydroxylBond(m: MoleculeObject) {
    const degree = new Map<string, number>();
    for (const b of m.bonds) for (const id of [b.fromAtomId, b.toAtomId]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const oxygen = new Set(m.atoms.filter(a => a.element === "O" && degree.get(a.id) === 1).map(a => a.id));
    const bond = m.bonds.find(b => b.order === "single" && !b.display?.bondStyle && (oxygen.has(b.fromAtomId) || oxygen.has(b.toAtomId)));
    if (!bond) throw new Error("No hydroxyl bond to turn into a query bond.");
    return bond;
  }
  const withOrder = (m: MoleculeObject, bondId: string, order: MoleculeObject["bonds"][number]["order"]): MoleculeObject =>
    ({ ...m, bonds: m.bonds.map(b => b.id === bondId ? { ...b, order } : b) });
  /** The document with one hydroxyl bond of the molecule changed to order "unknown". */
  function queried(d: ChemDraftDocument, id: string) {
    const bondId = hydroxylBond(byId(d, id)).id;
    const next: ChemDraftDocument = {
      ...d,
      pages: d.pages.map(page => ({ ...page, objects: page.objects.map(o => o.type === "molecule" && o.id === id ? withOrder(o, bondId, "unknown") : o) }))
    };
    return { d: next, m: byId(next, id), bondId };
  }

  it("keeps the recorded cinnamic-acid flip as drawn when an unrelated bond is a query bond", async () => {
    const pasted = await drawn("O=C(O)/C=C/c1ccccc1");
    const { d, m, bondId } = queried(pasted.d, pasted.m.id);
    expect(m.bonds.some(b => b.order === "unknown")).toBe(true);
    expect(m.bonds.some(b => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed")).toBe(false);
    expect(w.cleanUpMayChangeStereo(m)).toBe(true);
    // Without the guard the layout really does flip the alkene this drawing carries.
    const unguarded = byId(w.cleanUpNativeMolecules2d(d, [m.id]), m.id);
    expect(sameCleanUpStereo(cleanUpStereoSignature(withOrder(m, bondId, "single"), engine),
      cleanUpStereoSignature(withOrder(unguarded, bondId, "single"), engine))).toBe(false);

    const { document, skipped } = guardedCleanUp(d, [m.id]);
    expect(skipped).toEqual([{ objectId: m.id, reason: "unchecked" }]);
    expect(document).toBe(d);
    expect(coordinates(byId(committed(d, document), m.id))).toBe(coordinates(m));
    expect(cleanUpStereoSkipStatus(skipped)).toBe("Clean Up skipped 1 structure: its stereochemistry couldn't be checked.");
  }, 60000);

  it("keeps any E/Z alkene with a query bond as drawn, even one the layout would not flip", async () => {
    for (const smiles of ["C/C=C/C(=O)O", "C/C=C\\C(=O)O", "OC(=O)/C=C/C(=O)O"]) {
      const pasted = await drawn(smiles);
      const { d, m } = queried(scuffed(pasted.d, pasted.m.id), pasted.m.id);
      expect(w.cleanUpMayChangeStereo(m), smiles).toBe(true);
      expect(w.cleanUpNativeMolecules2d(d, [m.id]), `${smiles} has something to clean up`).not.toBe(d);
      const { document, skipped } = guardedCleanUp(d, [m.id]);
      expect(skipped, smiles).toEqual([{ objectId: m.id, reason: "unchecked" }]);
      expect(document, smiles).toBe(d);
    }
  }, 60000);

  it("keeps a wedged stereocenter with a query bond as drawn", async () => {
    for (const smiles of ["C[C@H](O)CC(=O)O", "O[C@@H](CC(=O)O)C(=O)O"]) {
      const pasted = await drawn(smiles);
      const { d, m } = queried(scuffed(pasted.d, pasted.m.id), pasted.m.id);
      expect(m.bonds.some(b => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed"), smiles).toBe(true);
      expect(w.cleanUpMayChangeStereo(m), smiles).toBe(true);
      expect(w.cleanUpNativeMolecules2d(d, [m.id]), `${smiles} has something to clean up`).not.toBe(d);
      const { document, skipped } = guardedCleanUp(d, [m.id]);
      expect(skipped, smiles).toEqual([{ objectId: m.id, reason: "unchecked" }]);
      expect(document, smiles).toBe(d);
    }
  }, 60000);

  it("skips only the query-bond alkene in a mixed selection and still cleans a query-bond molecule without stereo", async () => {
    const first = await drawn("O=C(O)/C=C/c1ccccc1");
    const second = await drawn("CCCC(=O)O", first.d, { x: 600, y: 300 });
    const a = queried(second.d, first.m.id);
    const b = queried(scuffed(a.d, second.m.id), second.m.id);
    const d = b.d;
    expect(w.cleanUpMayChangeStereo(b.m)).toBe(false);
    const { calls, counted } = countingEngine();
    const { document, skipped } = guardedCleanUp(d, [a.m.id, b.m.id], counted);
    expect(skipped).toEqual([{ objectId: a.m.id, reason: "unchecked" }]);
    expect(byId(document, a.m.id)).toEqual(byId(d, a.m.id));
    expect(coordinates(byId(document, b.m.id))).not.toBe(coordinates(byId(d, b.m.id)));
    // Neither reached the perceiver: the alkene's molfile refuses the query bond, and the
    // molecule without stereo marking is never read.
    expect(calls.count).toBe(0);
  }, 60000);
});
