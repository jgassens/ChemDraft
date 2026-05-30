import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import type { IconName } from "./icons";
import type { ToolbarAssetName } from "./toolbarAssets";

export interface CommandSpec extends CommandDefinition {
  icon: IconName;
  assetName?: ToolbarAssetName;
  shortcut?: string;
  disabledReason?: string;
}

export const menuItems = ["File", "Edit", "Structure", "Object", "View", "Tools", "Analyze", "Window", "Help"];

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

const editorDisabledReason = "unavailable until an EditorAdapter is connected";
const selectionDisabledReason = "unavailable until selectable document objects exist";
const styleDisabledReason = "unavailable until style presets are connected";

type PaletteCommandInput = Omit<CommandSpec, "source" | "enabled" | "category" | "description"> & {
  category?: string;
  description?: string;
  enabled?: boolean;
};

function paletteCommand(command: PaletteCommandInput): CommandSpec {
  const category = command.category ?? inferPaletteCategory(command.id);
  const description = command.description ?? `${command.title} palette action`;

  return {
    source: "core",
    category,
    description,
    ...command
  };
}

function disabledPaletteCommand(
  command: Omit<PaletteCommandInput, "enabled" | "disabledReason"> & { disabledReason?: string }
): CommandSpec {
  return paletteCommand({
    enabled: false,
    disabledReason: command.disabledReason ?? editorDisabledReason,
    ...command
  });
}

function inferPaletteCategory(commandId: string): string {
  const normalizedCommandId = commandId.toLowerCase();

  if (commandId.startsWith("layout.")) {
    return "layout";
  }

  if (commandId.startsWith("style.")) {
    return "style";
  }

  if (normalizedCommandId.includes("arrow")) {
    return "arrows";
  }

  if (
    normalizedCommandId.includes("bond") ||
    normalizedCommandId.includes("cyclo") ||
    normalizedCommandId.includes("benzene") ||
    normalizedCommandId.includes("chair")
  ) {
    return "structure";
  }

  if (normalizedCommandId.includes("bracket") || normalizedCommandId.includes("symbol") || normalizedCommandId.includes("shape")) {
    return "annotation";
  }

  if (normalizedCommandId.includes("orbital") || normalizedCommandId.includes("lobe")) {
    return "orbitals";
  }

  return "selection";
}

