import {
  MinimalPageSizePresetIds,
  findPageSizePreset,
  type ChemDraftDocument,
  type GraphicEffect,
  type MoleculeObject,
  type NativeTextStyle,
  type TextSpan
} from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import {
  nativeSingleLetterElements,
  selectedArtBooleanEligibleObjectIds,
  type NativeSingleLetterElement
} from "./documentWorkflow";
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
    { id: "export.open", title: "Export...", icon: "export", shortcut: "Shift+Cmd+E", source: "core" },
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
export const structureCleanup3dCommandId = "structure.cleanup3d";
export const structureRotate3dCommandId = "structure.rotate3d";
export const artBooleanOperationCommandIds = {
  union: "art.boolean.union",
  subtract: "art.boolean.subtract",
  intersect: "art.boolean.intersect",
  split: "art.boolean.split"
} as const;

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

export const objectColorCommands = [
  { id: "object.color.black", title: "Object Color: Black", color: "#111111" },
  { id: "object.color.white", title: "Object Color: White", color: "#ffffff" },
  { id: "object.color.blue", title: "Object Color: Blue", color: "#1f5fbf" },
  { id: "object.color.red", title: "Object Color: Red", color: "#b3261e" },
  { id: "object.color.green", title: "Object Color: Green", color: "#1d7f68" },
  { id: "object.color.gray", title: "Object Color: Gray", color: "#52616b" },
  { id: "object.color.cyan", title: "Object Color: Cyan", color: "#087ea4" },
  { id: "object.color.magenta", title: "Object Color: Magenta", color: "#9b287b" },
  { id: "object.color.yellow", title: "Object Color: Yellow", color: "#d9a400" },
  { id: "object.color.orange", title: "Object Color: Orange", color: "#c75c12" },
  { id: "object.color.purple", title: "Object Color: Purple", color: "#6046a8" }
] as const satisfies readonly {
  id: `object.color.${string}`;
  title: string;
  color: string;
}[];

export const objectStyleTargetCommands = [
  { id: "object.style.target.fill", title: "Target Fill", target: "fill" },
  { id: "object.style.target.stroke", title: "Target Stroke", target: "stroke" }
] as const satisfies readonly { id: string; title: string; target: "fill" | "stroke" }[];

export const objectStyleNoneCommands = [
  { id: "object.style.fill.none", title: "No Fill", target: "fill" },
  { id: "object.style.stroke.none", title: "No Stroke", target: "stroke" }
] as const satisfies readonly { id: string; title: string; target: "fill" | "stroke" }[];

export const objectStyleSwapCommand = {
  id: "object.style.swapFillStroke",
  title: "Swap Fill and Stroke"
} as const;

export const objectGradientReverseCommand = {
  id: "object.gradient.reverseStops",
  title: "Reverse Gradient Stops"
} as const;

export const objectGradientRotateCommand = {
  id: "object.gradient.rotateStops",
  title: "Rotate Gradient Stops"
} as const;

export const objectGradientAddStopCommand = {
  id: "object.gradient.addStop",
  title: "Add Gradient Stop"
} as const;

export const objectGradientDeleteStopCommand = {
  id: "object.gradient.deleteStop",
  title: "Delete Gradient Stop"
} as const;

export type ObjectPaintType = "none" | "solid" | "linear-gradient" | "radial-gradient" | "gloss";

export const objectPaintTypeCommands = [
  { id: "object.paint.type.none", title: "Paint Type: None", paintType: "none", label: "None" },
  { id: "object.paint.type.solid", title: "Paint Type: Solid", paintType: "solid", label: "Solid" },
  { id: "object.paint.type.linearGradient", title: "Paint Type: Linear Gradient", paintType: "linear-gradient", label: "Linear" },
  { id: "object.paint.type.radialGradient", title: "Paint Type: Radial Gradient", paintType: "radial-gradient", label: "Radial" },
  { id: "object.paint.type.gloss", title: "Paint Type: Gloss", paintType: "gloss", label: "Gloss" }
] as const satisfies readonly {
  id: string;
  title: string;
  paintType: ObjectPaintType;
  label: string;
}[];

