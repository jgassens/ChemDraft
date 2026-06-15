/**
 * Phase 6 — oracle round-trip: the COMMITTED doc-frame flatten, judged by RDKit.
 *
 * `ocl-flatten-gate` proves CIP survives depiction → OCL 3D → flatten *projection*
 * (the chem-core math-frame output). This extends that judgement to the actual Phase
 * 5.1 commit path the app ships — `flattenSpunMolecule`:
 *
 *   doc-frame molecule → OCL conformer → flattenSpunMolecule (y-negate in/out, rescale,
 *   recenter, molfile rewrite, wedge re-encode) → the atoms/wedges the app writes into
 *   the document → RDKit perceiveFrom2D.
 *
 * The committed drawing must read the SAME CIP as the pre-flatten drawing at every
 * encoded stereocenter (both read by RDKit in the same document frame). This catches
 * molfile-writer / frame-recipe / rescale regressions that the gate — which reads the
 * math-frame projection directly, before the writer and doc round-trip — cannot see.
 *
 * Skips when the RDKit venv is absent (CI without the oracle stays green).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { applyPatches, type ChemDraftDocument, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, oclConformerGenerator, type Depiction2D } from "@chemdraft/ocl-adapter";

import { createPhase4Document, flattenSpunMolecule } from "../../apps/desktop/src/documentWorkflow";
import { isOracleAvailable, runOracle, type OracleBond } from "./client";

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const describeOracle = isOracleAvailable() ? describe : describe.skip;

interface RoundTripCase {
  smiles: string;
  label: string;
}

const CASES: RoundTripCase[] = [
  { smiles: "C[C@H](F)Cl", label: "(R)-CHFClMe" },
  { smiles: "C[C@@H](F)Cl", label: "(S)-CHFClMe" },
  { smiles: "C[C@@H](O)[C@@H](N)C(=O)O", label: "L-threonine (2 centers)" }
];

function molecule(id: string, atoms: MoleculeObject["atoms"], bonds: MoleculeObject["bonds"]): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  };
}

function documentWith(mol: MoleculeObject): ChemDraftDocument {
  const base = createPhase4Document("Oracle Round-trip Fixture");
  return applyPatches(base, [
    { op: "addObject", pageId: base.pages[0].id, object: mol },
    { op: "setSelection", pageId: base.pages[0].id, objectIds: [mol.id] }
  ]);
}

function moleculeOf(document: ChemDraftDocument, id: string): MoleculeObject {
  const found = document.pages[0].objects.find((object) => object.id === id);
  if (!found || found.type !== "molecule") throw new Error("molecule missing");
  return found;
}

/**
 * Build a document-frame molecule + its OCL 3D conformer coords from a SMILES.
 *
 * The depiction is y-UP (math frame); ChemDraft documents are y-DOWN, so we negate y
 * to land the fixture in the same frame a real drawing lives in. This matters here:
 * `flattenSpunMolecule` assumes a y-down input and emits a y-down commit, so reading
 * pre- and post-flatten CIP both happen in the document frame and compare like-for-like.
 * (Feeding a y-up fixture would mirror `pre` against `post` and report a false inversion.)
 * `coords3d` is generated from the depiction molfile, which equals this fixture's
 * `fromDocFrame` molfile — exactly what the conformer worker embeds in the real app.
 */
async function conformerFromSmiles(smiles: string, id: string) {
  const dep: Depiction2D = depictSmiles2D(smiles);
  const mol = molecule(
    id,
    dep.atoms.map((atom, index) => ({ id: `a${index}`, element: atom.element, x: 50 + atom.x * 20, y: 50 - atom.y * 20, formalCharge: atom.charge })),
    dep.bonds.map((bond, index) => ({
      id: `b${index}`,
      fromAtomId: `a${bond.from}`,
      toAtomId: `a${bond.to}`,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      ...(bond.wedge ? { display: { bondStyle: bond.wedge } } : {})
    }))
  );
  const conformer = await oclConformerGenerator.generate3DConformer({ molfile: dep.molfile }, { optimize: "auto" });
  return { mol, coords3d: conformer.mapping.coords3dByOriginalAtom, embedStatus: conformer.embed.status };
}

/** Atom-index → wedge-aware oracle bonds (perceiveFrom2D reads chirality from these). */
function oracleBondsFromMolecule(mol: MoleculeObject): OracleBond[] {
  const index = new Map(mol.atoms.map((a, i) => [a.id, i]));
  return mol.bonds.map((b) => {
    const style = b.display?.bondStyle;
    const wedge: OracleBond["wedge"] = style === "wedge" ? "up" : style === "hashed" ? "down" : null;
    return { from: index.get(b.fromAtomId) as number, to: index.get(b.toAtomId) as number, order: b.order, wedge };
  });
}

/** RDKit CIP per atom index, perceived from the molecule's 2D coords + wedge flags. */
function cipByCenter(mol: MoleculeObject): Record<string, string> {
  const response = runOracle([
    {
      id: "perceive",
      op: "perceiveFrom2D",
      atoms: mol.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: 0 })),
      bonds: oracleBondsFromMolecule(mol)
    }
  ]);
  return response.results[0]?.centers ?? {};
}

beforeAll(async () => {
  await ensureOclResources();
});

describeOracle("Phase 6 oracle — committed flatten preserves CIP at every encoded center", () => {
  for (const { smiles, label } of CASES) {
    it(`${label} — CIP is identical before and after the commit`, async () => {
      const { mol, coords3d, embedStatus } = await conformerFromSmiles(smiles, "rt");
      expect(embedStatus).toBe("ok");

      // Pre-flatten: the stereocenters RDKit perceives in the drawing as we hand it in.
      const pre = cipByCenter(mol);
      const encodedCenters = Object.keys(pre).filter((key) => pre[key] === "R" || pre[key] === "S");
      expect(encodedCenters.length, "drawing should present at least one defined stereocenter").toBeGreaterThanOrEqual(1);

      // The real Phase 5.1 commit.
      const document = documentWith(mol);
      const outcome = flattenSpunMolecule(document, "rt", coords3d, IDENTITY);
      expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
      const committed = moleculeOf(outcome.document, "rt");

      // Atom order is preserved by the flatten, so center indices line up 1:1.
      const post = cipByCenter(committed);
      for (const center of encodedCenters) {
        expect(post[center], `center ${center} (${label})`).toBe(pre[center]);
      }
    });
  }
});
