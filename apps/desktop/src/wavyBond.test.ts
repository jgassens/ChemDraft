import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import { allPaletteCommands } from "./commands";
import { activateDrawingToolCommand, createActiveToolState } from "./drawingTools";
import { createCoreCommandRegistrar } from "./commands/coreCommandRegistrar";
import { getToolsetItemGroups } from "./toolsets";
import { buildGallerySections } from "./toolbars/CustomizeMainToolbar/galleryModel";
import {
  applyNativeBondDisplayStyleTarget, applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeEngineRelayout, applySingleBondToolAtPoint, createPhase4Document,
  getSelectedMolecule, nativeBondStyleForToolCommand, stereoPerceptionMolfile,
  type NativeBondOrderTarget
} from "./documentWorkflow";

describe("wavy bond tool", () => {
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
