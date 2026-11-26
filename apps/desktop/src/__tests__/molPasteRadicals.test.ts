import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, ElectronMarkObject, MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import { nativeSingleBondGraphMetadata } from "@chemdraft/document-workflow-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  applyClipboardPastePayload, copyAsMolfile, copyAsSmiles, createPhase4Document, normalizeCommittedDocument
} from "../documentWorkflow";

// The wasm loader the app registers is a bundler import; the node loader installed below is the
// same RDKit, so canonical SMILES here is the app's own (`copyAsSmiles` -> `moleculeSmiles`).
vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

// Bug mol-paste-drops-radicals (1.2.4): a pasted MOL keeps its radicals and stated hydrogen counts.
// Every row goes through the function the Paste command calls (`applyClipboardPastePayload`), then
// through the commit normalization every paste is committed with, and is read back by the app's
// own Copy As SMILES / formula.

interface Spec {
  atoms: { symbol: string; mass?: number; charge?: number; valence?: number; rad?: number }[];
  bonds: [number, number, number][];
}
const C = (extra: Partial<Spec["atoms"][number]> = {}): Spec["atoms"][number] => ({ symbol: "C", ...extra });

function v2000(spec: Spec): string {
  const fmt = (n: number) => n.toFixed(4).padStart(10);
  const props: string[] = [];
  const rad = spec.atoms.flatMap((atom, i) => atom.rad ? [`${String(i + 1).padStart(3)} ${String(atom.rad).padStart(3)}`] : []);
  if (rad.length) props.push(`M  RAD${String(rad.length).padStart(3)} ${rad.join(" ")}`);
  spec.atoms.forEach((atom, i) => {
    if (atom.mass === 1 && atom.symbol === "C") props.push(`M  ISO  1 ${String(i + 1).padStart(3)} ${String(13).padStart(3)}`);
  });
  return [
    "audit", "  hand-written", "",
    `${String(spec.atoms.length).padStart(3)}${String(spec.bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`,
    ...spec.atoms.map((atom, i) =>
      `${fmt(i * 1.5)}${fmt(i % 2 ? 0.8 : 0)}${fmt(0)} ${atom.symbol.padEnd(3)} 0${String(atom.charge ?? 0).padStart(3)}` +
      `  0  0  0${String(atom.valence ?? 0).padStart(3)}  0  0  0  0  0  0`),
    ...spec.bonds.map(([a, b, order]) => `${String(a).padStart(3)}${String(b).padStart(3)}${String(order).padStart(3)}  0  0  0  0`),
    ...props, "M  END"
  ].join("\n");
}

function v3000(spec: Spec): string {
  return [
    "audit", "  hand-written", "", "  0  0  0  0  0  0            999 V3000",
    "M  V30 BEGIN CTAB", `M  V30 COUNTS ${spec.atoms.length} ${spec.bonds.length} 0 0 0`, "M  V30 BEGIN ATOM",
    ...spec.atoms.map((atom, i) => {
      const extras = [
        atom.mass === 1 && atom.symbol === "C" ? "MASS=13" : "",
        atom.charge && atom.charge !== 4 ? `CHG=${atom.charge}` : "",
        atom.rad ? `RAD=${atom.rad}` : atom.charge === 4 ? "RAD=2" : "",
        atom.valence === 15 ? "VAL=-1" : atom.valence ? `VAL=${atom.valence}` : ""
      ].filter(Boolean).join(" ");
      return `M  V30 ${i + 1} ${atom.symbol} ${i * 1.5} ${i % 2 ? 0.8 : 0} 0 0${extras ? ` ${extras}` : ""}`;
    }),
    "M  V30 END ATOM", "M  V30 BEGIN BOND",
    ...spec.bonds.map(([a, b, order], i) => `M  V30 ${i + 1} ${order} ${a} ${b}`),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"
  ].join("\n");
}

