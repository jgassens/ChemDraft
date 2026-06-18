import type { CommandSpec } from "./commands";

export type DrawingToolKind = "selection" | "bond" | "atom" | "ring" | "text" | "arrow" | "charge" | "art";
export type ToolActivationOutcome = "activated" | "unavailable" | "ignored";

export interface DrawingToolDefinition {
  commandId: string;
  title: string;
  kind: DrawingToolKind;
  category: string;
  icon: CommandSpec["icon"];
  defaultShortcut?: string;
  usageHint?: DrawingToolUsageHint;
  disabledReason?: string;
}

export interface DrawingToolUsageHint {
  action: string;
  optionalActions: string;
  endActions: string;
}

export interface ActiveToolState {
  activeCommandId: string;
  activeKind: DrawingToolKind;
  lastOutcome: ToolActivationOutcome;
  lastCommandId: string;
  unavailableReason?: string;
}

export interface ToolActivationResult {
  state: ActiveToolState;
  outcome: ToolActivationOutcome;
  status: string;
}

const EDITOR_ADAPTER_UNAVAILABLE = "unavailable until an EditorAdapter is connected";
const artShapeUsageHint = usageHint("click canvas", "select object to edit", "Esc exits");
const artPathUsageHint = usageHint("click canvas", "drag handles after selecting", "Esc exits");

