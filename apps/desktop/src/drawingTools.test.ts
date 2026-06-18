import { describe, expect, it } from "vitest";
import {
  activateDrawingToolCommand,
  coreDrawingToolDefinitions,
  createActiveToolState,
  getDrawingToolCommandSpecs,
  getDrawingToolDefinition,
  isDrawingToolCommand,
  withStandaloneDrawingToolCommands
} from "./drawingTools";
import { getToolsetCommandSpecs } from "./toolsets";
import type { CommandSpec } from "./commands";

describe("Phase 7 drawing tool activation", () => {
  it("defines command-backed core drawing tool kinds", () => {
    const commandsForKind = (kind: (typeof coreDrawingToolDefinitions)[number]["kind"]) =>
      coreDrawingToolDefinitions.filter((definition) => definition.kind === kind).map((definition) => definition.commandId);

    expect(commandsForKind("selection")).toContain("tool.select");
    expect(commandsForKind("selection")).toContain("tool.art.directEdit");
    expect(commandsForKind("bond")).toContain("tool.bond");
    expect(commandsForKind("atom")).toContain("tool.atom");
    expect(commandsForKind("ring")).toContain("tool.cyclopentane");
    expect(commandsForKind("text")).toContain("tool.text");
    expect(commandsForKind("arrow")).toContain("tool.reactionArrow");
    expect(commandsForKind("art")).toContain("tool.art.circle");
    expect(commandsForKind("art")).toContain("tool.art.arc90Dashed");
  });

  it("starts with the selection tool active", () => {
    expect(createActiveToolState()).toEqual({
      activeCommandId: "tool.select",
      activeKind: "selection",
      lastOutcome: "activated",
      lastCommandId: "tool.select"
    });
  });

  it("activates enabled drawing tools through state transitions", () => {
    const command: CommandSpec = {
      id: "tool.bond",
      title: "Single Bond",
      icon: "bond",
      source: "core",
      category: "structure",
      enabled: true
    };
    const result = activateDrawingToolCommand(createActiveToolState(), command);

    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Single Bond: click canvas or atom");
    expect(result.state).toMatchObject({
      activeCommandId: "tool.bond",
      activeKind: "bond",
      lastOutcome: "activated"
    });
  });

  it("activates the manifest-backed single bond tool", () => {
    const command = getToolsetCommandSpecs().find((candidate) => candidate.id === "tool.bond");
    if (!command) {
      throw new Error("Expected tool.bond to be registered by the toolset manifest.");
    }

    const current = createActiveToolState();
    const result = activateDrawingToolCommand(current, command);

    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Single Bond: click canvas or atom");
    expect(result.state.activeCommandId).toBe("tool.bond");
    expect(result.state.activeKind).toBe("bond");
    expect(command.enabled).toBe(true);
  });

  it("activates the manifest-backed text tool without requiring an editor adapter", () => {
    const command = getToolsetCommandSpecs().find((candidate) => candidate.id === "tool.text");
    if (!command) {
      throw new Error("Expected tool.text to be registered by the toolset manifest.");
    }

    const result = activateDrawingToolCommand(createActiveToolState(), command);

    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Text: click canvas to type");
    expect(result.state.activeCommandId).toBe("tool.text");
    expect(result.state.activeKind).toBe("text");
    expect(command.enabled).toBe(true);
  });

  it("activates manifest-backed art tools without requiring an editor adapter", () => {
    const command = getToolsetCommandSpecs().find((candidate) => candidate.id === "tool.art.circle");
    if (!command) {
      throw new Error("Expected tool.art.circle to be registered by the toolset manifest.");
    }

    const result = activateDrawingToolCommand(createActiveToolState(), command);

    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Circle: click canvas");
    expect(result.state.activeCommandId).toBe("tool.art.circle");
    expect(result.state.activeKind).toBe("art");
    expect(command.enabled).toBe(true);
  });

  it("keeps direct edit registered as a hidden selection-mode command", () => {
    const toolsetCommands = getToolsetCommandSpecs();
    const command = withStandaloneDrawingToolCommands(toolsetCommands).find((candidate) => candidate.id === "tool.art.directEdit");
    if (!command) {
      throw new Error("Expected tool.art.directEdit to remain registered as a standalone drawing command.");
    }

    const result = activateDrawingToolCommand(createActiveToolState("tool.art.circle"), command);

    expect(toolsetCommands.some((candidate) => candidate.id === "tool.art.directEdit")).toBe(false);
    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Direct Edit: adjust art handles");
    expect(result.state.activeCommandId).toBe("tool.art.directEdit");
    expect(result.state.activeKind).toBe("selection");
    expect(command.enabled).toBe(true);
  });

  it("shows brief usage text for one-shot art utilities", () => {
    const command = getToolsetCommandSpecs().find((candidate) => candidate.id === "tool.art.scissors");
    if (!command) {
      throw new Error("Expected tool.art.scissors to be registered by the toolset manifest.");
    }

    const result = activateDrawingToolCommand(createActiveToolState(), command);

    expect(result.outcome).toBe("activated");
    expect(result.status).toBe("Scissors: click path to split");
    expect(result.state.activeCommandId).toBe("tool.art.scissors");
  });

  it("keeps preset art variants registered for compatibility without showing them in the primary art toolbar", () => {
    const toolsetCommands = getToolsetCommandSpecs();
    const withStandalone = withStandaloneDrawingToolCommands(toolsetCommands);

    expect(toolsetCommands.some((command) => command.id === "tool.art.circleGloss")).toBe(false);
    expect(toolsetCommands.some((command) => command.id === "tool.art.rectShadow")).toBe(false);
    expect(withStandalone.find((command) => command.id === "tool.art.circleGloss")).toMatchObject({
      id: "tool.art.circleGloss",
      title: "Gloss Circle",
      enabled: true
    });
  });

  it("keeps unavailable tools from changing the active tool", () => {
    const command = getToolsetCommandSpecs().find((candidate) => candidate.id === "tool.chain");
    if (!command) {
      throw new Error("Expected tool.chain to be registered by the toolset manifest.");
    }

    const current = createActiveToolState();
    const result = activateDrawingToolCommand(current, command);

    expect(result.outcome).toBe("unavailable");
    expect(result.status).toContain("unavailable until an EditorAdapter is connected");
    expect(result.state.activeCommandId).toBe("tool.select");
    expect(result.state.activeKind).toBe("selection");
    expect(result.state.lastCommandId).toBe("tool.chain");
  });

  it("ignores non-toolset plugin commands instead of making them active tools", () => {
    const result = activateDrawingToolCommand(createActiveToolState(), {
      id: "plugin.fixture.toolset.ping",
      title: "Fixture Toolset Command",
      icon: "plugin",
      source: "plugin",
      category: "plugin"
    });

    expect(result.outcome).toBe("ignored");
    expect(result.state.activeCommandId).toBe("tool.select");
    expect(result.status).toBe("Fixture Toolset Command command routed");
  });

  it("adds standalone atom metadata without mutating rendered toolbar manifests", () => {
    const toolsetCommands = getToolsetCommandSpecs();
    const withStandalone = withStandaloneDrawingToolCommands(toolsetCommands);

    expect(toolsetCommands.some((command) => command.id === "tool.atom")).toBe(false);
    expect(withStandalone.find((command) => command.id === "tool.atom")).toMatchObject({
      id: "tool.atom",
      title: "Atom Label Tool",
      enabled: false,
      disabledReason: "unavailable until an EditorAdapter is connected"
    });
  });

  it("collects only drawing tool command specs for activation routing", () => {
    const drawingCommands = getDrawingToolCommandSpecs(getToolsetCommandSpecs());

    expect(drawingCommands.some((command) => command.id === "tool.atom")).toBe(true);
    expect(drawingCommands.some((command) => command.id === "tool.benzene")).toBe(true);
    expect(drawingCommands.some((command) => command.id === "tool.reactionArrow")).toBe(true);
    expect(drawingCommands.some((command) => command.id === "tool.art.directEdit")).toBe(true);
    expect(drawingCommands.some((command) => command.id === "tool.art.rectShadow")).toBe(true);
    expect(drawingCommands.some((command) => command.id === "plugin.fixture.toolset.ping")).toBe(false);
  });

  it("classifies drawing tool commands by command id", () => {
    expect(isDrawingToolCommand("tool.text")).toBe(true);
    expect(isDrawingToolCommand("layout.alignLeft")).toBe(false);
    expect(getDrawingToolDefinition("tool.equilibriumArrow")).toMatchObject({
      kind: "arrow",
      category: "arrows"
    });
    expect(getDrawingToolDefinition("tool.art.lineWavy")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.polyline")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.scissors")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.pen")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.pencil")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.brush")).toMatchObject({
      kind: "art",
      category: "art"
    });
    expect(getDrawingToolDefinition("tool.art.eyedropper")).toMatchObject({
      kind: "art",
      category: "art"
    });
  });
});
