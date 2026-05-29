import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import type { IconName } from "./icons";

export interface CommandSpec extends CommandDefinition {
  icon: IconName;
  shortcut?: string;
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

export const paletteGroups: CommandSpec[][] = [
  [
    { id: "tool.select", title: "Select", icon: "select", shortcut: "V", source: "core" },
    { id: "tool.adapterFallback", title: "Insert Adapter Fallback Molecule", icon: "atom", source: "core" },
    { id: "tool.lasso", title: "Lasso", icon: "lasso", shortcut: "L", source: "core", enabled: false }
  ],
  [
    { id: "tool.bond", title: "Bond", icon: "bond", shortcut: "B", source: "core", enabled: false },
    { id: "tool.wedgeBond", title: "Wedge Bond", icon: "bond", source: "core", enabled: false },
    { id: "tool.hashedBond", title: "Hashed Bond", icon: "bond", source: "core", enabled: false },
    { id: "tool.atom", title: "Atom", icon: "atom", shortcut: "A", source: "core", enabled: false },
    { id: "tool.ring", title: "Ring", icon: "ring", shortcut: "R", source: "core", enabled: false },
    { id: "tool.chain", title: "Chain", icon: "chain", shortcut: "C", source: "core", enabled: false }
  ],
  [
    { id: "tool.mechanismArrow", title: "Mechanism Arrow", icon: "mechanism", shortcut: "M", source: "core", enabled: false },
    { id: "tool.reactionArrow", title: "Reaction Arrow", icon: "export", source: "core", enabled: false },
    { id: "tool.charge", title: "Charge", icon: "charge", shortcut: "+", source: "core", enabled: false },
    { id: "tool.text", title: "Text", icon: "text", shortcut: "T", source: "core", enabled: false },
    { id: "tool.bracket", title: "Bracket", icon: "bracket", source: "core", enabled: false }
  ],
  [
    { id: "layout.group", title: "Group", icon: "group", source: "core", enabled: false },
    { id: "layout.align", title: "Align", icon: "align", source: "core", enabled: false },
    { id: "tool.templateGrid", title: "Template Grid", icon: "grid", source: "core", enabled: false },
    { id: "style.applyPreset", title: "Style Preset", icon: "style", source: "core", enabled: false }
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