export type ObjectEffectKind = GraphicEffect["kind"] | "none";
export type ObjectAdjustableEffectKind = Exclude<ObjectEffectKind, "none">;

export const objectEffectCommands = [
  { id: "object.effect.none", title: "Clear Art Effects", effectKind: "none", label: "Clear" },
  { id: "object.effect.shadow", title: "Art Effect: Shadow", effectKind: "shadow", label: "Shadow" },
  { id: "object.effect.glow", title: "Art Effect: Glow", effectKind: "glow", label: "Glow" },
  { id: "object.effect.sketch", title: "Art Effect: Sketch", effectKind: "sketch", label: "Sketch" }
] as const satisfies readonly {
  id: string;
  title: string;
  effectKind: ObjectEffectKind;
  label: string;
}[];

export const objectStrokeWidthCommands = [
  { id: "object.stroke.width.1", title: "Stroke Width: 1 px", strokeWidth: 1 },
  { id: "object.stroke.width.1_5", title: "Stroke Width: 1.5 px", strokeWidth: 1.5 },
  { id: "object.stroke.width.2", title: "Stroke Width: 2 px", strokeWidth: 2 },
  { id: "object.stroke.width.3", title: "Stroke Width: 3 px", strokeWidth: 3 },
  { id: "object.stroke.width.5", title: "Stroke Width: 5 px", strokeWidth: 5 }
] as const satisfies readonly { id: string; title: string; strokeWidth: number }[];

export const objectStrokeDashCommands = [
  { id: "object.stroke.dash.solid", title: "Solid Stroke", strokeDasharray: undefined },
  { id: "object.stroke.dash.dashed", title: "Dashed Stroke", strokeDasharray: "8 6" },
  { id: "object.stroke.dash.long", title: "Long Dash Stroke", strokeDasharray: "14 7" },
  { id: "object.stroke.dash.dotted", title: "Dotted Stroke", strokeDasharray: "0 6", strokeLineCap: "round" },
  { id: "object.stroke.dash.dashDot", title: "Dash-Dot Stroke", strokeDasharray: "8 5 0 5", strokeLineCap: "round" }
] as const satisfies readonly {
  id: string;
  title: string;
  strokeDasharray?: string;
  strokeLineCap?: "round";
}[];

export const objectStrokeLineCapCommands = [
  { id: "object.stroke.cap.butt", title: "Line Ends: Flat", strokeLineCap: "butt" },
  { id: "object.stroke.cap.round", title: "Line Ends: Round", strokeLineCap: "round" },
  { id: "object.stroke.cap.square", title: "Line Ends: Square", strokeLineCap: "square" }
] as const satisfies readonly { id: string; title: string; strokeLineCap: "butt" | "round" | "square" }[];

export const objectStrokeLineJoinCommands = [
  { id: "object.stroke.join.miter", title: "Corners: Sharp", strokeLineJoin: "miter" },
  { id: "object.stroke.join.round", title: "Corners: Round", strokeLineJoin: "round" },
  { id: "object.stroke.join.bevel", title: "Corners: Bevel", strokeLineJoin: "bevel" }
] as const satisfies readonly { id: string; title: string; strokeLineJoin: "miter" | "round" | "bevel" }[];

export const customTextColorCommandPrefix = "text.color.custom.";
export const customObjectColorCommandPrefix = "object.color.custom.";
export const customObjectOpacityCommandPrefix = "object.opacity.custom.";
export const customObjectFillOpacityCommandPrefix = "object.fillOpacity.custom.";
export const customObjectStrokeOpacityCommandPrefix = "object.strokeOpacity.custom.";
export const customObjectGradientStopColorCommandPrefix = "object.gradient.stopColor.";
export const customObjectGradientStopOpacityCommandPrefix = "object.gradient.stopOpacity.";
export const customObjectGradientStopOffsetCommandPrefix = "object.gradient.stopOffset.";
export const customObjectGradientDeleteStopCommandPrefix = "object.gradient.deleteStop.";
export const customObjectEffectColorCommandPrefix = "object.effect.color.";
export const customObjectEffectOpacityCommandPrefix = "object.effect.opacity.";
export const customObjectEffectSizeCommandPrefix = "object.effect.size.";

