import {
  MinimalPageSizePresetIds,
  findPageSizePreset,
  type ChemDraftDocument,
  type MoleculeObject
} from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { getToolsetCommandGroups, getToolsetCommandSpecs, getToolsetToggleActions } from "./toolsets";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export interface CommandSpec extends CommandDefinition {
  icon: IconName;
  assetName?: ToolbarAssetName;
  shortcut?: string;
  disabledReason?: string;
}

export function createQuickActions(
  document: ChemDraftDocument,
  selectedMolecule: MoleculeObject | undefined
): CommandSpec[] {
  const hasObjects = document.pages.some((page) => page.objects.length > 0);

  return [
    { id: "document.new", title: "New Document", icon: "new", shortcut: "Cmd+N", source: "core" },
    { id: "document.open", title: "Open Native Document", icon: "open", shortcut: "Cmd+O", source: "core" },
    { id: "document.save", title: "Save Native Document", icon: "save", shortcut: "Cmd+S", source: "core" },
    { id: "edit.undo", title: "Undo", icon: "undo", shortcut: "Cmd+Z", source: "core", enabled: false },
    { id: "edit.redo", title: "Redo", icon: "redo", shortcut: "Shift+Cmd+Z", source: "core", enabled: false },
    { id: "clipboard.copy", title: "Copy", icon: "copy", shortcut: "Cmd+C", source: "core", enabled: false },
    { id: "clipboard.paste", title: "Paste", icon: "paste", shortcut: "Cmd+V", source: "core", enabled: false },
    { id: "view.zoomOut", title: "Zoom Out", icon: "zoomOut", shortcut: "Cmd+-", source: "core" },
    { id: "view.zoomIn", title: "Zoom In", icon: "zoomIn", shortcut: "Cmd++", source: "core" },
    { id: "view.toggleToolPalette", title: "Toggle Tool Palette", icon: "palette", source: "core" },
    { id: "export.svg", title: "Export SVG", icon: "export", source: "core" },
    { id: "export.png", title: "Export PNG", icon: "export", source: "core", enabled: hasObjects },
    {
      id: "chemistry.validateSelection",
      title: "Validate Selected Structure",
      icon: "atom",
      source: "core",
      enabled: selectedMolecule !== undefined
    }
  ];
}

export const paletteGroups = getToolsetCommandGroups("core.main");

export const drawerActions: CommandSpec[] = [
  { id: "view.toggleInspector", title: "Toggle Inspector", icon: "inspector", source: "core" },
  { id: "view.togglePlugins", title: "Toggle Plugins", icon: "plugin", source: "core" }
];

export const viewActions: CommandSpec[] = [
  {
    id: "view.toggleRulers",
    title: "Toggle Rulers",
    icon: "grid",
    source: "core",
    shortcut: "Cmd+R",
    category: "view",
    description: "Show or hide document rulers"
  },
  {
    id: "view.toggleCrosshairs",
    title: "Toggle Crosshairs",
    icon: "align",
    source: "core",
    shortcut: "Shift+Cmd+R",
    category: "view",
    description: "Show or hide document crosshairs"
  }
];

export const pageSizeActions: CommandSpec[] = MinimalPageSizePresetIds.map((presetId) => {
  const preset = findPageSizePreset(presetId);
  return {
    id: `page.setSize.${presetId}`,
    title: `Set Page Size: ${preset.title}`,
    icon: "grid",
    source: "core",
    category: "page",
    description: `Set the active page size to ${preset.title}`
  };
});

export const pageOrientationActions: CommandSpec[] = [
  {
    id: "page.setOrientation.portrait",
    title: "Set Page Orientation: Portrait",
    icon: "grid",
    source: "core",
    category: "page",
    description: "Set the active page orientation to portrait"
  },
  {
    id: "page.setOrientation.landscape",
    title: "Set Page Orientation: Landscape",
    icon: "grid",
    source: "core",
    category: "page",
    description: "Set the active page orientation to landscape"
  }
];

export const toolbarCustomizationActions: CommandSpec[] = [
  {
    id: "view.customizeToolbars",
    title: "Customize Toolbars",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: false,
    disabledReason: "Toolbar customization UI is not implemented yet",
    description: "Open the future toolbar customization editor"
  },
  {
    id: "view.toolset.resetLayout",
    title: "Reset Toolbar Layout",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: false,
    disabledReason: "Toolbar customization UI is not implemented yet",
    description: "Reset the selected toolbar layout after customization support is implemented"
  },
  {
    id: "view.toolset.resetAllLayouts",
    title: "Reset All Toolbar Layouts",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: false,
    disabledReason: "Toolbar customization UI is not implemented yet",
    description: "Reset all toolbar customization state after customization support is implemented"
  },
  {
    id: "view.toolset.createUserToolset",
    title: "Create User Toolbar",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: false,
    disabledReason: "Toolbar customization UI is not implemented yet",
    description: "Create a user toolbar after customization support is implemented"
  },
  {
    id: "view.toolset.cloneToolset",
    title: "Clone Toolbar",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: false,
    disabledReason: "Toolbar customization UI is not implemented yet",
    description: "Clone a built-in or plugin toolbar after customization support is implemented"
  }
];

export const styleActions: CommandSpec[] = [
  { id: "style.bondStroke", title: "Bond Stroke 1.2 px", icon: "style", source: "core", enabled: false },
  { id: "style.textSize", title: "Text Size 10 pt", icon: "text", source: "core", enabled: false },
  { id: "style.preset.acs", title: "ACS Style Preset", icon: "style", source: "core", enabled: false }
];

export function allPaletteCommands(): CommandSpec[] {
  return getToolsetCommandSpecs();
}

export function allShellCommands(document: ChemDraftDocument, selectedMolecule?: MoleculeObject): CommandSpec[] {
  return dedupeCommands([
    ...createQuickActions(document, selectedMolecule),
    ...allPaletteCommands(),
    ...drawerActions,
    ...viewActions,
    ...pageSizeActions,
    ...pageOrientationActions,
    ...toolbarCustomizationActions,
    ...getToolsetToggleActions(),
    ...styleActions
  ]);
}

function dedupeCommands(commands: CommandSpec[]): CommandSpec[] {
  const byId = new Map<string, CommandSpec>();
  commands.forEach((command) => {
    if (!byId.has(command.id)) {
      byId.set(command.id, command);
    }
  });

  return [...byId.values()];
}
