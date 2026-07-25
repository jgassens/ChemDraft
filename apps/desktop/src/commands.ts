import {
  MinimalPageSizePresetIds,
  findPageSizePreset,
  type ChemDraftDocument,
  type GraphicEffect,
  type MoleculeObject,
  type NativeAtomLabelAlignment,
  type NativeAtomLabelPlacement,
  type NativeBondLineCap,
  type NativeBondSpacingMode,
  type NativeTextStyle,
  type NativeTextFontStyle,
  type TextSpan
} from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import {
  nativeSingleLetterElements,
  selectedGroupObjectIds,
  selectedArtBooleanEligibleObjectIds,
  type NativeSingleLetterElement
} from "./documentWorkflow";
import {
  desktopToolsetRegistry,
  getToolsetCommandGroups,
  getToolsetCommandSpecs,
  getToolsetToggleActions,
  type DesktopToolsetRegistry
} from "./toolsets";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";
import { SPIN3D_DEBUGGER_COMMAND_ID } from "./conformerDebug";

export interface CommandAvailability {
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface ShellCommandOptions {
  availability?: CommandAvailability;
  registry?: DesktopToolsetRegistry;
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
    { id: "clipboard.cut", title: "Cut", icon: "copy", shortcut: "Cmd+X", source: "core", enabled: document.selection.objectIds.length > 0 },
    { id: "clipboard.copy", title: "Copy", icon: "copy", shortcut: "Cmd+C", source: "core", enabled: document.selection.objectIds.length > 0 },
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
export const structureSpin3dCommandId = "structure.spin3d";
export const structureInteractive3dCommandId = "structure.openInteractive3d";
export const structureCleanup3dCommandId = "structure.cleanup3d";
export const structureRotate3dCommandId = "structure.rotate3d";
export const ringInspectorToolsetId = "core.ringInspector";
export const toggleRingInspectorCommandId = "view.toggleRingInspector";
export const moleculeInspectorToolsetId = "core.moleculeInspector";
export const toggleMoleculeInspectorCommandId = "view.toggleMoleculeInspector";
export const artToolsetId = "core.art";
export const textToolsetId = "core.text";
export const moleculeInspectorTemplateImportCommandId = "moleculeInspector.template.import";
export const moleculeInspectorTemplateExportCommandId = "moleculeInspector.template.export";
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

/** Opens the Preferences window (Spin 3D refinement mode, future app settings). */
export const PREFERENCES_COMMAND_ID = "view.togglePreferences";

export const viewActions: CommandSpec[] = [
  {
    id: PREFERENCES_COMMAND_ID,
    title: "Preferencesâ¦",
    icon: "inspector",
    source: "core",
    shortcut: "Cmd+,",
    category: "view",
    description: "Open or close the Preferences window"
  },
  {
    id: SPIN3D_DEBUGGER_COMMAND_ID,
    title: "Toggle 3D Debugger",
    icon: "inspector",
    source: "core",
    category: "view",
    description: "Open or close the 3D spin debugger window"
  },
  {
    id: toggleRingInspectorCommandId,
    title: "Toggle Rings Toolbar",
    icon: "inspector",
    source: "core",
    category: "view",
    description: "Open or close the Rings toolbar"
  },
  {
    id: toggleMoleculeInspectorCommandId,
    title: "Toggle Molecule Inspector",
    icon: "inspector",
    source: "core",
    category: "view",
    description: "Open or close the Molecule Inspector"
  },
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

/** Opens the custom page-size dialog (File â¸ Page Setup â¸ Custom Sizeâ¦). */
export const PAGE_CUSTOM_SIZE_COMMAND_ID = "page.setSizeCustom";

export const pageCustomSizeAction: CommandSpec = {
  id: PAGE_CUSTOM_SIZE_COMMAND_ID,
  title: "Set Page Size: Customâ¦",
  icon: "grid",
  source: "core",
  category: "page",
  description: "Enter a custom page width and height in inches or millimeters"
};

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

export const distributeModeCommandIds = {
  centers: "layout.distribute.mode.centers",
  spacing: "layout.distribute.mode.spacing"
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
export const customObjectEffectDisableCommandPrefix = "object.effect.disable.";
export const customMoleculeRingFillColorCommandPrefix = "molecule.ring.fill.color:";
export const customMoleculeRingFillNoneCommandPrefix = "molecule.ring.fill.none:";
export const customMoleculeRingFillOpacityCommandPrefix = "molecule.ring.fill.opacity:";
export const customMoleculeRingEffectCommandPrefix = "molecule.ring.effect:";
export const customMoleculeRingEffectColorCommandPrefix = "molecule.ring.effect.color:";
export const customMoleculeRingEffectOpacityCommandPrefix = "molecule.ring.effect.opacity:";
export const customMoleculeRingEffectSizeCommandPrefix = "molecule.ring.effect.size:";
export const customMoleculeRingEffectDisableCommandPrefix = "molecule.ring.effect.disable:";
export const customMoleculeStructureChainAngleCommandPrefix = "molecule.structure.chainAngle:";
export const customMoleculeStructureBondLengthCommandPrefix = "molecule.structure.bondLength:";
export const customMoleculeStructureBondStrokeWidthCommandPrefix = "molecule.structure.bondStrokeWidth:";
export const customMoleculeStructureBondBoldWidthCommandPrefix = "molecule.structure.bondBoldWidth:";
export const customMoleculeStructureBondColorCommandPrefix = "molecule.structure.bondColor:";
export const customMoleculeStructureBondLineCapCommandPrefix = "molecule.structure.bondLineCap:";
export const customMoleculeStructureBondSpacingModeCommandPrefix = "molecule.structure.bondSpacingMode:";
export const customMoleculeStructureBondSpacingPercentCommandPrefix = "molecule.structure.bondSpacingPercent:";
export const customMoleculeStructureMultipleBondGapCommandPrefix = "molecule.structure.multipleBondGap:";
export const customMoleculeStructureDoubleBondInsetCommandPrefix = "molecule.structure.doubleBondInset:";
export const customMoleculeStructureBondMarginWidthCommandPrefix = "molecule.structure.bondMarginWidth:";
export const customMoleculeStructureBondHashSpacingCommandPrefix = "molecule.structure.bondHashSpacing:";
export const customMoleculeStructureOverlapClearanceCommandPrefix = "molecule.structure.overlapClearance:";
export const customMoleculeStructureAtomQueryIndicatorsCommandPrefix = "molecule.structure.atomIndicators.query:";
export const customMoleculeStructureAtomStereochemistryCommandPrefix = "molecule.structure.atomIndicators.stereochemistry:";
export const customMoleculeStructureAtomEnhancedStereochemistryCommandPrefix = "molecule.structure.atomIndicators.enhancedStereochemistry:";
export const customMoleculeStructureAtomNumbersCommandPrefix = "molecule.structure.atomIndicators.atomNumbers:";
export const customMoleculeStructureBondQueryIndicatorsCommandPrefix = "molecule.structure.bondIndicators.query:";
export const customMoleculeStructureBondStereochemistryCommandPrefix = "molecule.structure.bondIndicators.stereochemistry:";
export const customMoleculeStructureBondReactionIndicatorsCommandPrefix = "molecule.structure.bondIndicators.reaction:";
export const customMoleculeAtomLabelFontFamilyCommandPrefix = "molecule.atomLabel.fontFamily:";
export const customMoleculeAtomLabelFontFaceCommandPrefix = "molecule.atomLabel.fontFace:";
export const customMoleculeAtomLabelFontSizeCommandPrefix = "molecule.atomLabel.fontSize:";
export const customMoleculeAtomLabelColorCommandPrefix = "molecule.atomLabel.color:";
// Text objects can be set to any installed system font family, carried as a dynamic
// command id (family name percent-encoded) rather than one of the fixed presets.
export const customTextFontFamilyCommandPrefix = "text.font.family:";
export const customMoleculeAtomLabelBackgroundColorCommandPrefix = "molecule.atomLabel.backgroundColor:";
export const customMoleculeAtomLabelPaddingCommandPrefix = "molecule.atomLabel.padding:";
export const customMoleculeAtomLabelBondClearanceCommandPrefix = "molecule.atomLabel.bondClearance:";
export const customMoleculeAtomLabelAlignmentCommandPrefix = "molecule.atomLabel.alignment:";
export const customMoleculeAtomLabelPlacementCommandPrefix = "molecule.atomLabel.placement:";
export const customMoleculeAtomLabelShowTerminalCarbonsCommandPrefix = "molecule.atomLabel.showTerminalCarbons:";
export const customMoleculeAtomLabelHideImplicitHydrogensCommandPrefix = "molecule.atomLabel.hideImplicitHydrogens:";

export const moleculeStructureNumberRanges = {
  chainAngleDegrees: { min: 1, max: 179, step: 1 },
  bondLengthPx: { min: 8, max: 120, step: 0.5 },
  bondStrokeWidthPx: { min: 0.25, max: 12, step: 0.25 },
  bondBoldWidthPx: { min: 0.25, max: 32, step: 0.25 },
  bondSpacingPercent: { min: 1, max: 100, step: 1 },
  multipleBondGapPx: { min: 0.5, max: 24, step: 0.25 },
  doubleBondInsetPx: { min: 0, max: 24, step: 0.25 },
  bondMarginWidthPx: { min: 0, max: 32, step: 0.25 },
  bondHashSpacingPx: { min: 2, max: 32, step: 0.25 },
  bondOverlapClearancePx: { min: 0, max: 32, step: 0.5 }
} as const;

export const moleculeAtomLabelNumberRanges = {
  fontSizePx: { min: 6, max: 96, step: 0.5 },
  paddingPx: { min: 0, max: 16, step: 0.25 },
  bondClearancePx: { min: 0, max: 32, step: 0.5 }
} as const;

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

export function objectEffectDisableCommandId(effectKind: ObjectAdjustableEffectKind): string {
  return `${customObjectEffectDisableCommandPrefix}${effectKind}`;
}

export function moleculeRingFillColorCommandId(ringKey: string, color: string): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  return `${customMoleculeRingFillColorCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${normalized.slice(1)}`;
}

export function moleculeRingFillNoneCommandId(ringKey: string): string {
  return `${customMoleculeRingFillNoneCommandPrefix}${encodeMoleculeRingKey(ringKey)}`;
}

export function moleculeRingFillOpacityCommandId(ringKey: string, opacity: number): string {
  return `${customMoleculeRingFillOpacityCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${opacityPercent(opacity)}`;
}

export function moleculeRingEffectCommandId(ringKey: string, effectKind: ObjectEffectKind): string {
  return `${customMoleculeRingEffectCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${effectKind}`;
}

export function moleculeRingEffectColorCommandId(
  ringKey: string,
  effectKind: ObjectAdjustableEffectKind,
  color: string
): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  return `${customMoleculeRingEffectColorCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${effectKind}:${normalized.slice(1)}`;
}

export function moleculeRingEffectOpacityCommandId(
  ringKey: string,
  effectKind: ObjectAdjustableEffectKind,
  opacity: number
): string {
  return `${customMoleculeRingEffectOpacityCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${effectKind}:${opacityPercent(opacity)}`;
}

export function moleculeRingEffectSizeCommandId(
  ringKey: string,
  effectKind: ObjectAdjustableEffectKind,
  size: number
): string {
  return `${customMoleculeRingEffectSizeCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${effectKind}:${unitPercent(size)}`;
}

export function moleculeRingEffectDisableCommandId(ringKey: string, effectKind: ObjectAdjustableEffectKind): string {
  return `${customMoleculeRingEffectDisableCommandPrefix}${encodeMoleculeRingKey(ringKey)}:${effectKind}`;
}

export function moleculeStructureChainAngleCommandId(value: number): string {
  return `${customMoleculeStructureChainAngleCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondLengthCommandId(value: number): string {
  return `${customMoleculeStructureBondLengthCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondStrokeWidthCommandId(value: number): string {
  return `${customMoleculeStructureBondStrokeWidthCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondBoldWidthCommandId(value: number): string {
  return `${customMoleculeStructureBondBoldWidthCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondColorCommandId(color: string): string {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return `${customMoleculeStructureBondColorCommandPrefix}${normalized.slice(1)}`;
}

export function moleculeStructureBondLineCapCommandId(value: NativeBondLineCap): string {
  return `${customMoleculeStructureBondLineCapCommandPrefix}${value}`;
}

export function moleculeStructureBondSpacingModeCommandId(value: NativeBondSpacingMode): string {
  return `${customMoleculeStructureBondSpacingModeCommandPrefix}${value}`;
}

export function moleculeStructureBondSpacingPercentCommandId(value: number): string {
  return `${customMoleculeStructureBondSpacingPercentCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureMultipleBondGapCommandId(value: number): string {
  return `${customMoleculeStructureMultipleBondGapCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureDoubleBondInsetCommandId(value: number): string {
  return `${customMoleculeStructureDoubleBondInsetCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondMarginWidthCommandId(value: number): string {
  return `${customMoleculeStructureBondMarginWidthCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureBondHashSpacingCommandId(value: number): string {
  return `${customMoleculeStructureBondHashSpacingCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureOverlapClearanceCommandId(value: number): string {
  return `${customMoleculeStructureOverlapClearanceCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeStructureAtomQueryIndicatorsCommandId(value: boolean): string {
  return `${customMoleculeStructureAtomQueryIndicatorsCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureAtomStereochemistryCommandId(value: boolean): string {
  return `${customMoleculeStructureAtomStereochemistryCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureAtomEnhancedStereochemistryCommandId(value: boolean): string {
  return `${customMoleculeStructureAtomEnhancedStereochemistryCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureAtomNumbersCommandId(value: boolean): string {
  return `${customMoleculeStructureAtomNumbersCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureBondQueryIndicatorsCommandId(value: boolean): string {
  return `${customMoleculeStructureBondQueryIndicatorsCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureBondStereochemistryCommandId(value: boolean): string {
  return `${customMoleculeStructureBondStereochemistryCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeStructureBondReactionIndicatorsCommandId(value: boolean): string {
  return `${customMoleculeStructureBondReactionIndicatorsCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeAtomLabelFontFamilyCommandId(fontFamily: string): string {
  return `${customMoleculeAtomLabelFontFamilyCommandPrefix}${encodeURIComponent(fontFamily.trim())}`;
}

export function textFontFamilyCommandId(fontFamily: string): string {
  return `${customTextFontFamilyCommandPrefix}${encodeURIComponent(fontFamily.trim())}`;
}

export function moleculeAtomLabelFontFaceCommandId(weight: number, style: NativeTextFontStyle): string {
  return `${customMoleculeAtomLabelFontFaceCommandPrefix}${Math.round(weight)}:${style}`;
}

export function moleculeAtomLabelFontSizeCommandId(value: number): string {
  return `${customMoleculeAtomLabelFontSizeCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeAtomLabelColorCommandId(color: string): string {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return `${customMoleculeAtomLabelColorCommandPrefix}${normalized.slice(1)}`;
}

export function moleculeAtomLabelBackgroundColorCommandId(color: string): string {
  const normalized = color === "transparent" ? "transparent" : normalizeHexColor(color)?.slice(1) ?? "ffffff";
  return `${customMoleculeAtomLabelBackgroundColorCommandPrefix}${normalized}`;
}

// Resolves the command for the atom-label Background mode select. Selecting
// "solid" must never leave the value transparent (the old one-way trap), so it
// restores the current color, else the last solid color seen, else white.
export function moleculeAtomLabelBackgroundCommandId(
  mode: string,
  currentValue: string | null | undefined,
  lastSolidColor: string | null | undefined
): string {
  if (mode === "transparent") {
    return moleculeAtomLabelBackgroundColorCommandId("transparent");
  }
  const solid =
    normalizeHexColor(currentValue ?? undefined) ??
    normalizeHexColor(lastSolidColor ?? undefined) ??
    "#ffffff";
  return moleculeAtomLabelBackgroundColorCommandId(solid);
}

export function moleculeAtomLabelPaddingCommandId(value: number): string {
  return `${customMoleculeAtomLabelPaddingCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeAtomLabelBondClearanceCommandId(value: number): string {
  return `${customMoleculeAtomLabelBondClearanceCommandPrefix}${canonicalCommandNumber(value)}`;
}

export function moleculeAtomLabelAlignmentCommandId(value: NativeAtomLabelAlignment): string {
  return `${customMoleculeAtomLabelAlignmentCommandPrefix}${value}`;
}

export function moleculeAtomLabelPlacementCommandId(value: NativeAtomLabelPlacement): string {
  return `${customMoleculeAtomLabelPlacementCommandPrefix}${value}`;
}

export function moleculeAtomLabelShowTerminalCarbonsCommandId(value: boolean): string {
  return `${customMoleculeAtomLabelShowTerminalCarbonsCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeAtomLabelHideImplicitHydrogensCommandId(value: boolean): string {
  return `${customMoleculeAtomLabelHideImplicitHydrogensCommandPrefix}${value ? "true" : "false"}`;
}

export function moleculeRingFillColorForCommand(commandId: string): { ringKey: string; color: string } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingFillColorCommandPrefix, 2);
  if (!parsed) {
    return undefined;
  }

  const color = normalizeHexColor(parsed.parts[1] ? `#${parsed.parts[1]}` : undefined);
  return color ? { ringKey: parsed.ringKey, color } : undefined;
}

export function moleculeRingFillNoneForCommand(commandId: string): { ringKey: string } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingFillNoneCommandPrefix, 1);
  return parsed ? { ringKey: parsed.ringKey } : undefined;
}

export function moleculeRingFillOpacityForCommand(commandId: string): { ringKey: string; opacity: number } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingFillOpacityCommandPrefix, 2);
  return parsed
    ? { ringKey: parsed.ringKey, opacity: opacityFromCommandSuffix(parsed.parts[1] ?? "100") }
    : undefined;
}

export function moleculeRingEffectForCommand(commandId: string): { ringKey: string; effectKind: ObjectEffectKind } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingEffectCommandPrefix, 2);
  const effectKind = objectEffectKind(parsed?.parts[1]);
  return parsed && effectKind ? { ringKey: parsed.ringKey, effectKind } : undefined;
}

export function moleculeRingEffectColorForCommand(
  commandId: string
): { ringKey: string; effectKind: ObjectAdjustableEffectKind; color: string } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingEffectColorCommandPrefix, 3);
  const effectKind = objectAdjustableEffectKind(parsed?.parts[1]);
  const color = normalizeHexColor(parsed?.parts[2] ? `#${parsed.parts[2]}` : undefined);
  return parsed && effectKind && color
    ? { ringKey: parsed.ringKey, effectKind, color }
    : undefined;
}

export function moleculeRingEffectOpacityForCommand(
  commandId: string
): { ringKey: string; effectKind: ObjectAdjustableEffectKind; opacity: number } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingEffectOpacityCommandPrefix, 3);
  const effectKind = objectAdjustableEffectKind(parsed?.parts[1]);
  return parsed && effectKind
    ? { ringKey: parsed.ringKey, effectKind, opacity: opacityFromCommandSuffix(parsed.parts[2] ?? "100") }
    : undefined;
}

export function moleculeRingEffectSizeForCommand(
  commandId: string
): { ringKey: string; effectKind: ObjectAdjustableEffectKind; size: number } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingEffectSizeCommandPrefix, 3);
  const effectKind = objectAdjustableEffectKind(parsed?.parts[1]);
  return parsed && effectKind
    ? { ringKey: parsed.ringKey, effectKind, size: unitFromCommandSuffix(parsed.parts[2] ?? "0", 0) }
    : undefined;
}

export function moleculeRingEffectDisableForCommand(
  commandId: string
): { ringKey: string; effectKind: ObjectAdjustableEffectKind } | undefined {
  const parsed = parseMoleculeRingCommand(commandId, customMoleculeRingEffectDisableCommandPrefix, 2);
  const effectKind = objectAdjustableEffectKind(parsed?.parts[1]);
  return parsed && effectKind ? { ringKey: parsed.ringKey, effectKind } : undefined;
}

export function moleculeStructureChainAngleForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureChainAngleCommandPrefix, moleculeStructureNumberRanges.chainAngleDegrees);
}

export function moleculeStructureBondLengthForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureBondLengthCommandPrefix, moleculeStructureNumberRanges.bondLengthPx);
}

export function moleculeStructureBondStrokeWidthForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureBondStrokeWidthCommandPrefix, moleculeStructureNumberRanges.bondStrokeWidthPx);
}

export function moleculeStructureBondBoldWidthForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureBondBoldWidthCommandPrefix, moleculeStructureNumberRanges.bondBoldWidthPx);
}