export function textCustomColorCommandId(color: string): string {
  return `${customTextColorCommandPrefix}${normalizeHexColor(color)?.slice(1) ?? "111111"}`;
}

export function objectCustomColorCommandId(color: string): string {
  return `${customObjectColorCommandPrefix}${normalizeHexColor(color)?.slice(1) ?? "111111"}`;
}

export function objectOpacityCommandId(opacity: number): string {
  return `${customObjectOpacityCommandPrefix}${opacityPercent(opacity)}`;
}

export function objectFillOpacityCommandId(opacity: number): string {
  return `${customObjectFillOpacityCommandPrefix}${opacityPercent(opacity)}`;
}

export function objectStrokeOpacityCommandId(opacity: number): string {
  return `${customObjectStrokeOpacityCommandPrefix}${opacityPercent(opacity)}`;
}

export function objectGradientStopColorCommandId(stopIndex: number, color: string): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  return `${customObjectGradientStopColorCommandPrefix}${normalizeStopIndex(stopIndex)}.${normalized.slice(1)}`;
}

export function objectGradientStopOpacityCommandId(stopIndex: number, opacity: number): string {
  return `${customObjectGradientStopOpacityCommandPrefix}${normalizeStopIndex(stopIndex)}.${opacityPercent(opacity)}`;
}

export function objectGradientStopOffsetCommandId(stopIndex: number, offset: number): string {
  return `${customObjectGradientStopOffsetCommandPrefix}${normalizeStopIndex(stopIndex)}.${unitPercent(offset)}`;
}

export function objectGradientDeleteStopCommandId(stopIndex: number): string {
  return `${customObjectGradientDeleteStopCommandPrefix}${normalizeStopIndex(stopIndex)}`;
}

export function objectEffectColorCommandId(effectKind: ObjectAdjustableEffectKind, color: string): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  return `${customObjectEffectColorCommandPrefix}${effectKind}.${normalized.slice(1)}`;
}

export function objectEffectOpacityCommandId(effectKind: ObjectAdjustableEffectKind, opacity: number): string {
  return `${customObjectEffectOpacityCommandPrefix}${effectKind}.${opacityPercent(opacity)}`;
}

export function objectEffectSizeCommandId(effectKind: ObjectAdjustableEffectKind, size: number): string {
  return `${customObjectEffectSizeCommandPrefix}${effectKind}.${unitPercent(size)}`;
}

export function objectOpacityForCommand(commandId: string): { key: "opacity" | "fillOpacity" | "strokeOpacity"; value: number } | undefined {
  if (commandId.startsWith(customObjectOpacityCommandPrefix)) {
    return { key: "opacity", value: opacityFromCommandSuffix(commandId.slice(customObjectOpacityCommandPrefix.length)) };
  }
  if (commandId.startsWith(customObjectFillOpacityCommandPrefix)) {
    return { key: "fillOpacity", value: opacityFromCommandSuffix(commandId.slice(customObjectFillOpacityCommandPrefix.length)) };
  }
  if (commandId.startsWith(customObjectStrokeOpacityCommandPrefix)) {
    return { key: "strokeOpacity", value: opacityFromCommandSuffix(commandId.slice(customObjectStrokeOpacityCommandPrefix.length)) };
  }
  return undefined;
}

export function objectGradientStopColorForCommand(commandId: string): { stopIndex: number; color: string } | undefined {
  if (!commandId.startsWith(customObjectGradientStopColorCommandPrefix)) {
    return undefined;
  }

  const [stopIndexText, colorText] = commandId.slice(customObjectGradientStopColorCommandPrefix.length).split(".");
  const stopIndex = normalizeStopIndex(Number(stopIndexText));
  const color = normalizeHexColor(colorText ? `#${colorText}` : undefined);
  return color ? { stopIndex, color } : undefined;
}

