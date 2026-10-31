import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseV2000AtomBlock } from "@chemdraft/chemistry-adapter";
import { ensureRdkit, resetRdkitForTesting, type RdkitMinimalModule } from "./conformer";
import { installRealRdkitModuleLoader } from "./testing";
import { createRdkit2DRelayouts, RdkitRelayoutIdentityError, relayoutMolfile2DWithRdkit } from "./relayout2d";

let rdkit: RdkitMinimalModule;
beforeAll(async () => { installRealRdkitModuleLoader(); rdkit = await ensureRdkit(); });
afterAll(() => resetRdkitForTesting());
function molfile(smiles: string) {
  const mol = rdkit.get_mol(smiles, JSON.stringify({ removeHs: false }))!;
  try { mol.set_new_coords!(false); return mol.get_molblock!(); } finally { mol.delete(); }
}
function identity(input: string) {
  const mol = rdkit.get_mol(input, JSON.stringify({ removeHs: false }))!;
  try { return mol.get_smiles!(); } finally { mol.delete(); }
}

describe("RDKit identity-preserving molfile re-layout (real WASM)", () => {
  it.each([true, false])("keeps explicit hydrogens, atom order, isotopes and charges (CoordGen=%s)", useCoordGen => {
    const input = molfile("[H][13C]([H])([2H])[C@H](F)[NH2+]CC(=O)[O-]");
    const output = relayoutMolfile2DWithRdkit(input, rdkit, useCoordGen);
    expect(output.atoms.map(a => a.element)).toEqual(parseV2000AtomBlock(input)!.map(a => a.element));
    expect(output.atoms.slice(0, 4).map(a => a.element)).toEqual(["H", "C", "H", "H"]);
    expect(output.atoms[1].isotope).toBe(13);
    expect(output.atoms[3].isotope).toBe(2);
    expect(output.atoms.map(a => a.charge).filter(Boolean)).toEqual([1, -1]);
    expect(identity(output.molfile)).toBe(identity(input));
    expect(output.atoms.map(a => [a.x, a.y])).toEqual(parseV2000AtomBlock(output.molfile)!.map(a => [a.x, a.y]));
  });

  it.each([true, false])("preserves cholesterol stereochemistry (CoordGen=%s)", useCoordGen => {
    const input = molfile("CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C");
    const output = relayoutMolfile2DWithRdkit(input, rdkit, useCoordGen);
    expect(identity(output.molfile)).toBe(identity(input));
    expect(output.atoms.map(a => a.element)).toEqual(parseV2000AtomBlock(input)!.map(a => a.element));
    expect(output.bonds.some(b => b.wedge)).toBe(true);
  });

  it("retains input open double bonds in both candidates", async () => {
    const input = molfile("CC=CC");
    expect(input.split(/\r?\n/).slice(8, 11).some(line => Number(line.slice(6, 9)) === 2 && Number(line.slice(9, 12)) === 3)).toBe(true);
    for (const relayout of await createRdkit2DRelayouts()) {
      const output = relayout(input);
      expect(output.bonds.find(b => b.order === "double")?.stereo).toBe("either");
      expect(identity(output.molfile)).toBe(identity(input));
    }
  });

  it("skips CoordGen above its size guard while leaving the default depictor available", () => {
    const input = molfile("C".repeat(81));
    expect(() => relayoutMolfile2DWithRdkit(input, rdkit, true)).toThrow(/size guard/);
    expect(identity(relayoutMolfile2DWithRdkit(input, rdkit, false).molfile)).toBe(identity(input));
  });

  it("refuses a serialized reflection that inverts stereo", () => {
    const input = molfile("N[C@@H](F)C(=O)O");
    const corrupt: RdkitMinimalModule = { get_mol(value, options) {
      const mol = rdkit.get_mol(value, options);
      if (mol && value === input) {
        const write = mol.get_molblock!.bind(mol);
        mol.get_molblock = () => {
          const lines = write().split(/\r?\n/);
          const count = Number(lines[3].slice(0, 3));
          for (let i = 4; i < 4 + count; i++) {
            lines[i] = `${lines[i].slice(0, 10)}${(-Number(lines[i].slice(10, 20))).toFixed(4).padStart(10)}${lines[i].slice(20)}`;
          }
          return lines.join("\n");
        };
      }
      return mol;
    } };
    expect(() => relayoutMolfile2DWithRdkit(input, corrupt, false)).toThrow(/canonical isomeric SMILES changed/);
  });

  it("refuses identity corruption in the actual serialized output", () => {
    const input = molfile("CCO");
    // Exercise the refusal with a real engine handle whose writer is deliberately corrupted.
    const corrupt: RdkitMinimalModule = { get_mol(value, options) {
      const mol = rdkit.get_mol(value, options);
      if (mol && value === input) {
        const write = mol.get_molblock!.bind(mol);
        mol.get_molblock = () => write().replace(/ O /, " N ");
      }
      return mol;
    } };
    expect(() => relayoutMolfile2DWithRdkit(input, corrupt, false)).toThrow(RdkitRelayoutIdentityError);
    expect(() => relayoutMolfile2DWithRdkit("not a molfile", rdkit)).toThrow(/V2000/);
  });
});