export function moleculeStructureBondColorForCommand(commandId: string): { color: string } | undefined {
  const color = colorCommandValue(commandId, customMoleculeStructureBondColorCommandPrefix);
  return color ? { color } : undefined;
}

export function moleculeStructureBondLineCapForCommand(commandId: string): { value: NativeBondLineCap } | undefined {
  if (!commandId.startsWith(customMoleculeStructureBondLineCapCommandPrefix)) {
    return undefined;
  }
  const value = commandId.slice(customMoleculeStructureBondLineCapCommandPrefix.length);
  return value === "butt" || value === "round" || value === "square" ? { value } : undefined;
}

export function moleculeStructureBondSpacingModeForCommand(commandId: string): { value: NativeBondSpacingMode } | undefined {
  if (!commandId.startsWith(customMoleculeStructureBondSpacingModeCommandPrefix)) {
    return undefined;
  }
  const value = commandId.slice(customMoleculeStructureBondSpacingModeCommandPrefix.length);
  return value === "absolute" || value === "percent" ? { value } : undefined;
}

export function moleculeStructureBondSpacingPercentForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(
    commandId,
    customMoleculeStructureBondSpacingPercentCommandPrefix,
    moleculeStructureNumberRanges.bondSpacingPercent
  );
}

export function moleculeStructureMultipleBondGapForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureMultipleBondGapCommandPrefix, moleculeStructureNumberRanges.multipleBondGapPx);
}

export function moleculeStructureDoubleBondInsetForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureDoubleBondInsetCommandPrefix, moleculeStructureNumberRanges.doubleBondInsetPx);
}

export function moleculeStructureBondMarginWidthForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureBondMarginWidthCommandPrefix, moleculeStructureNumberRanges.bondMarginWidthPx);
}

export function moleculeStructureBondHashSpacingForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureBondHashSpacingCommandPrefix, moleculeStructureNumberRanges.bondHashSpacingPx);
}

export function moleculeStructureOverlapClearanceForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeStructureOverlapClearanceCommandPrefix, moleculeStructureNumberRanges.bondOverlapClearancePx);
}

export function moleculeStructureAtomQueryIndicatorsForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureAtomQueryIndicatorsCommandPrefix);
}

export function moleculeStructureAtomStereochemistryForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureAtomStereochemistryCommandPrefix);
}

export function moleculeStructureAtomEnhancedStereochemistryForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureAtomEnhancedStereochemistryCommandPrefix);
}

export function moleculeStructureAtomNumbersForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureAtomNumbersCommandPrefix);
}

export function moleculeStructureBondQueryIndicatorsForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureBondQueryIndicatorsCommandPrefix);
}

export function moleculeStructureBondStereochemistryForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureBondStereochemistryCommandPrefix);
}

export function moleculeStructureBondReactionIndicatorsForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeStructureBondReactionIndicatorsCommandPrefix);
}

export function moleculeAtomLabelFontFamilyForCommand(commandId: string): { fontFamily: string } | undefined {
  if (!commandId.startsWith(customMoleculeAtomLabelFontFamilyCommandPrefix)) {
    return undefined;
  }
  const encoded = commandId.slice(customMoleculeAtomLabelFontFamilyCommandPrefix.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded).trim();
  } catch {
    return undefined;
  }
  return decoded.length > 0 && decoded.length <= 256 && !/[\u0000-\u001f\u007f]/.test(decoded)
    ? { fontFamily: decoded }
    : undefined;
}

export function textFontFamilyForCommand(commandId: string): { fontFamily: string } | undefined {
  if (!commandId.startsWith(customTextFontFamilyCommandPrefix)) {
    return undefined;
  }
  const encoded = commandId.slice(customTextFontFamilyCommandPrefix.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded).trim();
  } catch {
    return undefined;
  }
  const hasControlCharacter = [...decoded].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  return decoded.length > 0 && decoded.length <= 256 && !hasControlCharacter
    ? { fontFamily: decoded }
    : undefined;
}

export function moleculeAtomLabelFontFaceForCommand(commandId: string): { weight: number; style: NativeTextFontStyle } | undefined {
  if (!commandId.startsWith(customMoleculeAtomLabelFontFaceCommandPrefix)) {
    return undefined;
  }
  const parts = commandId.slice(customMoleculeAtomLabelFontFaceCommandPrefix.length).split(":");
  if (parts.length !== 2) {
    return undefined;
  }
  const weight = Number(parts[0]);
  const style = parts[1];
  return Number.isInteger(weight) && weight >= 1 && weight <= 1000 && (style === "normal" || style === "italic")
    ? { weight, style }
    : undefined;
}

export function moleculeAtomLabelFontSizeForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeAtomLabelFontSizeCommandPrefix, moleculeAtomLabelNumberRanges.fontSizePx);
}

export function moleculeAtomLabelColorForCommand(commandId: string): { color: string } | undefined {
  const color = colorCommandValue(commandId, customMoleculeAtomLabelColorCommandPrefix);
  return color ? { color } : undefined;
}

export function moleculeAtomLabelBackgroundColorForCommand(commandId: string): { color: string } | undefined {
  if (!commandId.startsWith(customMoleculeAtomLabelBackgroundColorCommandPrefix)) {
    return undefined;
  }
  const value = commandId.slice(customMoleculeAtomLabelBackgroundColorCommandPrefix.length);
  if (value === "transparent") {
    return { color: "transparent" };
  }
  const color = normalizeHexColor(value ? `#${value}` : undefined);
  return color ? { color } : undefined;
}

export function moleculeAtomLabelPaddingForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeAtomLabelPaddingCommandPrefix, moleculeAtomLabelNumberRanges.paddingPx);
}

export function moleculeAtomLabelBondClearanceForCommand(commandId: string): { value: number } | undefined {
  return numberCommandValue(commandId, customMoleculeAtomLabelBondClearanceCommandPrefix, moleculeAtomLabelNumberRanges.bondClearancePx);
}

