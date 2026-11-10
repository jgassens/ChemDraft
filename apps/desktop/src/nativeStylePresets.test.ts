import { describe, expect, it } from "vitest";
import { Acs1996StylePreset, NativeStylePresets, createEmptyDocument, applyPatches } from "@chemdraft/chem-core";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { allShellCommands, nativeStylePresetActions, nativeStylePresetCommandId, nativeStylePresetIdForCommand } from "./commands";
import { buildAppMenuModel, flattenAppMenuCommands, nativeStylePresetMenuItems } from "./appMenu";
import { pluginItemsForNativeMenu } from "./plugins/nativePluginMenu";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { buildGallerySections } from "./toolbars/CustomizeMainToolbar/galleryModel";
import { nativeStylePresetPatchForSelection } from "./nativeStylePresetCommand";

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
