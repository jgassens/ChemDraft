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
  disabledReason?: string;
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

export const coreDrawingToolDefinitions = [
  {
    commandId: "tool.select",
    title: "Selection Tool",
    kind: "selection",
    category: "selection",
    icon: "select",
    defaultShortcut: "V"
  },
  {
    commandId: "tool.lasso",
    title: "Lasso Selection",
    kind: "selection",
    category: "selection",
    icon: "lasso",
    defaultShortcut: "L"
  },
  {
    commandId: "tool.art.directEdit",
    title: "Direct Edit",
    kind: "selection",
    category: "art",
    icon: "select"
  },
  {
    commandId: "tool.eraser",
    title: "Eraser Tool",
    kind: "selection",
    category: "selection",
    icon: "select"
  },
  {
    commandId: "tool.bond",
    title: "Single Bond",
    kind: "bond",
    category: "structure",
    icon: "bond",
    defaultShortcut: "M"
  },
  {
    commandId: "tool.wedgeBond",
    title: "Solid Wedge Bond",
    kind: "bond",
    category: "structure",
    icon: "bond"
  },
  {
    commandId: "tool.hashedBond",
    title: "Hashed Wedge Bond",
    kind: "bond",
    category: "structure",
    icon: "bond"
  },
  {
    commandId: "tool.dashedBond",
    title: "Dashed Bond",
    kind: "bond",
    category: "structure",
    icon: "bond"
  },
  {
    commandId: "tool.boldBond",
    title: "Bold Bond",
    kind: "bond",
    category: "structure",
    icon: "bond"
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
    defaultShortcut: "R"
  },
  {
    commandId: "tool.cyclohexane",
    title: "Cyclohexane Template",
    kind: "ring",
    category: "structure",
    icon: "ring"
  },
  {
    commandId: "tool.benzene",
    title: "Benzene Template",
    kind: "ring",
    category: "structure",
    icon: "ring"
  },
  {
    commandId: "tool.chairCyclohexaneA",
    title: "Chair Cyclohexane Template A",
    kind: "ring",
    category: "structure",
    icon: "ring"
  },
  {
    commandId: "tool.chairCyclohexaneB",
    title: "Chair Cyclohexane Template B",
    kind: "ring",
    category: "structure",
    icon: "ring"
  },
  {
    commandId: "tool.text",
    title: "Text Tool",
    kind: "text",
    category: "annotation",
    icon: "text",
    defaultShortcut: "T"
  },
  {
    commandId: "tool.plus",
    title: "Positive Charge Tool",
    kind: "charge",
    category: "annotation",
    icon: "charge",
    defaultShortcut: "+"
  },
  {
    commandId: "tool.minus",
    title: "Negative Charge Tool",
    kind: "charge",
    category: "annotation",
    icon: "charge",
    defaultShortcut: "-"
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
    status: `${normalizedCommand.title} active`
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
    ["tool.art.circle", "Circle", "bracket"],
    ["tool.art.circleDashed", "Dashed Circle", "bracket"],
    ["tool.art.circleGloss", "Gloss Circle", "style"],
    ["tool.art.circleFilled", "Filled Circle", "style"],
    ["tool.art.circleShadow", "Shadow Circle", "bracket"],
    ["tool.art.ellipse", "Ellipse", "bracket"],
    ["tool.art.ellipseDashed", "Dashed Ellipse", "bracket"],
    ["tool.art.ellipseGloss", "Gloss Ellipse", "style"],
    ["tool.art.ellipseFilled", "Filled Ellipse", "style"],
    ["tool.art.ellipseShadow", "Shadow Ellipse", "bracket"],
    ["tool.art.roundedRect", "Rounded Rectangle", "bracket"],
    ["tool.art.roundedRectDashed", "Dashed Rounded Rectangle", "bracket"],
    ["tool.art.roundedRectGloss", "Gloss Rounded Rectangle", "style"],
    ["tool.art.roundedRectFilled", "Filled Rounded Rectangle", "style"],
    ["tool.art.roundedRectShadow", "Shadow Rounded Rectangle", "bracket"],
    ["tool.art.rect", "Rectangle", "bracket"],
    ["tool.art.rectDashed", "Dashed Rectangle", "bracket"],
    ["tool.art.rectGloss", "Gloss Rectangle", "style"],
    ["tool.art.rectFilled", "Filled Rectangle", "style"],
    ["tool.art.rectShadow", "Shadow Rectangle", "bracket"],
    ["tool.art.line", "Line", "bond"],
    ["tool.art.lineDashed", "Dashed Line", "bond"],
    ["tool.art.lineWavy", "Wavy Line", "mechanism"],
    ["tool.art.lineBold", "Bold Line", "bond"],
    ["tool.art.pen", "Pen", "mechanism"],
    ["tool.art.polyline", "Polyline", "bond"],
    ["tool.art.pencil", "Pencil", "mechanism"],
    ["tool.art.brush", "Brush", "style"],
    ["tool.art.arrow", "Arrow", "export"],
    ["tool.art.arc270", "Three-quarter Arc", "export"],
    ["tool.art.arc270Dashed", "Dashed Three-quarter Arc", "export"],
    ["tool.art.arc180", "Half Arc", "export"],
    ["tool.art.arc180Dashed", "Dashed Half Arc", "export"],
    ["tool.art.arc120", "One-third Arc", "export"],
    ["tool.art.arc120Dashed", "Dashed One-third Arc", "export"],
    ["tool.art.arc90", "Quarter Arc", "export"],
    ["tool.art.arc90Dashed", "Dashed Quarter Arc", "export"]
  ] as const;

  return tools.map(([commandId, title, icon]) => ({
    commandId,
    title,
    kind: "art",
    category: "art",
    icon
  } satisfies DrawingToolDefinition));
}