export function moleculeAtomLabelAlignmentForCommand(commandId: string): { value: NativeAtomLabelAlignment } | undefined {
  if (!commandId.startsWith(customMoleculeAtomLabelAlignmentCommandPrefix)) {
    return undefined;
  }
  const value = commandId.slice(customMoleculeAtomLabelAlignmentCommandPrefix.length);
  return value === "automatic" || value === "left" || value === "center" || value === "right" ? { value } : undefined;
}

export function moleculeAtomLabelPlacementForCommand(commandId: string): { value: NativeAtomLabelPlacement } | undefined {
  if (!commandId.startsWith(customMoleculeAtomLabelPlacementCommandPrefix)) {
    return undefined;
  }
  const value = commandId.slice(customMoleculeAtomLabelPlacementCommandPrefix.length);
  return value === "automatic" || value === "above" || value === "below" ? { value } : undefined;
}

export function moleculeAtomLabelShowTerminalCarbonsForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeAtomLabelShowTerminalCarbonsCommandPrefix);
}

export function moleculeAtomLabelHideImplicitHydrogensForCommand(commandId: string): { value: boolean } | undefined {
  return booleanCommandValue(commandId, customMoleculeAtomLabelHideImplicitHydrogensCommandPrefix);
}

function numberCommandValue(
  commandId: string,
  prefix: string,
  range: { min: number; max: number }
): { value: number } | undefined {
  if (!commandId.startsWith(prefix)) {
    return undefined;
  }
  const suffix = commandId.slice(prefix.length);
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(suffix)) {
    return undefined;
  }
  const value = Number(suffix);
  if (!Number.isFinite(value) || Object.is(value, -0) || value < range.min || value > range.max) {
    return undefined;
  }
  return { value };
}