export const paletteGroups: CommandSpec[][] = [
  [
    paletteCommand({ id: "tool.select", title: "Selection Tool", icon: "select", assetName: "Custom_Select", shortcut: "V" }),
    disabledPaletteCommand({ id: "tool.lasso", title: "Lasso Selection", icon: "lasso", assetName: "Custom_Lasso", shortcut: "L" }),
    disabledPaletteCommand({ id: "tool.eraser", title: "Eraser Tool", icon: "select", assetName: "Custom_Eraser" }),
    disabledPaletteCommand({ id: "tool.text", title: "Text Tool", icon: "text", assetName: "Custom_Text", shortcut: "T" })
  ],
  [
    disabledPaletteCommand({ id: "tool.bond", title: "Single Bond", icon: "bond", assetName: "Custom_Bond", shortcut: "B" }),
    disabledPaletteCommand({ id: "tool.wedgeBond", title: "Solid Wedge Bond", icon: "bond", assetName: "Custom_Bond_Wedge" }),
    disabledPaletteCommand({ id: "tool.hashedBond", title: "Hashed Wedge Bond", icon: "bond", assetName: "Custom_Bond_Hashed" }),
    disabledPaletteCommand({ id: "tool.dashedBond", title: "Dashed Bond", icon: "bond", assetName: "Custom_Bond_Dashed" }),
    disabledPaletteCommand({ id: "tool.boldBond", title: "Bold Bond", icon: "bond", assetName: "Custom_Bond_Bold" }),
    disabledPaletteCommand({ id: "tool.chain", title: "Chain Tool", icon: "chain", assetName: "Custom_Draw_Line", shortcut: "C" }),
    disabledPaletteCommand({ id: "tool.cyclopentane", title: "Cyclopentane Template", icon: "ring", assetName: "Custom_Cyclopentane", shortcut: "R" }),
    disabledPaletteCommand({ id: "tool.cyclohexane", title: "Cyclohexane Template", icon: "ring", assetName: "Custom_Cyclohexane" }),
    disabledPaletteCommand({ id: "tool.benzene", title: "Benzene Template", icon: "ring", assetName: "Custom_Benzene" }),
    disabledPaletteCommand({ id: "tool.chairCyclohexaneA", title: "Chair Cyclohexane Template A", icon: "ring", assetName: "Custom_Chair1" }),
    disabledPaletteCommand({ id: "tool.chairCyclohexaneB", title: "Chair Cyclohexane Template B", icon: "ring", assetName: "Custom_Chair2" })
  ],
  [
    disabledPaletteCommand({ id: "tool.reactionArrow", title: "Reaction Arrow", icon: "export", assetName: "Custom_Arrow" }),
    disabledPaletteCommand({ id: "tool.resonanceArrow", title: "Resonance Arrow", icon: "export", assetName: "Custom_Arrow_Resonance" }),
    disabledPaletteCommand({ id: "tool.equilibriumArrow", title: "Equilibrium Arrow", icon: "export", assetName: "Custom_Arrow_Equilibrium" }),
    disabledPaletteCommand({ id: "tool.retroArrow", title: "Retrosynthesis Arrow", icon: "export", assetName: "Custom_Arrow_Retro" }),
    disabledPaletteCommand({ id: "tool.mechanismArrow", title: "Curved Mechanism Arrow", icon: "mechanism", assetName: "Custom_Curved_Arrow", shortcut: "M" }),
    disabledPaletteCommand({ id: "tool.arrows", title: "Arrow Tool Group", icon: "export", assetName: "Custom_Arrows" })
  ],
  [
    disabledPaletteCommand({ id: "tool.bracket", title: "Curly Bracket Tool", icon: "bracket", assetName: "Custom_Bracket" }),
    disabledPaletteCommand({ id: "tool.squareBracket", title: "Square Bracket Tool", icon: "bracket", assetName: "Custom_Square_Bracket" }),
    disabledPaletteCommand({ id: "tool.dagger", title: "Dagger Symbol Tool", icon: "charge", assetName: "Custom_Dagger" }),
    disabledPaletteCommand({ id: "tool.plus", title: "Plus Symbol Tool", icon: "charge", assetName: "Custom_Plus", shortcut: "+" }),
    disabledPaletteCommand({ id: "tool.minus", title: "Minus Symbol Tool", icon: "charge", assetName: "Custom_Minus", shortcut: "-" }),
    disabledPaletteCommand({ id: "tool.symbol", title: "Symbol Tool Group", icon: "charge", assetName: "Custom_Symbol" }),
    disabledPaletteCommand({ id: "tool.shape", title: "Shape Tool", icon: "bracket", assetName: "Custom_Shape" }),
    disabledPaletteCommand({ id: "tool.shapeShadow", title: "Shadow Shape Tool", icon: "bracket", assetName: "Custom_Shape2" })
  ],
  [
    disabledPaletteCommand({ id: "tool.lobe", title: "Orbital Lobe Tool", icon: "atom", assetName: "Custom_Lobe" }),
    disabledPaletteCommand({ id: "tool.shadedLobe", title: "Shaded Orbital Lobe Tool", icon: "atom", assetName: "Custom_Lobe_Shaded" }),
    disabledPaletteCommand({ id: "tool.pOrbital", title: "p Orbital Tool", icon: "atom", assetName: "Custom_p_Orbital" }),
    disabledPaletteCommand({ id: "tool.sOrbital", title: "s Orbital Tool", icon: "atom", assetName: "Custom_s_Orbital" }),
    disabledPaletteCommand({ id: "layout.rotate", title: "Rotate Objects", icon: "align", assetName: "Custom_Rotation", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "style.formulaText", title: "Formula Text Style", icon: "style", assetName: "Custom_FormulaStyle", disabledReason: styleDisabledReason })
  ],
  [
    disabledPaletteCommand({ id: "layout.alignLeft", title: "Align Left", icon: "align", assetName: "Custom_Left", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.alignCenter", title: "Align Center", icon: "align", assetName: "Custom_Center", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.alignRight", title: "Align Right", icon: "align", assetName: "Custom_Right", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.alignTop", title: "Align Top", icon: "align", assetName: "Custom_Top", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.alignMiddle", title: "Align Middle", icon: "align", assetName: "Custom_Middle", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.alignBottom", title: "Align Bottom", icon: "align", assetName: "Custom_Bottom", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.distributeHorizontal", title: "Distribute Horizontally", icon: "align", assetName: "Custom_Horizontal", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.distributeVertical", title: "Distribute Vertically", icon: "align", assetName: "Custom_Vertical", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.flipHorizontal", title: "Flip Horizontally", icon: "align", assetName: "Custom_Flip_Horizontal", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.flipVertical", title: "Flip Vertically", icon: "align", assetName: "Custom_Flip_Vertical", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.bringForward", title: "Bring Forward", icon: "group", assetName: "Custom_Front", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "layout.sendBackward", title: "Send Backward", icon: "group", assetName: "Custom_Back", disabledReason: selectionDisabledReason })
  ],
  [
    disabledPaletteCommand({ id: "style.color", title: "Color Controls", icon: "style", assetName: "Custom_Colors", disabledReason: styleDisabledReason }),
    disabledPaletteCommand({ id: "tool.settings", title: "Object Settings", icon: "inspector", assetName: "Custom_Settings", disabledReason: selectionDisabledReason }),
    disabledPaletteCommand({ id: "tool.toolOptions", title: "Tool Options", icon: "palette", assetName: "Custom_Tools" }),
    disabledPaletteCommand({ id: "tool.templateGrid", title: "Template Grid", icon: "grid", assetName: "Custom_Tools", disabledReason: editorDisabledReason })
  ]
];

export const drawerActions: CommandSpec[] = [
  { id: "view.toggleInspector", title: "Toggle Inspector", icon: "inspector", source: "core" },
  { id: "view.togglePlugins", title: "Toggle Plugins", icon: "plugin", source: "core" }
];

export const styleActions: CommandSpec[] = [
  { id: "style.bondStroke", title: "Bond Stroke 1.2 px", icon: "style", source: "core", enabled: false },
  { id: "style.textSize", title: "Text Size 10 pt", icon: "text", source: "core", enabled: false },
  { id: "style.preset.acs", title: "ACS Style Preset", icon: "style", source: "core", enabled: false }
];

export function allPaletteCommands(): CommandSpec[] {
  return paletteGroups.flat();
}

export function allShellCommands(document: ChemDraftDocument, selectedMolecule?: MoleculeObject): CommandSpec[] {
  return [
    ...createQuickActions(document, selectedMolecule),
    ...allPaletteCommands(),
    ...drawerActions,
    ...styleActions
  ];
}
