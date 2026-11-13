import { describe, expect, it } from "vitest";
import { Acs1996StylePreset, NativeStylePresets, createEmptyDocument, applyPatches,
  type CompatibilityWarning, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { allShellCommands, nativeStylePresetActions, nativeStylePresetCommandId, nativeStylePresetIdForCommand } from "./commands";
import { buildAppMenuModel, flattenAppMenuCommands, nativeStylePresetMenuItems } from "./appMenu";
import { pluginItemsForNativeMenu } from "./plugins/nativePluginMenu";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { buildGallerySections } from "./toolbars/CustomizeMainToolbar/galleryModel";
import { nativeStylePresetPatchForSelection } from "./nativeStylePresetCommand";
import { normalizeCommittedDocument } from "./documentWorkflow";

function markedPresetFixture() {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 200, y: 100 }, {
    atoms: [{ element: "C", x: 0, y: 0, charge: -1 }, { element: "C", x: 1, y: 0, charge: 0 }],
    bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
  }, "[CH2-]C", undefined, { bondLengthPx: 40 });
  const atom = molecule.atoms[0]!;
  atom.markCharge = -1;
  const mark: ElectronMarkObject = {
    id: "negative", type: "electron-mark", x: atom.x - 26, y: atom.y - 6,
    width: 12, height: 12, rotation: 0, style: {}, markKind: "charge", charge: -1,
    anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id }
  };
  document.pages[0]!.objects = [molecule, mark];
  document.selection.objectIds = [molecule.id];
  return { document, molecule, mark };
}

describe("native style presets through commit normalization", () => {
  it.each(["explicit far", "over-valent"])("applies a preset and carries an %s mark", kind => {
    const { document, molecule, mark } = markedPresetFixture();
    if (kind === "explicit far") {
      mark.x = molecule.atoms[0]!.x + 394;
      mark.atomAssociation = "explicit";
    } else {
      molecule.atoms[0]!.element = "O";
      molecule.bonds[0]!.order = "double";
    }
    const before = normalizeCommittedDocument(document);
    const warnings: CompatibilityWarning[] = [];
    const patch = nativeStylePresetPatchForSelection(before, Acs1996StylePreset.id, [], warnings);
    expect(warnings).toEqual([]);
    expect(patch.patches.length).toBeGreaterThan(0);
    const result = normalizeCommittedDocument(applyPatches(before, patch.patches));
    const styled = result.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
    const styledMark = result.pages[0]!.objects.find(object => object.id === mark.id) as ElectronMarkObject;
    expect(styled.style.stylePresetId).toBe(Acs1996StylePreset.id);
    expect(styled.atoms[0]).toMatchObject({ element: molecule.atoms[0]!.element, formalCharge: -1, markCharge: -1 });
    expect(styled.atoms[1]).toMatchObject({ formalCharge: 0 });
    expect(styled.bonds).toEqual(molecule.bonds);
    expect(styledMark).toMatchObject({ anchor: mark.anchor, charge: -1 });
    expect(styledMark.atomAssociation).toBe(mark.atomAssociation);
    const offset = kind === "explicit far" ? 400 : -20;
    expect(styledMark.x + styledMark.width / 2 - styled.atoms[0]!.x)
      .toBeCloseTo(offset * Acs1996StylePreset.drawing.bondLengthPx / 40, 9);
    expect(normalizeCommittedDocument(result)).toBe(result);
  });

  it.each(["charge", "radical-dot"] as const)("still refuses a preset that would lose a real %s contribution", markKind => {
    const { document, molecule, mark } = markedPresetFixture();
    const atom = molecule.atoms[0]!;
    molecule.atoms[1]!.x = atom.x + 10;
    mark.x = atom.x - 46; // Centre 40 px from the atom; upscaling would lose this legacy anchor.
    if (markKind === "radical-dot") {
      atom.formalCharge = 0;
      delete atom.markCharge;
      atom.markRadicals = 1;
      mark.markKind = markKind;
      delete mark.charge;
    }
    const before = normalizeCommittedDocument(document);
    const warnings: CompatibilityWarning[] = [];
    const patch = nativeStylePresetPatchForSelection(before, Acs1996StylePreset.id, [], warnings);
    expect(patch.patches).toEqual([]);
    expect(warnings).toEqual([{
      code: "style_preset.chemistry_change_refused", objectId: molecule.id,
      message: `Skipped a structure because it would change a ${markKind === "charge" ? "charge" : "radical"}.`
    }]);
    expect(normalizeCommittedDocument(applyPatches(before, patch.patches))).toEqual(before);
  });
});

