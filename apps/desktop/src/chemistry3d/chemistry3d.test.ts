import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureRdkit, resetRdkitForTesting } from "@chemdraft/rdkit-adapter";
import { installRealRdkitModuleLoader } from "@chemdraft/rdkit-adapter/testing";
import { createEmptyDocument, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, moleculeGeometryFromAtoms } from "@chemdraft/document-workflow-core";
import type { Plugin3DModel, PluginEmbed3DResult } from "@chemdraft/plugin-api";
import { createChemistry3dProviders } from "./client";
import { runChemistry3dJob } from "./protocol";
import { ModelTokenAuthority } from "./token";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { unspecifiedStereoDoubleBonds } from "./stereo";
import { projectSpin } from "../interaction/spinOverlay";
import { quatFromAxisAngle, quatToViewMatrix } from "../interaction/rotation3d";
import { closestHeavyContactPair, heavyContactDescription } from "./model";
import type { Chemistry3dTiming } from "./timing";

const stop = () => new AbortController().signal;
const transport = vi.fn(runChemistry3dJob);
const providers = createChemistry3dProviders((job) => transport(job), new ModelTokenAuthority());
let embedded: PluginEmbed3DResult;

beforeAll(async () => {
  installRealRdkitModuleLoader();
  embedded = await providers.embed3d({ components: [{ smiles: "c1ccccc1" }, { smiles: "CC" }] }, stop());
}, 30000);
afterAll(() => resetRdkitForTesting());

async function canonical(input: string): Promise<string> {
  const mol = (await ensureRdkit()).get_mol(input, JSON.stringify({ removeHs: true }))!;
  try { return mol.get_smiles!(); } finally { mol.delete(); }
}

