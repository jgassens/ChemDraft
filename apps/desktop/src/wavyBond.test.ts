import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { applyPatches, moleculeToMolfileV2000, moleculeToMolfileV3000 } from "@chemdraft/chem-core";
import { depictSmiles2D, perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { allPaletteCommands } from "./commands";
import { activateDrawingToolCommand, createActiveToolState } from "./drawingTools";
import { createCoreCommandRegistrar } from "./commands/coreCommandRegistrar";
import { getToolsetItemGroups } from "./toolsets";
import { buildGallerySections } from "./toolbars/CustomizeMainToolbar/galleryModel";
import {
  applyNativeBondDisplayStyleTarget, applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeEngineRelayout, applySingleBondToolAtPoint, createPhase4Document,
  getSelectedMolecule, insertNativeMolfileMolecule, nativeBondStyleForToolCommand, stereoPerceptionMolfile,
  type NativeBondOrderTarget
} from "./documentWorkflow";

function existingBond(smiles: string, fromIndex: number, toIndex: number) {
  const inserted = insertNativeMolfileMolecule(createPhase4Document(), { x: 220, y: 220 },
    depictSmiles2D(smiles).molfile, "molfile-v2000");
  const mol = getSelectedMolecule(inserted)!;
  const fromAtomId = mol.atoms[fromIndex]!.id;
  const toAtomId = mol.atoms[toIndex]!.id;
  const bond = mol.bonds.find(candidate =>
    (candidate.fromAtomId === fromAtomId && candidate.toAtomId === toAtomId) ||
    (candidate.fromAtomId === toAtomId && candidate.toAtomId === fromAtomId))!;
  const document = applyPatches(inserted, [{ op: "updateObject", objectId: mol.id, changes: {
    bonds: mol.bonds.map(candidate => candidate.id === bond.id ? { ...candidate, fromAtomId, toAtomId } : candidate)
  } }]);
  const target: NativeBondOrderTarget = {
    kind: "bond", objectId: mol.id, bondId: bond.id, fromAtomId, toAtomId, distanceToPointer: 0
  };
  return { document, target, fromAtomId, toAtomId };
}

describe("wavy bond tool", () => {
  it.each(["perceiver throws", "molfile atom limit"])("keeps stored direction and converts when %s", failure => {
    const initial = existingBond("CC(O)CC", 0, 1);
    const original = getSelectedMolecule(initial.document)!;
    const document = failure === "molfile atom limit"
      ? applyPatches(initial.document, [{ op: "updateObject", objectId: original.id, changes: {
          atoms: [...original.atoms, ...Array.from({ length: 1000 - original.atoms.length }, (_, index) => ({
            ...original.atoms[0]!, id: `extra-${index}`, x: index, y: 0
          }))]
        } }])
      : initial.document;
    const perceive = vi.fn(() => { throw new Error("Perception failed"); });
    const wave = applyNativeBondDisplayStyleTarget(document, initial.target, "wavy", perceive);
    expect(getSelectedMolecule(wave)!.bonds.find(bond => bond.id === initial.target.bondId))
      .toMatchObject({ fromAtomId: initial.fromAtomId, toAtomId: initial.toAtomId, display: { bondStyle: "wavy" } });
    expect(getSelectedMolecule(wave)!.atoms).toEqual(getSelectedMolecule(document)!.atoms);
    if (failure === "molfile atom limit") expect(perceive).not.toHaveBeenCalled();
    else expect(perceive).toHaveBeenCalledOnce();
  });

  it.each([[0, 1], [1, 0]])("puts the narrow end on C2 of butan-2-ol for stored atom indices %i→%i", (from, to) => {
    const { document, target } = existingBond("CC(O)CC", from, to);
    const original = getSelectedMolecule(document)!;
    const c1 = original.atoms[0]!.id;
    const c2 = original.atoms[1]!.id;
    const stereo = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(original));
    expect(stereo.map(atom => atom.isStereoCenter)).toEqual([false, true, false, false, false]);
    expect(stereo[1]!.descriptor).toBe("unspecified");
    const perceive = vi.fn(perceiveStereoCentersFromMolfile);
    const wave = applyNativeBondDisplayStyleTarget(document, target, "wavy", perceive);
    const mol = getSelectedMolecule(wave)!;
    const bondIndex = mol.bonds.findIndex(bond => bond.id === target.bondId);
    const bond = mol.bonds[bondIndex]!;
    expect(bond).toMatchObject({ fromAtomId: c2, toAtomId: c1, order: "single", display: { bondStyle: "wavy" } });
    expect(perceive).toHaveBeenCalledOnce();
    expect(perceive).toHaveBeenCalledWith(stereoPerceptionMolfile(original));
    expect(mol.atoms).toEqual(original.atoms);
    expect(mol.bonds.filter(candidate => candidate.id !== target.bondId))
      .toEqual(original.bonds.filter(candidate => candidate.id !== target.bondId));
    expect(mol.chemistry?.formula).toBe(original.chemistry?.formula);
    expect(wave.selection).toEqual(document.selection);

    const options = { kekuleBondOrders: new Map<string, number>() };
    const v2000 = moleculeToMolfileV2000(mol, options).contents.split("\n");
    expect(v2000[4 + mol.atoms.length + bondIndex]!.slice(0, 12)).toBe("  2  1  1  4");
    expect(moleculeToMolfileV3000(mol, options).contents)
      .toContain(`M  V30 ${bondIndex + 1} 1 2 1 CFG=2`);

    // A later click uses the live bond direction, even with the original hit target.
    const reversed = applyNativeBondDisplayStyleTarget(wave, target, "wavy", perceive);
    expect(getSelectedMolecule(reversed)!.bonds[bondIndex])
      .toMatchObject({ fromAtomId: c1, toAtomId: c2, display: { bondStyle: "wavy" } });
    expect(perceive).toHaveBeenCalledOnce();
    expect(getSelectedMolecule(applyNativeBondDisplayStyleTarget(reversed, target, "wavy", perceive))!.bonds[bondIndex])
      .toEqual(bond);
    expect(perceive).toHaveBeenCalledOnce();
  });

  it.each([
    { smiles: "CCO", from: 0, to: 1, centres: false },
    { smiles: "CCO", from: 1, to: 0, centres: false },
    { smiles: "CC(O)C(O)C", from: 1, to: 3, centres: true },
    { smiles: "CC(O)C(O)C", from: 3, to: 1, centres: true }
  ])("keeps direction for $smiles ($from→$to), with both endpoints stereo=$centres", ({ smiles, from, to, centres }) => {
    const { document, target, fromAtomId, toAtomId } = existingBond(smiles, from, to);
    const stereo = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(getSelectedMolecule(document)!));
    expect([stereo[from]!.isStereoCenter, stereo[to]!.isStereoCenter]).toEqual([centres, centres]);
    const wave = applyNativeBondDisplayStyleTarget(document, target, "wavy", perceiveStereoCentersFromMolfile);
    expect(getSelectedMolecule(wave)!.bonds.find(bond => bond.id === target.bondId))
      .toMatchObject({ fromAtomId, toAtomId, display: { bondStyle: "wavy" } });
  });

  it.each(["wedge", "hashed"] as const)("keeps %s conversion independent of potential stereocentres", style => {
    const { document, target, fromAtomId, toAtomId } = existingBond("CC(O)CC", 0, 1);
    const perceive = vi.fn(perceiveStereoCentersFromMolfile);
    const styled = applyNativeBondDisplayStyleTarget(document, target, style, perceive);
    expect(getSelectedMolecule(styled)!.bonds.find(bond => bond.id === target.bondId))
      .toMatchObject({ fromAtomId, toAtomId, display: { bondStyle: style } });
    expect(perceive).not.toHaveBeenCalled();
  });

  it.each(["wedge", "hashed", "wavy", "bold"] as const)("converts %s to double with the correct document style and no MOL stereo", bondStyle => {
    const doc = applySingleBondToolAtPoint(createPhase4Document(), { x: 220, y: 220 }, { bondStyle });
    const mol = getSelectedMolecule(doc)!;
    const bond = mol.bonds[0]!;
    const target: NativeBondOrderTarget = { ...bond, kind: "bond", objectId: mol.id, bondId: bond.id, distanceToPointer: 0 };
    const doubled = getSelectedMolecule(applyNativeMoleculeBondOrderValueTarget(doc, target, "double"))!;
    expect(doubled.bonds[0]!.order).toBe("double");
    if (bondStyle === "wavy") expect(doubled.bonds[0]!.display).not.toHaveProperty("bondStyle");
    else expect(doubled.bonds[0]!.display?.bondStyle).toBe(bondStyle);
    const options = { kekuleBondOrders: new Map<string, number>() };
    const v2000 = moleculeToMolfileV2000(doubled, options).contents.split("\n");
    expect(v2000[4 + doubled.atoms.length]!.slice(6, 12)).toBe("  2  0");
    const v3000 = moleculeToMolfileV3000(doubled, options).contents;
    expect(v3000).toContain("M  V30 1 2 1 2");
    expect(v3000).not.toContain("CFG=");
  });

  it.each(["macos", "windows"] as const)("registers through the tool factory, appears in both flyouts and Customize (%s)", async platform => {
    const commands = allPaletteCommands();
    const spec = commands.find(command => command.id === "tool.wavyBond")!;
    expect(spec).toMatchObject({ title: "Wavy bond", icon: "wavyBond", enabled: true });
    expect(spec.defaultShortcut).toBeUndefined();
    const registry = new CommandRegistry();
    let state = createActiveToolState();
    const bindings = new Map([[spec.id, { spec, run: () => { state = activateDrawingToolCommand(state, spec, platform).state; } }]]);
    createCoreCommandRegistrar(registry, () => bindings)(bindings);
    await registry.invoke(spec.id);
    expect(state.activeCommandId).toBe(spec.id);
    expect(nativeBondStyleForToolCommand(spec.id)).toBe("wavy");
    for (const id of ["core.main", "core.structure"]) {
      const bond = getToolsetItemGroups(id).flat().find(item => item.id === "tool.bond");
      expect(bond?.submenu?.items).toContainEqual(expect.objectContaining({ id: spec.id, enabled: true, icon: "wavyBond" }));
    }
    const section = buildGallerySections(commands, [], new Set(), "wavy").find(section => section.id === "bonds");
    expect(section?.entries).toContainEqual(expect.objectContaining({ commandId: spec.id, icon: "wavyBond" }));
  });

  it("draws, converts, reverses and returns to wedge without changing the original direction", () => {
    const doc = applySingleBondToolAtPoint(createPhase4Document(), { x: 220, y: 220 }, { bondStyle: "wedge" });
    const mol = getSelectedMolecule(doc)!;
    const bond = mol.bonds[0]!;
    const target: NativeBondOrderTarget = { ...bond, kind: "bond", objectId: mol.id, bondId: bond.id, distanceToPointer: 0 };
    const wave = applyNativeBondDisplayStyleTarget(doc, target, "wavy");
    expect(getSelectedMolecule(wave)!.bonds[0]).toEqual({ ...bond, display: { ...bond.display, bondStyle: "wavy" } });
    const wedge = applyNativeBondDisplayStyleTarget(wave, target, "wedge");
    expect(getSelectedMolecule(wedge)!.bonds[0]).toEqual(bond);
    const reversed = getSelectedMolecule(applyNativeBondDisplayStyleTarget(wave, target, "wavy"))!.bonds[0]!;
    expect(reversed).toMatchObject({ fromAtomId: bond.toAtomId, toAtomId: bond.fromAtomId, display: { bondStyle: "wavy" } });
    const drawn = getSelectedMolecule(applySingleBondToolAtPoint(createPhase4Document(), { x: 220, y: 220 }, { bondStyle: "wavy" }))!;
    expect(drawn.bonds[0]!.display?.bondStyle).toBe("wavy");
    const doubled = applyNativeMoleculeBondOrderValueTarget(wave, target, "double");
    expect(getSelectedMolecule(doubled)!.bonds[0]!.display?.bondStyle).toBeUndefined();
    expect(applyNativeBondDisplayStyleTarget(doubled, target, "wavy")).toBe(doubled);
  });

  it("preserves the wave through app re-layout", () => {
    const doc = applySingleBondToolAtPoint(createPhase4Document(), { x: 220, y: 220 }, { bondStyle: "wavy" });
    const original = getSelectedMolecule(doc)!;
    const result = applyNativeMoleculeEngineRelayout(doc, original.id, relayoutMolfile2D, { perceiveStereo: perceiveStereoCentersFromMolfile });
    const mol = getSelectedMolecule(result)!;
    expect(mol.bonds[0]).toMatchObject({ fromAtomId: original.bonds[0]!.fromAtomId, toAtomId: original.bonds[0]!.toAtomId, display: { bondStyle: "wavy" } });
    expect(perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(mol)).every(a => a.descriptor === "unspecified")).toBe(true);
  });
});