export const coreDrawingToolDefinitions = [
  {
    commandId: "tool.select",
    title: "Selection Tool",
    kind: "selection",
    category: "selection",
    icon: "select",
    defaultShortcut: "V",
    usageHint: usageHint("click object or canvas", "drag moves or selects", "choose another tool")
  },
  {
    commandId: "tool.lasso",
    title: "Lasso Selection",
    kind: "selection",
    category: "selection",
    icon: "lasso",
    defaultShortcut: "L",
    usageHint: usageHint("drag around objects", "Option subtracts", "Esc exits")
  },
  {
    commandId: "tool.art.directEdit",
    title: "Direct Edit",
    kind: "selection",
    category: "art",
    icon: "select",
    usageHint: usageHint("drag art handles", "double-click object for transform", "Esc exits")
  },
  {
    commandId: "tool.eraser",
    title: "Eraser Tool",
    kind: "selection",
    category: "selection",
    icon: "select",
    usageHint: usageHint("click or drag over objects", "drag marquee deletes touched", "Esc exits")
  },
  {
    commandId: "tool.bond",
    title: "Single Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    defaultShortcut: "M",
    usageHint: usageHint("click canvas or atom", "click atom to extend", "Esc exits")
  },
  {
    commandId: "tool.wedgeBond",
    title: "Solid Wedge Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    usageHint: usageHint("click canvas or atom", "click atom to extend", "Esc exits")
  },
  {
    commandId: "tool.hashedBond",
    title: "Hashed Wedge Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    usageHint: usageHint("click canvas or atom", "click atom to extend", "Esc exits")
  },
  {
    commandId: "tool.dashedBond",
    title: "Dashed Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    usageHint: usageHint("click canvas or atom", "click atom to extend", "Esc exits")
  },
  {
    commandId: "tool.boldBond",
    title: "Bold Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    usageHint: usageHint("click canvas or atom", "click atom to extend", "Esc exits")
  },
  {
    commandId: "tool.chain",
    title: "Chain Tool",
    kind: "bond",
    category: "structure",
    icon: "chain",
    defaultShortcut: "C",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.atom",
    title: "Atom Label Tool",
    kind: "atom",
    category: "structure",
    icon: "atom",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.cyclopentane",
    title: "Cyclopentane Template",
    kind: "ring",
    category: "structure",
    icon: "ring",
    defaultShortcut: "R",
    usageHint: usageHint("click canvas or atom", "click atom to attach", "Esc exits")
  },
  {
    commandId: "tool.cyclohexane",
    title: "Cyclohexane Template",
    kind: "ring",
    category: "structure",
    icon: "ring",
    usageHint: usageHint("click canvas or atom", "click atom to attach", "Esc exits")
  },
  {
    commandId: "tool.benzene",
    title: "Benzene Template",
    kind: "ring",
    category: "structure",
    icon: "ring",
    usageHint: usageHint("click canvas or atom", "click atom to attach", "Esc exits")
  },
  {
    commandId: "tool.chairCyclohexaneA",
    title: "Chair Cyclohexane Template A",
    kind: "ring",
    category: "structure",
    icon: "ring",
    usageHint: usageHint("click canvas or atom", "click atom to attach", "Esc exits")
  },
  {
    commandId: "tool.chairCyclohexaneB",
    title: "Chair Cyclohexane Template B",
    kind: "ring",
    category: "structure",
    icon: "ring",
    usageHint: usageHint("click canvas or atom", "click atom to attach", "Esc exits")
  },
  {
    commandId: "tool.text",
    title: "Text Tool",
    kind: "text",
    category: "annotation",
    icon: "text",
    defaultShortcut: "T",
    usageHint: usageHint("click canvas to type", "edit selected text", "Esc exits")
  },
  {
    commandId: "tool.plus",
    title: "Positive Charge Tool",
    kind: "charge",
    category: "annotation",
    icon: "charge",
    defaultShortcut: "+",
    usageHint: usageHint("click atom or canvas", "hover atom targets charge", "Esc exits")
  },
  {
    commandId: "tool.minus",
    title: "Negative Charge Tool",
    kind: "charge",
    category: "annotation",
    icon: "charge",
    defaultShortcut: "-",
    usageHint: usageHint("click atom or canvas", "hover atom targets charge", "Esc exits")
  },
  {
    commandId: "tool.reactionArrow",
    title: "Reaction Arrow",
    kind: "arrow",
    category: "arrows",
    icon: "export",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.resonanceArrow",
    title: "Resonance Arrow",
    kind: "arrow",
    category: "arrows",
    icon: "export",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.equilibriumArrow",
    title: "Equilibrium Arrow",
    kind: "arrow",
    category: "arrows",
    icon: "export",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.retroArrow",
    title: "Retrosynthesis Arrow",
    kind: "arrow",
    category: "arrows",
    icon: "export",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.mechanismArrow",
    title: "Curved Mechanism Arrow",
    kind: "arrow",
    category: "arrows",
    icon: "mechanism",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  {
    commandId: "tool.arrows",
    title: "Arrow Tool Group",
    kind: "arrow",
    category: "arrows",
    icon: "export",
    disabledReason: EDITOR_ADAPTER_UNAVAILABLE
  },
  ...artDrawingToolDefinitions()
] as const satisfies readonly DrawingToolDefinition[];

const drawingToolDefinitionByCommandId: ReadonlyMap<string, DrawingToolDefinition> = new Map(
  coreDrawingToolDefinitions.map((definition) => [definition.commandId, definition])
);

export function createActiveToolState(initialCommandId = "tool.select"): ActiveToolState {
  const definition = drawingToolDefinitionByCommandId.get(initialCommandId)
    ?? drawingToolDefinitionByCommandId.get("tool.select");

  if (!definition) {
    throw new Error("ChemDraft drawing tools must define tool.select.");
  }

  return {
    activeCommandId: definition.commandId,
    activeKind: definition.kind,
    lastOutcome: "activated",
    lastCommandId: definition.commandId
  };
}

export function isDrawingToolCommand(commandId: string): boolean {
  return drawingToolDefinitionByCommandId.has(commandId);
}

export function getDrawingToolDefinition(commandId: string): DrawingToolDefinition | undefined {
  return drawingToolDefinitionByCommandId.get(commandId);
}

export function drawingToolStatusLabel(commandId: string, title?: string): string {
  const definition = getDrawingToolDefinition(commandId);
  const statusTitle = compactToolStatusTitle(title ?? definition?.title ?? "Tool");
  return definition?.usageHint
    ? `${statusTitle}: ${formatDrawingToolUsageHint(definition.usageHint)}`
    : `${title ?? definition?.title ?? commandId} active`;
}

export function formatDrawingToolUsageHint(hint: DrawingToolUsageHint): string {
  return `${hint.action}; ${hint.optionalActions}; ${hint.endActions}`;
}

export function withStandaloneDrawingToolCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  const knownCommandIds = new Set(commands.map((command) => command.id));
  const standaloneCommands = coreDrawingToolDefinitions
    .filter((definition) => !knownCommandIds.has(definition.commandId))
    .map(drawingToolDefinitionToCommandSpec);

  return dedupeCommandSpecs([...commands, ...standaloneCommands]);
}