export function objectGradientStopOpacityForCommand(commandId: string): { stopIndex: number; opacity: number } | undefined {
  if (!commandId.startsWith(customObjectGradientStopOpacityCommandPrefix)) {
    return undefined;
  }

  const [stopIndexText, opacityText] = commandId.slice(customObjectGradientStopOpacityCommandPrefix.length).split(".");
  return {
    stopIndex: normalizeStopIndex(Number(stopIndexText)),
    opacity: opacityFromCommandSuffix(opacityText ?? "100")
  };
}

export function objectGradientStopOffsetForCommand(commandId: string): { stopIndex: number; offset: number } | undefined {
  if (!commandId.startsWith(customObjectGradientStopOffsetCommandPrefix)) {
    return undefined;
  }

  const [stopIndexText, offsetText] = commandId.slice(customObjectGradientStopOffsetCommandPrefix.length).split(".");
  return {
    stopIndex: normalizeStopIndex(Number(stopIndexText)),
    offset: unitFromCommandSuffix(offsetText ?? "0", 0)
  };
}

export function objectGradientDeleteStopIndexForCommand(commandId: string): number | undefined {
  if (!commandId.startsWith(customObjectGradientDeleteStopCommandPrefix)) {
    return undefined;
  }

  return normalizeStopIndex(Number(commandId.slice(customObjectGradientDeleteStopCommandPrefix.length)));
}

export function objectEffectColorForCommand(commandId: string): { effectKind: ObjectAdjustableEffectKind; color: string } | undefined {
  if (!commandId.startsWith(customObjectEffectColorCommandPrefix)) {
    return undefined;
  }

  const [effectKindText, colorText] = commandId.slice(customObjectEffectColorCommandPrefix.length).split(".");
  const effectKind = objectAdjustableEffectKind(effectKindText);
  const color = normalizeHexColor(colorText ? `#${colorText}` : undefined);
  return effectKind && color ? { effectKind, color } : undefined;
}

export function objectEffectOpacityForCommand(commandId: string): { effectKind: ObjectAdjustableEffectKind; opacity: number } | undefined {
  if (!commandId.startsWith(customObjectEffectOpacityCommandPrefix)) {
    return undefined;
  }

  const [effectKindText, opacityText] = commandId.slice(customObjectEffectOpacityCommandPrefix.length).split(".");
  const effectKind = objectAdjustableEffectKind(effectKindText);
  return effectKind
    ? { effectKind, opacity: opacityFromCommandSuffix(opacityText ?? "100") }
    : undefined;
}

export function objectEffectSizeForCommand(commandId: string): { effectKind: ObjectAdjustableEffectKind; size: number } | undefined {
  if (!commandId.startsWith(customObjectEffectSizeCommandPrefix)) {
    return undefined;
  }

  const [effectKindText, sizeText] = commandId.slice(customObjectEffectSizeCommandPrefix.length).split(".");
  const effectKind = objectAdjustableEffectKind(effectKindText);
  return effectKind
    ? { effectKind, size: unitFromCommandSuffix(sizeText ?? "0", 0) }
    : undefined;
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

export function objectColorForCommand(commandId: string): string | undefined {
  const color = objectColorCommands.find((command) => command.id === commandId);
  if (color) {
    return color.color;
  }

  const customColor = commandId.startsWith(customObjectColorCommandPrefix)
    ? `#${commandId.slice(customObjectColorCommandPrefix.length)}`
    : undefined;

  return normalizeHexColor(customColor);
}

export function objectPaintTypeForCommand(commandId: string): ObjectPaintType | undefined {
  return objectPaintTypeCommands.find((command) => command.id === commandId)?.paintType;
}

export function objectEffectForCommand(commandId: string): ObjectEffectKind | undefined {
  return objectEffectCommands.find((command) => command.id === commandId)?.effectKind;
}

function objectAdjustableEffectKind(value: string | undefined): ObjectAdjustableEffectKind | undefined {
  return value === "shadow" || value === "glow" || value === "sketch" ? value : undefined;
}

export function objectPaintTypeCommandId(paintType: ObjectPaintType): string {
  return objectPaintTypeCommands.find((command) => command.paintType === paintType)?.id ??
    objectPaintTypeCommands[1].id;
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

function opacityPercent(opacity: number): number {
  return unitPercent(opacity);
}

function unitPercent(value: number, fallback = 1): number {
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : fallback)) * 100);
}