interface Row { name: string; spec: Spec; smiles: string; formula: string; v2000Only?: true }
const rows: Row[] = [
  {
    name: "nitroxide CC1(C)CCCC(C)(C)N1[O]", smiles: "CC1(C)CCCC(C)(C)N1[O]", formula: "C9H18NO",
    spec: {
      atoms: [C(), C(), C(), C(), C(), C(), C(), C(), C(), { symbol: "N" }, { symbol: "O", rad: 2 }],
      bonds: [[1, 2, 1], [2, 3, 1], [2, 4, 1], [4, 5, 1], [5, 6, 1], [6, 7, 1], [7, 8, 1], [7, 9, 1], [7, 10, 1],
        [10, 2, 1], [10, 11, 1]]
    }
  },
  {
    name: "benzyl [CH2]c1ccccc1", smiles: "[CH2]c1ccccc1", formula: "C7H7",
    spec: {
      atoms: [C({ rad: 2 }), C(), C(), C(), C(), C(), C()],
      bonds: [[1, 2, 1], [2, 3, 2], [3, 4, 1], [4, 5, 2], [5, 6, 1], [6, 7, 2], [7, 2, 1]]
    }
  },
  {
    name: "ethyl radical C[CH2] by V2000 charge code 4", smiles: "[CH2]C", formula: "C2H5", v2000Only: true,
    spec: { atoms: [C(), C({ charge: 4 })], bonds: [[1, 2, 1]] }
  },
  {
    name: "typed N [N]CO by valence field", smiles: "[N]CO", formula: "CH3NO",
    spec: { atoms: [{ symbol: "N", valence: 1 }, C(), { symbol: "O" }], bonds: [[1, 2, 1], [2, 3, 1]] }
  },
  {
    name: "[13C] by zero valence", smiles: "[13C]", formula: "[13C]",
    spec: { atoms: [{ symbol: "C", mass: 1, valence: 15 }], bonds: [] }
  }
];

const point = { x: 300, y: 300 };
const flavors = [["V2000", v2000], ["V3000", v3000]] as const;

function payloadOf(molfile: string) {
  return inspectClipboardPayload({
    types: ["chemical/x-mdl-molfile"], textItems: [{ type: "chemical/x-mdl-molfile", text: molfile }]
  });
}

/** Paste through the Paste command's function, then commit-normalize as every in-app paste is. */
function paste(molfile: string, into: ChemDraftDocument = createPhase4Document("MOL paste")) {
  const result = applyClipboardPastePayload(into, payloadOf(molfile), point);
  return { result, document: normalizeCommittedDocument(result.document) };
}
const moleculeOf = (document: ChemDraftDocument): MoleculeObject =>
  document.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
const marksOf = (document: ChemDraftDocument): ElectronMarkObject[] =>
  document.pages[0]!.objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark");
const formulaOf = (molecule: MoleculeObject) => nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula;

beforeAll(() => { installNodeRdkitModuleLoader(); });

describe("pasted MOL keeps its radicals and stated hydrogens (bug mol-paste-drops-radicals)", () => {
  it.each(rows.flatMap((row) => flavors
    .filter(([flavor]) => flavor === "V2000" || !row.v2000Only)
    .map(([flavor, write]) => ({ label: `${row.name} as ${flavor}`, row, write }))))(
    "$label pastes with the same canonical SMILES and formula", async ({ row, write }) => {
      const { result, document } = paste(write(row.spec));
      const molecule = moleculeOf(document);
      expect(await copyAsSmiles(document)).toBe(row.smiles);
      expect(formulaOf(molecule)).toBe(row.formula);
      // Nothing was dropped, so nothing is said about it.
      expect(result.status).toMatch(/^Pasted editable MOL V[23]000 structure$/);
    });

  it("gives a pasted radical the same editable radical-dot mark the atom tool and CDXML import give", () => {
    const { document } = paste(v2000(rows[1]!.spec));
    const molecule = moleculeOf(document);
    const radicalAtoms = molecule.atoms.filter((atom) => (atom.markRadicals ?? 0) > 0);
    expect(radicalAtoms.map((atom) => atom.markRadicals)).toEqual([1]);
    const marks = marksOf(document);
    expect(marks.map((mark) => [mark.markKind, mark.anchor])).toEqual([
      ["radical-dot", { kind: "atom", objectId: molecule.id, atomId: radicalAtoms[0]!.id }]
    ]);
  });

  it("keeps a triplet's two electrons as two marks", () => {
    const { document } = paste(v2000({ atoms: [C(), C({ rad: 3 })], bonds: [[1, 2, 1]] }));
    expect(moleculeOf(document).atoms.map((atom) => atom.markRadicals ?? 0)).toEqual([0, 2]);
    expect(marksOf(document).map((mark) => mark.markKind)).toEqual(["radical-dot", "radical-dot"]);
  });

  it("stores a stated count only where it differs from what the atom derives", () => {
    const { document } = paste(v2000({
      atoms: [C({ valence: 4 }), C({ valence: 4 }), { symbol: "N", valence: 1 }], bonds: [[1, 2, 1], [2, 3, 1]]
    }));
    // CH3 and CH2 count what they derive; the N states 0 H where its bond derives 2.
    expect(moleculeOf(document).atoms.map((atom) => atom.hydrogenCount)).toEqual([undefined, undefined, 0]);
  });

  it("does not change a molfile that states neither radicals nor valences", () => {
    const { result, document } = paste(v2000({ atoms: [C(), C(), { symbol: "O" }], bonds: [[1, 2, 1], [2, 3, 1]] }));
    expect(result.status).toBe("Pasted editable MOL V2000 structure");
    expect(moleculeOf(document).atoms.every((atom) => atom.markRadicals === undefined && atom.hydrogenCount === undefined)).toBe(true);
    expect(marksOf(document)).toEqual([]);
  });
});