export function getDrawingToolCommandSpecs(commands: readonly CommandSpec[]): CommandSpec[] {
  return withStandaloneDrawingToolCommands(commands)
    .filter((command) => isDrawingToolCommand(command.id))
    .map((command) => mergeDrawingToolCommandSpec(command));
}

export function activateDrawingToolCommand(
  currentState: ActiveToolState,
  command: CommandSpec
): ToolActivationResult {
  const definition = getDrawingToolDefinition(command.id);
  if (!definition) {
    return {
      state: {
        ...currentState,
        lastOutcome: "ignored",
        lastCommandId: command.id
      },
      outcome: "ignored",
      status: `${command.title} command routed`
    };
  }

  const normalizedCommand = mergeDrawingToolCommandSpec(command);
  const disabledReason = normalizedCommand.enabled === false
    ? normalizedCommand.disabledReason ?? "Tool unavailable"
    : undefined;
  if (disabledReason) {
    return {
      state: {
        ...currentState,
        lastOutcome: "unavailable",
        lastCommandId: command.id,
        unavailableReason: disabledReason
      },
      outcome: "unavailable",
      status: `${normalizedCommand.title} unavailable: ${disabledReason}`
    };
  }

  return {
    state: {
      activeCommandId: normalizedCommand.id,
      activeKind: definition.kind,
      lastOutcome: "activated",
      lastCommandId: normalizedCommand.id
    },
    outcome: "activated",
    status: drawingToolStatusLabel(normalizedCommand.id, normalizedCommand.title)
  };
}

function drawingToolDefinitionToCommandSpec(definition: DrawingToolDefinition): CommandSpec {
  return {
    id: definition.commandId,
    title: definition.title,
    icon: definition.icon,
    source: "core",
    category: definition.category,
    description: `${definition.title} drawing tool`,
    shortcut: definition.defaultShortcut,
    defaultShortcut: definition.defaultShortcut,
    enabled: definition.disabledReason ? false : true,
    disabledReason: definition.disabledReason
  };
}

function mergeDrawingToolCommandSpec(command: CommandSpec): CommandSpec {
  const definition = getDrawingToolDefinition(command.id);
  if (!definition) {
    return command;
  }

  const disabledReason = command.enabled === true
    ? command.disabledReason
    : command.disabledReason ?? definition.disabledReason;

  return {
    ...command,
    title: command.title || definition.title,
    icon: command.icon ?? definition.icon,
    category: command.category ?? definition.category,
    description: command.description ?? `${definition.title} drawing tool`,
    source: command.source ?? "core",
    defaultShortcut: command.defaultShortcut ?? definition.defaultShortcut,
    shortcut: command.shortcut ?? definition.defaultShortcut,
    enabled: command.enabled ?? (disabledReason ? false : true),
    disabledReason
  };
}

function compactToolStatusTitle(title: string): string {
  return title
    .replace(/ Tool$/, "")
    .replace(/ Selection$/, "")
    .replace(/ Template$/, "");
}

function usageHint(action: string, optionalActions: string, endActions: string): DrawingToolUsageHint {
  return { action, optionalActions, endActions };
}

function dedupeCommandSpecs(commands: readonly CommandSpec[]): CommandSpec[] {
  const byId = new Map<string, CommandSpec>();
  commands.forEach((command) => {
    if (!byId.has(command.id)) {
      byId.set(command.id, command);
    }
  });

  return [...byId.values()];
}