function colorCommandValue(commandId: string, prefix: string): string | undefined {
  if (!commandId.startsWith(prefix)) {
    return undefined;
  }
  const suffix = commandId.slice(prefix.length);
  return normalizeHexColor(suffix ? `#${suffix}` : undefined);
}

function booleanCommandValue(commandId: string, prefix: string): { value: boolean } | undefined {
  if (!commandId.startsWith(prefix)) {
    return undefined;
  }
  const suffix = commandId.slice(prefix.length);
  if (suffix === "true") {
    return { value: true };
  }
  if (suffix === "false") {
    return { value: false };
  }
  return undefined;
}

function canonicalCommandNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isFinite(normalized)
    ? Number(normalized.toFixed(3)).toString()
    : "0";
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

export function objectEffectDisableForCommand(commandId: string): ObjectAdjustableEffectKind | undefined {
  if (!commandId.startsWith(customObjectEffectDisableCommandPrefix)) {
    return undefined;
  }

  return objectAdjustableEffectKind(commandId.slice(customObjectEffectDisableCommandPrefix.length));
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

function objectEffectKind(value: string | undefined): ObjectEffectKind | undefined {
  return value === "none" || value === "shadow" || value === "glow" || value === "sketch" ? value : undefined;
}

function encodeMoleculeRingKey(ringKey: string): string {
  return encodeURIComponent(ringKey);
}

function decodeMoleculeRingKey(encodedRingKey: string | undefined): string | undefined {
  if (!encodedRingKey) {
    return undefined;
  }

  try {
    return decodeURIComponent(encodedRingKey);
  } catch {
    return undefined;
  }
}

function parseMoleculeRingCommand(
  commandId: string,
  prefix: string,
  minParts: number
): { ringKey: string; parts: string[] } | undefined {
  if (!commandId.startsWith(prefix)) {
    return undefined;
  }

  const parts = commandId.slice(prefix.length).split(":");
  if (parts.length < minParts) {
    return undefined;
  }

  const ringKey = decodeMoleculeRingKey(parts[0]);
  return ringKey ? { ringKey, parts } : undefined;
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

  const customFont = textFontFamilyForCommand(commandId);
  if (customFont) {
    return { fontFamily: customFont.fontFamily };
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
  const hasMultiSelection = document.selection.objectIds.length >= 2;
  const hasDistributableSelection = document.selection.objectIds.length >= 3;
  const hasSelectedGroup = selectedGroupObjectIds(document).length > 0;
  const hasBooleanSelection = selectedArtBooleanEligibleObjectIds(document).length >= 2;
  return [
    {
      id: "layout.alignLeft",
      title: "Align Left",
      icon: "align",
      assetName: "Custom_Left",
      shortcut: "Option+Shift+Cmd+L",
      shortcutLabel: "⌥⇧⌘L",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the left edge of the selection"
    },
    {
      id: "layout.alignCenter",
      title: "Align Center",
      icon: "align",
      assetName: "Custom_Center",
      shortcut: "Option+Shift+Cmd+C",
      shortcutLabel: "⌥⇧⌘C",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the horizontal center of the selection"
    },
    {
      id: "layout.alignRight",
      title: "Align Right",
      icon: "align",
      assetName: "Custom_Right",
      shortcut: "Option+Shift+Cmd+R",
      shortcutLabel: "⌥⇧⌘R",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the right edge of the selection"
    },
    {
      id: "layout.alignTop",
      title: "Align Top",
      icon: "align",
      assetName: "Custom_Top",
      shortcut: "Option+Shift+Cmd+T",
      shortcutLabel: "⌥⇧⌘T",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the top edge of the selection"
    },
    {
      id: "layout.alignMiddle",
      title: "Align Middle",
      icon: "align",
      assetName: "Custom_Middle",
      shortcut: "Option+Shift+Cmd+M",
      shortcutLabel: "⌥⇧⌘M",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the vertical middle of the selection"
    },
    {
      id: "layout.alignBottom",
      title: "Align Bottom",
      icon: "align",
      assetName: "Custom_Bottom",
      shortcut: "Option+Shift+Cmd+B",
      shortcutLabel: "⌥⇧⌘B",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Align selected document objects to the bottom edge of the selection"
    },
    {
      id: "layout.distributeHorizontal",
      title: "Distribute Horizontally",
      icon: "align",
      assetName: "Custom_Horizontal",
      shortcut: "Option+Shift+Cmd+H",
      shortcutLabel: "⌥⇧⌘H",
      source: "core",
      category: "layout",
      enabled: hasDistributableSelection,
      disabledReason: "Select at least three objects",
      description: "Distribute selected document objects evenly from left to right"
    },
    {
      id: "layout.distributeVertical",
      title: "Distribute Vertically",
      icon: "align",
      assetName: "Custom_Vertical",
      shortcut: "Option+Shift+Cmd+V",
      shortcutLabel: "⌥⇧⌘V",
      source: "core",
      category: "layout",
      enabled: hasDistributableSelection,
      disabledReason: "Select at least three objects",
      description: "Distribute selected document objects evenly from top to bottom"
    },
    {
      id: distributeModeCommandIds.centers,
      title: "Distribute by Centers",
      icon: "align",
      source: "core",
      category: "layout",
      description: "Use center-to-center spacing for distribute buttons"
    },
    {
      id: distributeModeCommandIds.spacing,
      title: "Distribute Equal Gaps",
      icon: "align",
      source: "core",
      category: "layout",
      description: "Use equal empty space between object bounds for distribute buttons"
    },
    {
      id: "layout.group",
      title: "Group",
      icon: "group",
      assetName: "Custom_Group",
      shortcut: "Cmd+G",
      shortcutLabel: "⌘G",
      source: "core",
      category: "layout",
      enabled: hasMultiSelection,
      disabledReason: "Select at least two objects",
      description: "Treat selected document objects as one grouped selection"
    },
    {
      id: "layout.ungroup",
      title: "Ungroup",
      icon: "group",
      assetName: "Custom_Ungroup",
      shortcut: "Shift+Cmd+G",
      shortcutLabel: "⇧⌘G",
      source: "core",
      category: "layout",
      enabled: hasSelectedGroup,
      disabledReason: "Select a group",
      description: "Restore a grouped selection to its child objects"
    },
    {
      id: "layout.bringToFront",
      title: "Bring to Front",
      icon: "group",
      assetName: "Custom_Front",
      shortcut: "Shift+Cmd+]",
      shortcutLabel: "⇧⌘]",
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
      shortcut: "Cmd+]",
      shortcutLabel: "⌘]",
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
      shortcut: "Cmd+[",
      shortcutLabel: "⌘[",
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
      shortcut: "Shift+Cmd+[",
      shortcutLabel: "⇧⌘[",
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
      id: "layout.rotate90",
      title: "Rotate 90 Degrees",
      icon: "align",
      assetName: "Custom_Rotation",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Rotate the selected document objects 90 degrees around the selection center"
    },
    {
      id: "layout.duplicate",
      title: "Duplicate",
      icon: "group",
      assetName: "Art_Bring_Forward",
      source: "core",
      category: "layout",
      enabled: hasSelection,
      description: "Duplicate the selected document objects and select the copies"
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
    enabled: true,
    description: "Open the toolbar customization editor"
  },
  {
    id: "view.customizeMainToolbar",
    title: "Customize Main Toolbar",
    icon: "palette",
    source: "core",
    category: "view",
    enabled: true,
    description: "Customize the Main toolbar in place — drag to reorder, add, or remove items"
  }
];

export function allPaletteCommands(
  registry: DesktopToolsetRegistry = desktopToolsetRegistry
): CommandSpec[] {
  return withStandaloneDrawingToolCommands(getToolsetCommandSpecs(registry));
}

export function allShellCommands(
  document: ChemDraftDocument,
  selectedMolecule?: MoleculeObject,
  options: ShellCommandOptions = {}
): CommandSpec[] {
  const registry = options.registry ?? desktopToolsetRegistry;
  return dedupeCommands([
    ...createQuickActions(document, selectedMolecule, options.availability),
    ...createLayerActions(document),
    // Generated launchers must beat a persisted toolbar occurrence under first-wins dedupe. The
    // latter may carry the title from before a user/plugin toolbar was renamed.
    ...getToolsetToggleActions(registry),
    ...allPaletteCommands(registry),
    ...editActions,
    ...atomElementActions,
    ...drawerActions,
    ...viewActions,
    ...pageSizeActions,
    pageCustomSizeAction,
    ...pageOrientationActions,
    ...textToolbarActions,
    ...objectStyleActions,
    ...toolbarCustomizationActions
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
