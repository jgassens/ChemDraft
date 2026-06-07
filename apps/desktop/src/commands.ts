import {
  MinimalPageSizePresetIds,
  findPageSizePreset,
  type ChemDraftDocument,
  type MoleculeObject,
  type NativeTextStyle,
  type TextSpan
} from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { nativeSingleLetterElements, type NativeSingleLetterElement } from "./documentWorkflow";
import { getToolsetCommandGroups, getToolsetCommandSpecs, getToolsetToggleActions } from "./toolsets";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export interface CommandAvailability {
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface CommandSpec extends CommandDefinition {
  icon: IconName;
  assetName?: ToolbarAssetName;
  shortcut?: string;
  shortcutLabel?: string;
  disabledReason?: string;
}

export function createQuickActions(
  document: ChemDraftDocument,
  selectedMolecule: MoleculeObject | undefined,
  availability: CommandAvailability = {}
): CommandSpec[] {
  const hasObjects = document.pages.some((page) => page.objects.length > 0);

  return [
    { id: "document.new", title: "New Document", icon: "new", shortcut: "Cmd+N", source: "core" },
    { id: "document.open", title: "Open Native Document", icon: "open", shortcut: "Cmd+O", source: "core" },
    { id: "document.save", title: "Save Native Document", icon: "save", shortcut: "Cmd+S", source: "core" },
    { id: "document.saveAs", title: "Save Native Document As", icon: "save", shortcut: "Shift+Cmd+S", source: "core" },
    { id: "edit.undo", title: "Undo", icon: "undo", shortcut: "Cmd+Z", source: "core", enabled: availability.canUndo === true },
    { id: "edit.redo", title: "Redo", icon: "redo", shortcut: "Shift+Cmd+Z", source: "core", enabled: availability.canRedo === true },
    { id: "edit.selectAll", title: "Select All", icon: "select", shortcut: "Cmd+A", source: "core" },
    { id: "clipboard.copy", title: "Copy", icon: "copy", shortcut: "Cmd+C", source: "core", enabled: false },
    { id: "clipboard.paste", title: "Paste", icon: "paste", shortcut: "Cmd+V", source: "core" },
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

export const structureCleanupCommandId = "structure.cleanup2d";

export const editActions: CommandSpec[] = [
  {
    id: "atom.addSingleBondToHoveredAtom",
    title: "Add Single Bond to Hovered Atom",
    icon: "bond",
    source: "core",
    shortcut: "1",
    category: "edit",
    description: "Grow a native single bond from the hovered atom"
  },
  {
    id: "bond.setHoveredBondOrder.single",
    title: "Set Hovered Bond to Single",
    icon: "bond",
    source: "core",
    category: "edit",
    description: "Set the hovered native bond to a single bond"
  },
  {
    id: "bond.setHoveredBondOrder.double",
    title: "Set Hovered Bond to Double",
    icon: "bond",
    source: "core",
    shortcut: "2",
    category: "edit",
    description: "Set the hovered native bond to a double bond"
  },
  {
    id: "bond.setHoveredBondOrder.triple",
    title: "Set Hovered Bond to Triple",
    icon: "bond",
    source: "core",
    shortcut: "3",
    category: "edit",
    description: "Set the hovered native bond to a triple bond"
  },
  {
    id: "atom.addCarbonylToHoveredAtom",
    title: "Add Carbonyl to Hovered Carbon",
    icon: "bond",
    source: "core",
    shortcut: "K",
    category: "edit",
    description: "Grow a neutral C=O from the hovered native carbon atom"
  },
  {
    id: "atom.addPositiveChargeToHoveredAtom",
    title: "Add Positive Charge to Hovered Atom",
    icon: "charge",
    source: "core",
    category: "edit",
    description: "Place a positive charge near the hovered atom"
  },
  {
    id: "atom.addNegativeChargeToHoveredAtom",
    title: "Add Negative Charge to Hovered Atom",
    icon: "charge",
    source: "core",
    category: "edit",
    description: "Place a negative charge near the hovered atom"
  },
  {
    id: "edit.deleteHoveredNativeTarget",
    title: "Delete Selection or Hovered Atom/Bond",
    icon: "select",
    source: "core",
    shortcut: "Backspace",
    category: "edit",
    description: "Delete the selected object, or the hovered native atom or bond"
  },
  {
    id: "edit.forwardDeleteHoveredNativeTarget",
    title: "Forward Delete Selection or Hovered Atom/Bond",
    icon: "select",
    source: "core",
    shortcut: "Delete",
    category: "edit",
    description: "Delete the selected object, or the hovered native atom or bond"
  }
];

export function atomElementCommandId(element: NativeSingleLetterElement): string {
  return `atom.setHoveredElement.${element}`;
}

export const atomElementActions: CommandSpec[] = nativeSingleLetterElements.map((element) => ({
  id: atomElementCommandId(element),
  title: `Set Hovered Atom: ${element}`,
  icon: "atom",
  source: "core",
  category: "edit",
  description: `Set the hovered native atom to ${element}`
}));

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

export const textFontCommands = [
  { id: "text.font.system", title: "Font: System Sans", fontFamily: "Arial, Helvetica, sans-serif" },
  { id: "text.font.times", title: "Font: Times", fontFamily: "Times New Roman, Times, serif" },
  { id: "text.font.courier", title: "Font: Courier", fontFamily: "Courier New, Courier, monospace" },
  { id: "text.font.georgia", title: "Font: Georgia", fontFamily: "Georgia, serif" }
] as const;

export const textSizeCommands = [
  { id: "text.size.10", title: "Size: 10 pt", fontSizePx: 13.333 },
  { id: "text.size.12", title: "Size: 12 pt", fontSizePx: 16 },
  { id: "text.size.14", title: "Size: 14 pt", fontSizePx: 18.667 },
  { id: "text.size.18", title: "Size: 18 pt", fontSizePx: 24 },
  { id: "text.size.20", title: "Size: 20 pt", fontSizePx: 26.667 },
  { id: "text.size.24", title: "Size: 24 pt", fontSizePx: 32 }
] as const;

export const textColorCommands = [
  { id: "text.color.black", title: "Color: Black", color: "#111111" },
  { id: "text.color.white", title: "Color: White", color: "#ffffff" },
  { id: "text.color.blue", title: "Color: Blue", color: "#1f5fbf" },
  { id: "text.color.red", title: "Color: Red", color: "#b3261e" },
  { id: "text.color.green", title: "Color: Green", color: "#1d7f68" },
  { id: "text.color.gray", title: "Color: Gray", color: "#52616b" },
  { id: "text.color.cyan", title: "Color: Cyan", color: "#087ea4" },
  { id: "text.color.magenta", title: "Color: Magenta", color: "#9b287b" },
  { id: "text.color.yellow", title: "Color: Yellow", color: "#d9a400" },
  { id: "text.color.orange", title: "Color: Orange", color: "#c75c12" },
  { id: "text.color.purple", title: "Color: Purple", color: "#6046a8" }
] as const;

export const customTextColorCommandPrefix = "text.color.custom.";

export function textCustomColorCommandId(color: string): string {
  return `${customTextColorCommandPrefix}${normalizeHexColor(color)?.slice(1) ?? "111111"}`;
}

export function textColorForCommand(commandId: string): string | undefined {
  const color = textColorCommands.find((command) => command.id === commandId);
  if (color) {
    return color.color;
  }

  const customColor = commandId.startsWith(customTextColorCommandPrefix)
    ? `#${commandId.slice(customTextColorCommandPrefix.length)}`
    : undefined;

  return normalizeHexColor(customColor);
}

export function normalizeHexColor(color: string | undefined): string | undefined {
  const normalized = color?.trim().replace(/^#/, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (/^[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.split("").map((character) => `${character}${character}`).join("")}`;
  }

  return /^[0-9a-f]{6}$/.test(normalized) ? `#${normalized}` : undefined;
}

export const textLetterSpacingCommands = [
  { id: "text.spacing.tight", title: "Letter Spacing: Tight", letterSpacingPx: -0.4 },
  { id: "text.spacing.normal", title: "Letter Spacing: Normal", letterSpacingPx: 0 },
  { id: "text.spacing.wide", title: "Letter Spacing: Wide", letterSpacingPx: 0.8 }
] as const;

export const textLineHeightCommands = [
  { id: "text.lineHeight.tight", title: "Line Height: Tight", lineHeight: 1 },
  { id: "text.lineHeight.normal", title: "Line Height: Normal", lineHeight: 1.2 },
  { id: "text.lineHeight.loose", title: "Line Height: Loose", lineHeight: 1.55 }
] as const;

export const textParagraphSpacingCommands = [
  { id: "text.paragraph.none", title: "Paragraph Spacing: None", paragraphSpacingPx: 0 },
  { id: "text.paragraph.small", title: "Paragraph Spacing: Small", paragraphSpacingPx: 4 },
  { id: "text.paragraph.medium", title: "Paragraph Spacing: Medium", paragraphSpacingPx: 8 }
] as const;

export const textAlignmentCommands = [
  { id: "text.align.left", title: "Align Text Left", textAlign: "left" },
  { id: "text.align.center", title: "Align Text Center", textAlign: "center" },
  { id: "text.align.right", title: "Align Text Right", textAlign: "right" },
  { id: "text.align.justify", title: "Justify Text", textAlign: "justify" }
] as const satisfies readonly { id: string; title: string; textAlign: NativeTextStyle["textAlign"] }[];

export const textScriptCommands = [
  { id: "text.script.normal", title: "Baseline Text", script: "normal" },
  { id: "text.script.subscript", title: "Subscript Text", script: "subscript" },
  { id: "text.script.superscript", title: "Superscript Text", script: "superscript" }
] as const satisfies readonly { id: string; title: string; script: TextSpan["script"] }[];

export const textToolbarActions: CommandSpec[] = [
  ...textFontCommands.map(({ id, title }) => ({ id, title, icon: "text", source: "core", category: "text" } satisfies CommandSpec)),
  ...textSizeCommands.map(({ id, title }) => ({ id, title, icon: "text", source: "core", category: "text" } satisfies CommandSpec)),
  ...textColorCommands.map(({ id, title }) => ({ id, title, icon: "style", source: "core", category: "text" } satisfies CommandSpec)),
  ...textLetterSpacingCommands.map(({ id, title }) => ({ id, title, icon: "align", source: "core", category: "text" } satisfies CommandSpec)),
  ...textLineHeightCommands.map(({ id, title }) => ({ id, title, icon: "align", source: "core", category: "text" } satisfies CommandSpec)),
  ...textParagraphSpacingCommands.map(({ id, title }) => ({ id, title, icon: "align", source: "core", category: "text" } satisfies CommandSpec)),
  ...textAlignmentCommands.map(({ id, title }) => ({ id, title, icon: "align", source: "core", category: "text" } satisfies CommandSpec)),
  { id: "text.bold", title: "Bold Text", icon: "text", source: "core", category: "text" },
  { id: "text.italic", title: "Italic Text", icon: "text", source: "core", category: "text" },
  { id: "text.underline", title: "Underline Text", icon: "text", source: "core", category: "text" },
  ...textScriptCommands.map(({ id, title }) => ({ id, title, icon: "text", source: "core", category: "text" } satisfies CommandSpec))
];

export function textScriptForCommand(commandId: string): TextSpan["script"] | undefined {
  return textScriptCommands.find((command) => command.id === commandId)?.script;
}

export function textStylePatchForCommand(
  commandId: string,
  currentStyle?: NativeTextStyle
): Partial<NativeTextStyle> | undefined {
  const font = textFontCommands.find((command) => command.id === commandId);
  if (font) {
    return { fontFamily: font.fontFamily };
  }

  const size = textSizeCommands.find((command) => command.id === commandId);
  if (size) {
    return { fontSizePx: size.fontSizePx };
  }

  const color = textColorForCommand(commandId);
  if (color) {
    return { color };
  }

  const spacing = textLetterSpacingCommands.find((command) => command.id === commandId);
  if (spacing) {
    return { letterSpacingPx: spacing.letterSpacingPx };
  }

  const lineHeight = textLineHeightCommands.find((command) => command.id === commandId);
  if (lineHeight) {
    return { lineHeight: lineHeight.lineHeight };
  }

  const paragraph = textParagraphSpacingCommands.find((command) => command.id === commandId);
  if (paragraph) {
    return { paragraphSpacingPx: paragraph.paragraphSpacingPx };
  }

  const alignment = textAlignmentCommands.find((command) => command.id === commandId);
  if (alignment) {
    return { textAlign: alignment.textAlign };
  }

  if (commandId === "text.bold") {
    return { fontWeight: (currentStyle?.fontWeight ?? 400) >= 600 ? 400 : 700 };
  }

  if (commandId === "text.italic") {
    return { fontStyle: currentStyle?.fontStyle === "italic" ? "normal" : "italic" };
  }

  if (commandId === "text.underline") {
    return { textDecoration: currentStyle?.textDecoration === "underline" ? "none" : "underline" };
  }

  return undefined;
}

export function createLayerActions(document: ChemDraftDocument): CommandSpec[] {
  const hasSelection = document.selection.objectIds.length > 0;
  return [
    {
      id: "layout.bringToFront",
      title: "Bring to Front",
      icon: "group",
      assetName: "Custom_Front",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Move the selected document object to the front layer"
    },
    {
      id: "layout.bringForward",
      title: "Bring Forward",
      icon: "group",
      assetName: "Custom_Front",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Move the selected document object one layer forward"
    },
    {
      id: "layout.sendBackward",
      title: "Send Backward",
      icon: "group",
      assetName: "Custom_Back",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Move the selected document object one layer backward"
    },
    {
      id: "layout.sendToBack",
      title: "Send to Back",
      icon: "group",
      assetName: "Custom_Back",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Move the selected document object to the back layer"
    }
  ];
}

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
  {
    id: "style.importStyleSheet",
    title: "Import Style Sheet",
    icon: "style",
    source: "core",
    category: "style",
    enabled: false,
    disabledReason: "Style-sheet file picker is not implemented yet",
    description: "Import a supported external style sheet into a native ChemDraft style preset"
  },
  { id: "style.bondStroke", title: "Bond Stroke 2 px", icon: "style", source: "core", enabled: false },
  { id: "style.textSize", title: "Text Size 10 pt", icon: "text", source: "core", enabled: false },
  { id: "style.preset.synthetic", title: "ChemDraft Synthetic Style", icon: "style", source: "core", enabled: false }
];

export function allPaletteCommands(): CommandSpec[] {
  return withStandaloneDrawingToolCommands(getToolsetCommandSpecs());
}

export function allShellCommands(document: ChemDraftDocument, selectedMolecule?: MoleculeObject): CommandSpec[] {
  return dedupeCommands([
    ...createQuickActions(document, selectedMolecule),
    ...createLayerActions(document),
    ...allPaletteCommands(),
    ...editActions,
    ...atomElementActions,
    ...drawerActions,
    ...viewActions,
    ...pageSizeActions,
    ...pageOrientationActions,
    ...textToolbarActions,
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