function artDrawingToolDefinitions(): DrawingToolDefinition[] {
  const tools = [
    ["tool.art.circle", "Circle", "bracket", artShapeUsageHint],
    ["tool.art.circleDashed", "Dashed Circle", "bracket", artShapeUsageHint],
    ["tool.art.circleGloss", "Gloss Circle", "style", artShapeUsageHint],
    ["tool.art.circleFilled", "Filled Circle", "style", artShapeUsageHint],
    ["tool.art.circleShadow", "Shadow Circle", "bracket", artShapeUsageHint],
    ["tool.art.ellipse", "Ellipse", "bracket", artShapeUsageHint],
    ["tool.art.ellipseDashed", "Dashed Ellipse", "bracket", artShapeUsageHint],
    ["tool.art.ellipseGloss", "Gloss Ellipse", "style", artShapeUsageHint],
    ["tool.art.ellipseFilled", "Filled Ellipse", "style", artShapeUsageHint],
    ["tool.art.ellipseShadow", "Shadow Ellipse", "bracket", artShapeUsageHint],
    ["tool.art.roundedRect", "Rounded Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.roundedRectDashed", "Dashed Rounded Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.roundedRectGloss", "Gloss Rounded Rectangle", "style", artShapeUsageHint],
    ["tool.art.roundedRectFilled", "Filled Rounded Rectangle", "style", artShapeUsageHint],
    ["tool.art.roundedRectShadow", "Shadow Rounded Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.rect", "Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.rectDashed", "Dashed Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.rectGloss", "Gloss Rectangle", "style", artShapeUsageHint],
    ["tool.art.rectFilled", "Filled Rectangle", "style", artShapeUsageHint],
    ["tool.art.rectShadow", "Shadow Rectangle", "bracket", artShapeUsageHint],
    ["tool.art.line", "Line", "bond", artPathUsageHint],
    ["tool.art.lineDashed", "Dashed Line", "bond", artPathUsageHint],
    ["tool.art.lineWavy", "Wavy Line", "mechanism", artPathUsageHint],
    ["tool.art.lineBold", "Bold Line", "bond", artPathUsageHint],
    ["tool.art.pen", "Pen", "mechanism", usageHint("click points", "drag handles", "Enter ends, Esc cancels")],
    ["tool.art.polyline", "Polyline", "bond", usageHint("click points", "Backspace removes point", "Enter/double-click ends, Esc cancels")],
    ["tool.art.scissors", "Scissors", "select", usageHint("click path to split", "click path for more", "Esc exits")],
    ["tool.art.pencil", "Pencil", "mechanism", usageHint("drag to draw", "keep dragging to continue", "release ends, Esc cancels")],
    ["tool.art.brush", "Brush", "style", usageHint("drag to paint", "keep dragging to continue", "release ends, Esc cancels")],
    ["tool.art.eyedropper", "Eyedropper", "style", usageHint("click source art", "⌥ copies full appearance", "Esc exits")],
    ["tool.art.arrow", "Arrow", "export", artPathUsageHint],
    ["tool.art.arc270", "Three-quarter Arc", "export", artPathUsageHint],
    ["tool.art.arc270Dashed", "Dashed Three-quarter Arc", "export", artPathUsageHint],
    ["tool.art.arc180", "Half Arc", "export", artPathUsageHint],
    ["tool.art.arc180Dashed", "Dashed Half Arc", "export", artPathUsageHint],
    ["tool.art.arc120", "One-third Arc", "export", artPathUsageHint],
    ["tool.art.arc120Dashed", "Dashed One-third Arc", "export", artPathUsageHint],
    ["tool.art.arc90", "Quarter Arc", "export", artPathUsageHint],
    ["tool.art.arc90Dashed", "Dashed Quarter Arc", "export", artPathUsageHint]
  ] as const;

  return tools.map(([commandId, title, icon, usageHint]) => ({
    commandId,
    title,
    kind: "art",
    category: "art",
    icon,
    usageHint
  } satisfies DrawingToolDefinition));
}