function opacityFromCommandSuffix(value: string): number {
  return unitFromCommandSuffix(value, 1);
}

function unitFromCommandSuffix(value: string, fallback: number): number {
  const parsed = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(parsed) ? parsed / 100 : fallback));
}

function normalizeStopIndex(stopIndex: number): number {
  return Math.max(0, Math.round(Number.isFinite(stopIndex) ? stopIndex : 0));
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

export const objectStyleActions: CommandSpec[] = [
  ...objectStyleTargetCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectStyleNoneCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  {
    id: objectStyleSwapCommand.id,
    title: objectStyleSwapCommand.title,
    icon: "style",
    source: "core",
    category: "object-style"
  },
  {
    id: objectGradientReverseCommand.id,
    title: objectGradientReverseCommand.title,
    icon: "style",
    source: "core",
    category: "object-style"
  },
  {
    id: objectGradientRotateCommand.id,
    title: objectGradientRotateCommand.title,
    icon: "style",
    source: "core",
    category: "object-style"
  },
  {
    id: objectGradientAddStopCommand.id,
    title: objectGradientAddStopCommand.title,
    icon: "style",
    source: "core",
    category: "object-style"
  },
  {
    id: objectGradientDeleteStopCommand.id,
    title: objectGradientDeleteStopCommand.title,
    icon: "style",
    source: "core",
    category: "object-style"
  },
  ...objectPaintTypeCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectEffectCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectColorCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectStrokeWidthCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectStrokeDashCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectStrokeLineCapCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec)),
  ...objectStrokeLineJoinCommands.map(({ id, title }) => ({
    id,
    title,
    icon: "style",
    source: "core",
    category: "object-style"
  } satisfies CommandSpec))
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
  const hasBooleanSelection = selectedArtBooleanEligibleObjectIds(document).length >= 2;
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
    },
    {
      id: "layout.flipHorizontal",
      title: "Flip Horizontally",
      icon: "align",
      assetName: "Custom_Flip_Horizontal",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Mirror the selected document objects left to right"
    },
    {
      id: "layout.flipVertical",
      title: "Flip Vertically",
      icon: "align",
      assetName: "Custom_Flip_Vertical",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Mirror the selected document objects top to bottom"
    },
    {
      id: artBooleanOperationCommandIds.union,
      title: "Union",
      icon: "group",
      source: "core",
      category: "art",
      enabled: hasBooleanSelection,
      disabledReason: "Select at least two closed art shapes",
      description: "Merge selected closed art shapes into one path"
    },
    {
      id: artBooleanOperationCommandIds.subtract,
      title: "Subtract",
      icon: "group",
      source: "core",
      category: "art",
      enabled: hasBooleanSelection,
      disabledReason: "Select at least two closed art shapes",
      description: "Subtract later selected closed art shapes from the first"
    },
    {
      id: artBooleanOperationCommandIds.intersect,
      title: "Intersect",
      icon: "group",
      source: "core",
      category: "art",
      enabled: hasBooleanSelection,
      disabledReason: "Select at least two closed art shapes",
      description: "Keep only the overlap of selected closed art shapes"
    },
    {
      id: artBooleanOperationCommandIds.split,
      title: "Split",
      icon: "group",
      source: "core",
      category: "art",
      enabled: hasBooleanSelection,
      disabledReason: "Select at least two closed art shapes",
      description: "Split selected closed art shapes into non-overlapping pieces"
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
    ...objectStyleActions,
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