describe("native style preset command and menu wiring", () => {
  it("registers one value-encoded command per preset without shortcuts", () => {
    const commands = allShellCommands(createEmptyDocument());
    expect(commands.find(command => command.id === nativeStylePresetCommandId("chemdraft.synthetic"))?.title)
      .toBe("ChemDraft Synthetic");
    expect(nativeStylePresetMenuItems().find(item => item.command.commandId === nativeStylePresetCommandId("chemdraft.synthetic"))?.command.label)
      .toBe("Drawing style: ChemDraft Synthetic");
    for (const preset of NativeStylePresets) {
      const id = nativeStylePresetCommandId(preset.id);
      expect(commands.filter(command => command.id === id)).toEqual([expect.objectContaining({ title: preset.name })]);
      expect(nativeStylePresetActions.find(action => action.id === id)?.shortcut).toBeUndefined();
      expect(nativeStylePresetIdForCommand(id)).toBe(preset.id);
    }
    expect(nativeStylePresetIdForCommand("style.preset.apply.unknown")).toBeUndefined();
    expect(nativeStylePresetIdForCommand("style.preset.apply")).toBeUndefined();
    expect(buildGallerySections(commands, [], new Set(), "").find(section => section.id === "stylePresets")?.entries
      .map(entry => entry.commandId)).toEqual(nativeStylePresetActions.map(action => action.id));
  });

  it("treats lassoed fragments as selected molecules rather than styling the document", () => {
    const document = createEmptyDocument();
    const molecule = createSmilesMolecule(document, { x: 100, y: 100 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "O", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "CO");
    document.pages[0]!.objects = [molecule, { ...molecule, id: "untouched" }];
    expect(document.selection.objectIds).toEqual([]);
    const patch = nativeStylePresetPatchForSelection(document, Acs1996StylePreset.id, [molecule.id]);
    const result = applyPatches(document, patch.patches);
    expect(result.pages[0]!.objects[0]!.style.stylePresetId).toBe(Acs1996StylePreset.id);
    expect(result.pages[0]!.objects[1]).toEqual(document.pages[0]!.objects[1]);
    expect(result.styles).toEqual(document.styles);
    expect(result.selection.objectIds).toEqual([molecule.id]);
  });

  it.each<ShortcutPlatform>(["macos", "windows"])("shares the same enabled style items with the native menu on %s", platform => {
    const menu = buildAppMenuModel({ platform, rulersVisible: false, crosshairsVisible: false, canUndo: false,
      canRedo: false, hasSelection: false, hasSelectedMolecule: false, toolbars: [] });
    const structure = menu.find(section => section.id === "structure")!;
    const items = flattenAppMenuCommands([structure]).filter(command => nativeStylePresetIdForCommand(command.commandId));
    expect(items).toHaveLength(NativeStylePresets.length);
    expect(items.find(item => item.commandId === nativeStylePresetCommandId("chemdraft.sketch"))?.label)
      .toBe("Drawing style: Sketch");
    expect(items.map(command => command.commandId)).toEqual(nativeStylePresetActions.map(action => action.id));
    expect(items.every(command => command.enabled && command.coreRouted && !command.accelerator)).toBe(true);
    expect(pluginItemsForNativeMenu(nativeStylePresetMenuItems())).toEqual(items.map(command => ({
      id: command.commandId, label: command.label, enabled: true, coreRouted: true, location: "structure"
    })));
  });
});