describe("plugin 3D chemistry round trips on the vendored WASM", () => {
  it.each(["C", "CCO", "c1ccccc1", "C[C@H](F)Cl"])("encloses flattened atoms with the SMILES paste frame padding: %s", async smiles => {
    const input = await providers.embed3d({ components: [{ smiles }] }, stop());
    const flat = await providers.flatten3d({ model: input.model, view: "auto" }, stop());
    const molecule = flat.objects[0] as MoleculeObject;
    const pasted = createSmilesMolecule(createEmptyDocument(), { x: 100, y: 100 }, {
      atoms: molecule.atoms.map(atom => ({ element: atom.element, x: atom.x, y: atom.y, charge: atom.formalCharge })),
      bonds: molecule.bonds.map(bond => ({
        from: molecule.atoms.findIndex(atom => atom.id === bond.fromAtomId),
        to: molecule.atoms.findIndex(atom => atom.id === bond.toAtomId), order: bond.order, wedge: null
      }))
    }, smiles) as MoleculeObject;
    const paddingX = Math.min(...pasted.atoms.map(atom => atom.x)) - pasted.x;
    const paddingY = Math.min(...pasted.atoms.map(atom => atom.y)) - pasted.y;
    expect(paddingX).toBeCloseTo(8);
    expect(paddingY).toBeCloseTo(16);
    expect(molecule).toMatchObject(moleculeGeometryFromAtoms(molecule.atoms));
    expect(Math.min(...molecule.atoms.map(atom => atom.x)) - molecule.x).toBeCloseTo(paddingX);
    expect(Math.min(...molecule.atoms.map(atom => atom.y)) - molecule.y).toBeCloseTo(paddingY);
    for (const atom of molecule.atoms) {
      expect(atom.x).toBeGreaterThanOrEqual(molecule.x + paddingX - 1e-8);
      expect(atom.y).toBeGreaterThanOrEqual(molecule.y + paddingY - 1e-8);
      expect(atom.x).toBeLessThanOrEqual(molecule.x + molecule.width - paddingX + 1e-8);
      expect(atom.y).toBeLessThanOrEqual(molecule.y + molecule.height - paddingY + 1e-8);
    }
  });

  it.each([
    ["CCO", 3, 0], ["C[C@H](F)Cl", 4, 0], ["C/C=C/C", 4, 0],
    ["C/C=C\\C", 4, 0], ["C[C@H](F)/C=C/Cl", 6, 0],
    ["[H][C@](F)(Cl)Br", 5, 1], ["[H]/C(Cl)=C(/F)Br", 6, 1]
  ] as const)("removes only model-added Hs, retaining input counts and stereo: %s", async (smiles, atoms, hydrogens) => {
    const input = await providers.embed3d({ components: [{ smiles }] }, stop());
    expect(input.model.atoms.filter(atom => !atom.addedHydrogen)).toHaveLength(atoms);
    const flat = await providers.flatten3d({ model: input.model, view: "auto" }, stop());
    const molecule = flat.objects[0] as MoleculeObject;
    expect(molecule.atoms).toHaveLength(atoms);
    expect(molecule.atoms.filter(atom => atom.element === "H")).toHaveLength(hydrogens);
    expect(flat.depthByAtom[0]).toHaveLength(atoms);
    expect(await canonical(molecule.structure)).toBe(await canonical(smiles));
    expect(await canonical(moleculeToMolfileV2000(molecule, { fromDocFrame: true,
      kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents)).toBe(await canonical(smiles));
    if (smiles.includes("@")) {
      const wedges = molecule.bonds.filter(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""));
      expect(wedges.length).toBeGreaterThan(0);
      if (!hydrogens) for (const wedge of wedges) {
        expect(molecule.atoms.find(atom => atom.id === wedge.fromAtomId)?.element).not.toBe("H");
        expect(molecule.atoms.find(atom => atom.id === wedge.toAtomId)?.element).not.toBe("H");
      }
    }
  });
  it("profiles real binding attempts only when opted in and restores Embind on success/refusal", async () => {
    const rdkit = await ensureRdkit();
    const getMol = rdkit.get_mol;
    const timings: Chemistry3dTiming[] = [];
    const input = await runChemistry3dJob({ method: "embed3d", request: { components: [{ smiles: "C" }] } }, undefined,
      event => timings.push(event)) as PluginEmbed3DResult;
    expect(timings.filter(event => event.stage === "embed.attempt")).toHaveLength(4);
    expect(timings.find(event => event.stage === "embed.component")?.details).toMatchObject({ component: 1, inputAtoms: 1 });
    expect(rdkit.get_mol).toBe(getMol);
    await expect(runChemistry3dJob({ method: "flatten3d", request: {
      model: { ...input.model, atoms: input.model.atoms.map(atom => ({ ...atom, isotope: 13 })) }, view: "auto"
    }, provenance: input.method }, undefined, event => timings.push(event))).rejects.toThrow("carries isotope labels");
    expect(rdkit.get_mol).toBe(getMol);
  });
  it("embeds explicit H components independently, side by side, with a method contract", async () => {
    const { model, method } = embedded;
    expect(model.atoms).toHaveLength(20);
    expect(model.atoms.filter(atom => atom.addedHydrogen)).toHaveLength(12);
    expect(model.coords.every(Number.isFinite)).toBe(true);
    expect(method).toMatchObject({ engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008", seed: 42, embedding: "ETKDGv3" });
    expect(method.conventions.join(" ")).toContain("not binding energies");
    const xs = model.components.map(component => model.coords.slice(component.atomStart * 3,
      (component.atomStart + component.atomCount) * 3).filter((_, i) => i % 3 === 0));
    expect(Math.min(...xs[1]) - Math.max(...xs[0])).toBeCloseTo(4, 8);
    const again = await providers.embed3d({ components: [{ smiles: "c1ccccc1" }, { smiles: "CC" }] }, stop());
    expect(again.model).toEqual(model);
  });

  it.each(["mmff94s", "uff"] as const)("%s separates a realistic overlapping start beyond 2.5 A", async forceField => {
    const model = structuredClone(embedded.model);
    const first = model.components[1].atomStart;
    const delta = [model.coords[0] + 0.4 - model.coords[first * 3], model.coords[1] + 0.3 - model.coords[first * 3 + 1],
      model.coords[2] + 1.8 - model.coords[first * 3 + 2]];
    for (let i = first; i < model.atoms.length; i++) for (let axis = 0; axis < 3; axis++) model.coords[i * 3 + axis] += delta[axis];
    const off = await providers.minimize3d({ model, forceField, interfragment: false, maxIters: 2000 }, stop());
    const on = await providers.minimize3d({ model, forceField, interfragment: true, maxIters: 2000 }, stop());
    expect(on.model.modelToken).toBe(model.modelToken);
    expect(on.model.atoms).toEqual(model.atoms);
    expect(on.model.bonds).toEqual(model.bonds);
    expect(on.forceField.status).toBe("converged");
    expect(on.forceField.iterationsBudget).toBeLessThanOrEqual(2000);
    expect(on.closestInterComponentHeavyAtomA).toBeGreaterThan(2.5);
    expect(on.clash).toBe(false);
    expect((await providers.flatten3d({ model: on.model, view: "auto" }, stop())).objects).toHaveLength(2);
    expect(on.closestInterComponentHeavyAtomA! - off.closestInterComponentHeavyAtomA!).toBeGreaterThan(0.5);
    expect(on.method.interfragment).toBe(true);
    expect(off.method.interfragment).toBe(false);
  });

  it("reports a converged clash even with interactions off, and flatten independently refuses coordinate edits", async () => {
    const pair = await providers.embed3d({ components: [{ smiles: "C" }, { smiles: "C" }] }, stop());
    const model = structuredClone(pair.model);
    const second = model.components[1].atomStart;
    const delta = [model.coords[0] + 1.85 - model.coords[second * 3], model.coords[1] - model.coords[second * 3 + 1],
      model.coords[2] - model.coords[second * 3 + 2]];
    for (let i = second; i < model.atoms.length; i++) for (let axis = 0; axis < 3; axis++) model.coords[i * 3 + axis] += delta[axis];
    const minimized = await providers.minimize3d({ model, interfragment: false }, stop());
    expect(minimized.forceField.status).toBe("converged");
    expect(minimized.clash).toBe(true);
    expect(minimized.closestInterComponentHeavyAtomA).toBeLessThan(2.2);
    expect(minimized.warnings.join(" ")).toContain("Do not insert this model; retry with another arrangement.");
    for (const clashing of [model, minimized.model]) {
      const contact = closestHeavyContactPair(clashing)!;
      await expect(providers.flatten3d({ model: clashing, view: "auto" }, stop())).rejects.toThrow(
        `flatten3d refused a clashing model: closest inter-component heavy-atom contact is ${heavyContactDescription(clashing, contact)}; below 2.2 A. Retry with another arrangement.`);
    }
    const clean = await providers.minimize3d({ model: pair.model, interfragment: true }, stop());
    expect(clean.clash).toBe(false);
    expect((await providers.flatten3d({ model: clean.model, view: "auto" }, stop())).objects).toHaveLength(2);
  });

  it.each([
    ["token", (model: Plugin3DModel) => { model.modelToken = "tampered"; }],
    ["bond", (model: Plugin3DModel) => { model.bonds[0].order = 3; }],
    ["charge", (model: Plugin3DModel) => { model.atoms[0].charge = 1; }],
    ["isotope", (model: Plugin3DModel) => { model.atoms[0].isotope = 13; }],
    ["component SMILES", (model: Plugin3DModel) => { model.components[0].smiles = "CC"; }],
    ["atom count with otherwise valid ranges", (model: Plugin3DModel) => {
      const last = model.atoms.length - 1;
      model.atoms.pop(); model.coords.splice(-3);
      model.components[1].atomCount--;
      model.bonds = model.bonds.filter(bond => bond.a !== last && bond.b !== last);
    }]
  ] as const)("refuses a tampered %s before dispatching to RDKit", async (_label, mutate) => {
    const model = structuredClone(embedded.model);
    mutate(model);
    const calls = transport.mock.calls.length;
    await expect(providers.minimize3d({ model, interfragment: true }, stop())).rejects.toThrow("3D modelToken is invalid for this app session");
    await expect(providers.flatten3d({ model, view: "auto" }, stop())).rejects.toThrow("3D modelToken is invalid for this app session");
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it("refuses altered atom counts, NaN, wrong coordinate lengths, single-component forces and non-booleans", async () => {
    const calls = transport.mock.calls.length;
    const nan = structuredClone(embedded.model); nan.coords[0] = NaN;
    await expect(providers.minimize3d({ model: nan, interfragment: true }, stop())).rejects.toThrow("3D model coordinates must all be finite numbers.");
    const count = structuredClone(embedded.model); count.atoms.pop();
    await expect(providers.flatten3d({ model: count, view: "auto" }, stop())).rejects.toThrow("coordinates length must equal");
    const coords = structuredClone(embedded.model); coords.coords.pop();
    await expect(providers.flatten3d({ model: coords, view: "auto" }, stop())).rejects.toThrow("coordinates length must equal");
    for (const interfragment of ["false", 0, null, undefined]) await expect(providers.minimize3d({ model: embedded.model, interfragment } as never, stop()))
      .rejects.toThrow("minimize3d interfragment must be a boolean (true or false).");
    expect(transport).toHaveBeenCalledTimes(calls);
    const single = await providers.embed3d({ components: [{ smiles: "CC" }] }, stop());
    await expect(providers.minimize3d({ model: single.model, interfragment: true }, stop())).rejects.toThrow("minimize3d interfragment:true requires more than one component.");
  });

  it("binds tokens to the app session, while allowing finite coordinate edits", async () => {
    const foreign = createChemistry3dProviders(job => runChemistry3dJob(job), new ModelTokenAuthority());
    await expect(foreign.flatten3d({ model: embedded.model, view: "auto" }, stop())).rejects.toThrow("invalid for this app session");
    const moved = structuredClone(embedded.model); moved.coords = moved.coords.map(value => value + 1);
    await expect(providers.minimize3d({ model: moved, interfragment: false, maxIters: 1 }, stop())).resolves.toMatchObject({ model: { modelToken: moved.modelToken } });
  });

  it("preserves isotope data through embedding/minimization and refuses native isotope loss on flatten", async () => {
    const input = await providers.embed3d({ components: [{ smiles: "[13CH3]CO" }] }, stop());
    expect(input.model.atoms[0].isotope).toBe(13);
    const minimized = await providers.minimize3d({ model: input.model, interfragment: false }, stop());
    expect(minimized.model.atoms[0].isotope).toBe(13);
    const rdkit = await ensureRdkit();
    const read = vi.spyOn(rdkit, "get_mol");
    await expect(providers.flatten3d({ model: minimized.model, view: "auto" }, stop())).rejects.toThrow("Component 1 ([13CH3]CO) carries isotope labels (13C), which ChemDraft drawings cannot store yet; flatten3d refuses rather than drop them.");
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it.each(["[NH4+]", "[NH3+]CC(=O)[O-]", "[CH2]C", "C[C@H](F)/C=C/Cl"])(
    "round-trips charge, radical and stereo through embed/minimize/flatten: %s", async smiles => {
      const input = await providers.embed3d({ components: [{ smiles }] }, stop());
      const minimized = await providers.minimize3d({ model: input.model, interfragment: false }, stop());
      const flat = await providers.flatten3d({ model: minimized.model, view: "auto" }, stop());
      const molecule = flat.objects[0] as MoleculeObject;
      expect(await canonical(molecule.structure)).toBe(await canonical(smiles));
      const retained = input.model.atoms.filter(atom => !atom.addedHydrogen);
      expect(molecule.atoms.map(atom => atom.formalCharge)).toEqual(retained.map(atom => atom.charge));
      expect(molecule.atoms.map(atom => atom.markRadicals ?? 0)).toEqual(retained.map(atom => atom.radical ?? 0));
      expect(minimized.model.atoms).toEqual(input.model.atoms);
      expect(minimized.model.bonds).toEqual(input.model.bonds);
    }
  );
  it.each([
    "CC(O)CC", "C[C@H](F)Cl", "C/C=C/C", "C/C=C\\C", "F[C@H]1CCC[C@H](Cl)C1",
    "C[C@H](O)C(O)CC", "C[C@H](O)[C@@H](O)C", "C[C@H](O)[C@H](O)C",
    "F[C@H]1CC[C@@H](Cl)CC1", "[H][C@](F)(Cl)Br"
  ])("preserves exactly the signed stereo intent through minimize and flatten: %s", async smiles => {
    const input = await providers.embed3d({ components: [{ smiles }] }, stop());
    const minimized = await providers.minimize3d({ model: input.model, interfragment: false }, stop());
    for (const model of [input.model, minimized.model]) {
      const flat = await providers.flatten3d({ model, view: "auto" }, stop());
      const molecule = flat.objects[0] as MoleculeObject;
      expect(await canonical(molecule.structure)).toBe(await canonical(smiles));
      expect(await canonical(moleculeToMolfileV2000(molecule, { fromDocFrame: true,
        kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents)).toBe(await canonical(smiles));
      // Inspect the native markers too: every wedge/hash must belong to specified input stereo.
      const specified = smiles === "CC(O)CC" ? 0 :
        (smiles === "C[C@H](O)C(O)CC" ? 1 : undefined);
      const markers = molecule.bonds.filter(b => ["wedge", "hashed"].includes(b.display?.bondStyle ?? ""));
      if (specified !== undefined) expect(markers).toHaveLength(specified);
      if (smiles === "C[C@H](O)C(O)CC") {
        expect(markers[0].fromAtomId).toBe(molecule.atoms[1].id);
        expect((await canonical(molecule.structure)).match(/@{1,2}/g)).toHaveLength(1);
      }
    }
  });

  it.each(["CC(O)CC", "CC=CC"])("minimization accepts reflected unspecified geometry: %s", async smiles => {
    const input = await providers.embed3d({ components: [{ smiles }] }, stop());
    input.model.coords = invert(input.model, smiles === "CC=CC" ? "E/Z" : "tetrahedral");
    await expect(providers.minimize3d({ model: input.model, interfragment: false }, stop())).resolves.toBeDefined();
    if (smiles === "CC=CC") {
      await expect(providers.flatten3d({ model: input.model, view: "auto" }, stop())).rejects.toThrow(
        "Component 1 (CC=CC): double bond 2 has no E/Z in the input, and ChemDraft drawings cannot store an open double bond yet; specify / or \\ in the SMILES.");
    } else {
      const flat = await providers.flatten3d({ model: input.model, view: "auto" }, stop());
      expect(await canonical((flat.objects[0] as MoleculeObject).structure)).toBe(await canonical(smiles));
    }
  });

  it.each([
    ["[H]C(C)=CC", [3]],
    ["C1=CCCCCCC1", [1]],
    ["C/C=CC", [2]],
    ["CC(C)=CC", []],
    ["CC=C=CC", []]
  ] as const)("uses RDKit potential E/Z perception with explicit Hs and ring boundaries: %s", async (smiles, expected) => {
    expect(unspecifiedStereoDoubleBonds(await ensureRdkit(), smiles)).toEqual(expected);
  });

  it.each([
    ["CC=CC", 2, ""],
    ["CC=CC=CC", 2, " (first of 2)"],
    // A specified first alkene does not hide a later open one.
    ["C/C=C/CC=CC", 5, ""],
    // The ring closure precedes the alkene in SMILES traversal, but RDKit stores it last.
    ["C1CCCCC1C=CC", 7, ""]
  ] as const)("refuses open E/Z in signed input order before geometry/depiction: %s", async (smiles, bond, count) => {
    const input = await providers.embed3d({ components: [{ smiles: "CC" }, { smiles }] }, stop());
    // Even degenerate plugin-edited coordinates cannot bypass the graph-based refusal.
    input.model.coords.fill(0);
    // Keep components apart so this exercises open E/Z rather than the earlier contact gate.
    input.model.atoms.forEach((atom, i) => { input.model.coords[i * 3] = atom.component * 4; });
    const rdkit = await ensureRdkit();
    const read = vi.spyOn(rdkit, "get_mol");
    try {
      await expect(providers.flatten3d({ model: input.model, view: "auto" }, stop())).rejects.toEqual(new Error(
        `Component 2 (${smiles}): double bond ${bond}${count} has no E/Z in the input, and ChemDraft drawings cannot store an open double bond yet; specify / or \\ in the SMILES.`));
      expect(read.mock.calls.every(([structure]) => !structure.startsWith("ChemDraft plugin 3D"))).toBe(true);
    } finally { read.mockRestore(); }
  });

  it.each([
    ["carbonyl", "C=O"],
    ["terminal alkene", "C=CCC"],
    ["symmetric alkene", "CC(C)=C(C)C"],
    ["small-ring alkene", "C1=CCCCC1"],
    ["aromatic ring", "c1ccccc1"],
    ["TTF central double bond", "C1=CSC(S1)=C1SC=CS1"],
    // Identical CH2O(CH2CH2O)2CH3 arms on both carbons of each outer TTF double bond
    // preserve the central bond's equivalent sulfur-containing paths.
    ["PEG-armed TTF thread", "C1(COCCOCCOC)=C(COCCOCCOC)SC(S1)=C1SC(COCCOCCOC)=C(COCCOCCOC)S1"],
    ["CBPQT4+", "C1c2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+](cc2)Cc2ccc(cc2)C[n+]2ccc(cc2)-c2cc[n+]1cc2"]
  ])("embeds and flattens %s without an open-E/Z refusal", async (_name, smiles) => {
    const input = await providers.embed3d({ components: [{ smiles }] }, stop());
    const flat = await providers.flatten3d({ model: input.model, view: "auto" }, stop());
    const molecule = flat.objects[0] as MoleculeObject;
    expect(await canonical(molecule.structure)).toBe(await canonical(smiles));
    // Rebuilding from native atoms/bonds must preserve the same chemistry as returned CTAB.
    expect(await canonical(moleculeToMolfileV2000(molecule, { fromDocFrame: true,
      kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents)).toBe(await canonical(smiles));
  }, 30000);

  function invert(model: Plugin3DModel, kind: "tetrahedral" | "E/Z"): number[] {
    const coords = [...model.coords];
    if (kind === "tetrahedral") return coords.map((value, i) => i % 3 === 0 ? -value : value);
    const double = model.bonds.find(bond => bond.order === 2)!;
    const neighbors = model.bonds.filter(bond => bond.order === 1 && (bond.a === double.a || bond.b === double.a))
      .map(bond => bond.a === double.a ? bond.b : bond.a);
    expect(neighbors).toHaveLength(2);
    // Exchange the two ligands on one end, leaving the other end and C=C axis fixed.
    for (let axis = 0; axis < 3; axis++) [coords[neighbors[0] * 3 + axis], coords[neighbors[1] * 3 + axis]] =
      [coords[neighbors[1] * 3 + axis], coords[neighbors[0] * 3 + axis]];
    return coords;
  }

  it.each([["tetrahedral", "C[C@H](F)Cl"], ["E/Z", "F/C=C/Cl"]] as const)(
    "refuses a plugin-edited %s inversion before minimization with component and centre/bond", async (kind, smiles) => {
      const input = await providers.embed3d({ components: [{ smiles: "CC" }, { smiles }] }, stop());
      const component = input.model.components[1];
      const single = await providers.embed3d({ components: [{ smiles }] }, stop());
      const changed = invert(single.model, kind);
      input.model.coords.splice(component.atomStart * 3, component.atomCount * 3, ...changed);
      await expect(providers.minimize3d({ model: input.model, interfragment: false }, stop())).rejects.toThrow(
        kind === "tetrahedral" ? "Component 2: minimize3d input would change specified tetrahedral stereo at centre 2; restore the input geometry." : "Component 2: minimize3d input would change specified E/Z stereo at bond 2-3; restore the input geometry.");
    }
  );

  it.each([["tetrahedral", "C[C@H](F)Cl"], ["E/Z", "F/C=C/Cl"]] as const)(
    "independently reads back and refuses a force-field %s inversion", async (kind, smiles) => {
      const input = await providers.embed3d({ components: [{ smiles }] }, stop());
      const rdkit = await ensureRdkit();
      const getMol = rdkit.get_mol.bind(rdkit);
      const spy = vi.spyOn(rdkit, "get_mol").mockImplementation((structure, details) => {
        const mol = getMol(structure, details);
        if (mol && structure.startsWith("ChemDraft plugin 3D") && details === JSON.stringify({ removeHs: false })) {
          mol.optimize_3d_conformer = () => JSON.stringify({ embedOk: true, coords3dByEngineAtom: invert(input.model, kind),
            forceField: { status: "converged", energy: 0 } });
        }
        return mol;
      });
      try {
        await expect(providers.minimize3d({ model: input.model, interfragment: false }, stop())).rejects.toThrow(
          kind === "tetrahedral" ? "Component 1: minimize3d result would change specified tetrahedral stereo at centre 2; restore the input geometry." : "Component 1: minimize3d result would change specified E/Z stereo at bond 2-3; restore the input geometry.");
      } finally { spy.mockRestore(); }
    }
  );

  it("flattens to native molecules with tetrahedral AND E/Z stereo preserved", async () => {
    const smiles = "C[C@H](F)/C=C/Cl";
    const start = await providers.embed3d({ components: [{ smiles }, { smiles: "CCO" }] }, stop());
    const flat = await providers.flatten3d({ model: start.model, view: "auto" }, stop());
    expect(flat.objects).toHaveLength(2);
    for (const [i, object] of flat.objects.entries()) {
      expect(object.type).toBe("molecule");
      const molecule = object as MoleculeObject;
      expect(await canonical(molecule.structure)).toBe(await canonical(start.model.components[i].smiles));
      expect(flat.depthByAtom[i]).toHaveLength(molecule.atoms.length);
    }
    expect((flat.objects[0] as MoleculeObject).bonds.some(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""))).toBe(true);
  });

  it("flatten3d uses the exact same ScreenPlacement projection as projectSpin", async () => {
    const start = await providers.embed3d({ components: [{ smiles: "CCO" }] }, stop());
    const quat = quatFromAxisAngle([1, 2, 3], 0.4);
    const matrix = quatToViewMatrix(quat);
    const rotation = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
    const flat = await providers.flatten3d({ model: start.model, view: { rotation } }, stop());
    const retained = start.model.atoms.flatMap((atom, i) => atom.addedHydrogen ? [] : [i]);
    const coords = retained.flatMap(i => start.model.coords.slice(i * 3, i * 3 + 3));
    const center = [0, 1, 2].map(axis => coords.filter((_, i) => i % 3 === axis).reduce((a, b) => a + b, 0) / retained.length);
    const placement = { centerX: (rotation[0] * center[0] + rotation[1] * center[1] + rotation[2] * center[2]) * 20,
      centerY: -(rotation[3] * center[0] + rotation[4] * center[1] + rotation[5] * center[2]) * 20, scale: 20 };
    const projected = projectSpin(coords, start.model.bonds.filter(bond => retained.includes(bond.a) && retained.includes(bond.b))
      .map(bond => [retained.indexOf(bond.a), retained.indexOf(bond.b)] as const), quat, placement);
    const molecule = flat.objects[0] as MoleculeObject;
    molecule.atoms.forEach((atom, i) => {
      expect(atom.x).toBeCloseTo(projected.atoms[i].sx, 8);
      expect(atom.y).toBeCloseTo(projected.atoms[i].sy, 8);
      expect(flat.depthByAtom[0][i]).toBeCloseTo(projected.atoms[i].depth, 8);
    });
  });

  it.each([["tetrahedral", "C[C@H](F)Cl"], ["E/Z", "C/C=C/C"],
    ["tetrahedral", "F[C@H]1CCC[C@H](Cl)C1"]] as const)(
    "flatten refuses a specified %s inversion at the named site: %s", async (kind, smiles) => {
      const start = await providers.embed3d({ components: [{ smiles }] }, stop());
      start.model.coords = invert(start.model, kind);
      await expect(providers.flatten3d({ model: start.model, view: "auto" }, stop())).rejects.toThrow(kind === "tetrahedral" ?
        "Component 1: flatten3d input would change specified tetrahedral stereo at centre 2; restore the input geometry." :
        "Component 1: flatten3d input would change specified E/Z stereo at bond 2-3; restore the input geometry.");
    }
  );
});