describe("pasted MOL says what it could not keep", () => {
  it.each(flavors)("%s: a singlet radical is named in the paste status and warnings", (_flavor, write) => {
    const { result, document } = paste(write({ atoms: [C(), C({ rad: 1 })], bonds: [[1, 2, 1]] }));
    expect(moleculeOf(document)).toBeTruthy();
    expect(result.status).toMatch(/^Pasted editable MOL V[23]000 structure; /);
    expect(result.status).toMatch(/Atom 2 \(C\) is marked as a singlet radical/);
    expect(result.warnings.map((warning) => warning.code)).toContain("clipboard.radical_singlet_unsupported");
  });

  it.each(flavors)("%s: a valence the bonds make unreadable is named in the paste status", (_flavor, write) => {
    const { result } = paste(write({ atoms: [C({ valence: 2 }), C()], bonds: [[1, 2, 3]] }));
    expect(result.status).toMatch(/^Pasted editable MOL V[23]000 structure; Atom 1 \(C\) states valence 2/);
    expect(result.warnings.map((warning) => warning.code)).toContain("clipboard.valence_not_read");
  });
});

describe("Copy As MOL -> paste round trips keep radicals and stated counts", () => {
  const atom = (id: string, element: string, extra: Partial<MoleculeAtom> = {}): MoleculeAtom =>
    ({ id, element, x: 100 + Number(id.slice(1)) * 30, y: 100, formalCharge: 0, ...extra });
  const bond = (a: number, b: number) => ({ id: `b${a}${b}`, fromAtomId: `a${a}`, toAtomId: `a${b}`, order: "single" as const });
  const nativeTypedN: MoleculeObject = {
    id: "typedN", type: "molecule", x: 100, y: 80, width: 120, height: 40, rotation: 0, style: {},
    structureFormat: "unknown", structure: "", superatoms: [], rGroups: [],
    atoms: [atom("a1", "N", { labelLiteral: true }), atom("a2", "C"), atom("a3", "O")], bonds: [bond(1, 2), bond(2, 3)]
  };

  const roundTrip = async (document: ChemDraftDocument, expectedSmiles: string, expectedFormula: string) => {
    for (const flavor of ["v2000", "v3000"] as const) {
      const copied = copyAsMolfile(document, flavor);
      if (!copied) throw new Error("Copy As MOL returned nothing");
      const again = paste(copied).document;
      expect(await copyAsSmiles(again), flavor).toBe(expectedSmiles);
      expect(formulaOf(moleculeOf(again)), flavor).toBe(expectedFormula);
      expect(marksOf(again).length, flavor).toBe(marksOf(document).length);
    }
  };

  it.each(rows.map((row) => [row.name, row] as const))("%s: paste, Copy As MOL, paste again", async (_name, row) => {
    await roundTrip(paste(v2000(row.spec)).document, row.smiles, row.formula);
  });

  it("a typed N written by the app: Copy As MOL, then paste", async () => {
    const base = createPhase4Document("typed N");
    const document: ChemDraftDocument = { ...base, pages: [{ ...base.pages[0]!, objects: [nativeTypedN] }] };
    await roundTrip(document, "[N]CO", "CH3NO");
  });
});
