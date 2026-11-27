import { describe, expect, it } from "vitest";
import { allShellCommands, createLayerActions, createQuickActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import {
  applyKeybindingSchemeToCommands,
  DEFAULT_COMMAND_SHORTCUT_OVERRIDES,
  createHoverShortcutTables,
  defaultHoverShortcuts
} from "./keybindingScheme";
import { createDesktopShortcutRegistry, createMainWindowShortcutCommands, isBrowserReloadChord } from "./keyboardShortcuts";
import { desktopToolsetRegistry, formatShortcutLabel, getToolsetCommandSpecs } from "./toolsets";

// ChemDraft has one built-in shortcut set. Every test passes the platform in (AGENTS.md §1, §14), so
// both the macOS and the Windows resolution run on any host.
describe.each(["macos", "windows"] as const)("the built-in shortcut set on %s", platform => {
  const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
  const commandsFor = (overrides?: Parameters<typeof createMainWindowShortcutCommands>[1]) => {
    const document = createPhase4Document("Shortcut set");
    return createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
      layerActions: createLayerActions(document),
      toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry))
    }, overrides, platform);
  };
  const registryFor = (overrides?: Parameters<typeof createMainWindowShortcutCommands>[1]) =>
    createDesktopShortcutRegistry(commandsFor(overrides), { platform, includeDisabled: true, overrides });

  it("resolves every command the set changes, with the platform's own labels", () => {
    const commands = applyKeybindingSchemeToCommands(allShellCommands(createPhase4Document()), undefined, platform);
    for (const [id, key] of Object.entries(DEFAULT_COMMAND_SHORTCUT_OVERRIDES)) {
      const command = commands.find(candidate => candidate.id === id);
      if (!command) continue;
      expect(command.shortcut, id).toBe(key ?? "");
      expect(command.defaultShortcut, id).toBe(key ?? "");
      expect(command.shortcutLabel, id).toBe(key ? formatShortcutLabel(key, platform) ?? key : "");
    }
    const rulers = commands.find(command => command.id === "view.toggleRulers")!;
    expect(rulers.shortcutLabel).toBe(platform === "macos" ? "⌘;" : "Ctrl+;");
  });

  it("binds the set's keys in the document window registry", () => {
    const registry = registryFor();
    expect(registry.resolve({ key: " " })).toBe("tool.select");
    expect(registry.resolve({ key: "x" })).toBe("tool.bond");
    expect(registry.resolve({ key: "X", shiftKey: true })).toBe("tool.chain");
    expect(registry.resolve({ key: "j" })).toBe("tool.benzene");
    expect(registry.resolve({ key: "e" })).toBe("tool.reactionArrow");
    expect(registry.resolve({ key: ";", ...mod })).toBe("view.toggleRulers");
    expect(registry.resolve({ key: "x", altKey: true, ...mod })).toBe("view.toggleCrosshairs");
    expect(registry.resolve({ key: "[", ...mod })).toBe("layout.bringToFront");
    expect(registry.resolve({ key: "]", ...mod })).toBe("layout.sendToBack");
    expect(registry.resolve({ key: "s", ...mod })).toBe("document.save");
    expect(registry.resolve({ key: "z", ...mod })).toBe("edit.undo");
  });

  it("leaves eraser, lasso, cyclopentane and the charge tools without a default key", () => {
    const commands = commandsFor();
    for (const id of ["tool.eraser", "tool.lasso", "tool.cyclopentane", "tool.plus", "tool.minus"]) {
      const command = commands.find(candidate => candidate.id === id);
      // Present (menus, toolbar and Customize still reach it), just unbound.
      expect(command, id).toBeDefined();
      expect(command!.shortcut, id).toBe("");
    }
    const registry = registryFor();
    // The retired preset's keys for them do nothing on their own.
    expect(registry.resolve({ key: "r" })).toBeUndefined();
    expect(registry.resolve({ key: "l" })).toBeUndefined();
  });

  it("never binds F5 or Ctrl/Cmd+R, so neither can reload the webview", () => {
    const registry = registryFor();
    for (const chord of [{ key: "F5" }, { key: "F5", ctrlKey: true }, { key: "r", ...mod }, { key: "R", shiftKey: true, ...mod }, { key: "r", ctrlKey: true }]) {
      expect(registry.resolve(chord), JSON.stringify(chord)).toBeUndefined();
    }
    // Off macOS the reload guard cancels them before the webview sees them.
    expect(isBrowserReloadChord({ key: "F5" }, platform)).toBe(platform !== "macos");
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, platform)).toBe(platform !== "macos");
  });

  it("lets the user's own keys override the set, and clear a key", () => {
    const overrides = { commands: { "tool.eraser": ["F6"], "tool.bond": [], "view.toggleRulers": ["Mod+F7"] } };
    const registry = registryFor(overrides);
    expect(registry.resolve({ key: "F6" })).toBe("tool.eraser");
    expect(registry.resolve({ key: "x" })).toBeUndefined();
    expect(registry.resolve({ key: "F7", ...mod })).toBe("view.toggleRulers");
    expect(registry.resolve({ key: ";", ...mod })).toBeUndefined();
  });

  it("resolves the set's hover keys, case-sensitively", () => {
    const atom = defaultHoverShortcuts("atom");
    const bond = defaultHoverShortcuts("bond");
    expect(atom.b).toBe("atom.setHoveredElement.Br");
    expect(atom.B).toBe("atom.setHoveredElement.B");
    expect(atom.l).toBe("atom.setHoveredElement.Cl");
    expect(atom.C).toBe("atom.setHoveredElement.Cl");
    expect(atom["2"]).toBe("atom.addCarbonylToHoveredAtom");
    expect(atom.e).toBe("atom.setHoveredLabel.Et");
    // The retired preset's k carbonyl key and uppercase element keys are not part of the set.
    expect(atom.k).toBeUndefined();
    expect(atom.K).toBeUndefined();
    expect(bond.h).toBe("bond.setHoveredBondDisplay.hashed");
    expect(bond.b).toBe("bond.setHoveredBondDisplay.bold");
    const tables = createHoverShortcutTables({ atom: { "atom.setHoveredElement.Br": ["D"] } });
    expect(tables.atom.get("D")).toBe("atom.setHoveredElement.Br");
    expect(tables.atom.get("b")).toBeUndefined();
    expect(createHoverShortcutTables().atom.get("b")).toBe("atom.setHoveredElement.Br");
  });
});
