import { editShortcut, normalizeShortcut, parseShortcutDisplay, resolveHoverKey } from "@chemdraft/shortcut-engine";
import { describe, expect, it } from "vitest";
import { buildAppMenuModel, flattenAppMenuCommands } from "./appMenu";
import { createLayerActions, createQuickActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { capturedShortcut, keyboardShortcutActions, nativeMenuShortcutOverrides } from "./customKeyboardShortcuts";
import { applyKeybindingSchemeToCommands, createHoverShortcutTables } from "./keybindingScheme";
import {
  createDesktopShortcutRegistry,
  createMainWindowShortcutCommands,
  enableLastDocumentCloseAction,
  isBrowserReloadChord
} from "./keyboardShortcuts";
import { desktopToolsetRegistry, getToolsetCommandSpecs } from "./toolsets";

describe("document window shortcuts", () => {
  // Every accelerator the menu advertises must reach its command through the document window's own
  // registry. On macOS an unclaimed key still reaches the native menu's accelerator, so a gap here was
  // invisible; WebView2 on Windows never forwards it, so the same gap is a dead shortcut there.
  it.each(["windows", "macos"] as const)("binds every menu accelerator to its command (%s)", platform => {
    const document = createPhase4Document("Shortcuts");
    const toolCommandSpecs = applyKeybindingSchemeToCommands(
      withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry))
    );
    const commands = createMainWindowShortcutCommands(
      {
        quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
        layerActions: createLayerActions(document),
        toolCommandSpecs
      }
    );
    // Enabled-ness is state, not binding: Group is disabled until two objects are selected, and the
    // question here is whether its chord would reach it at all.
    const registry = createDesktopShortcutRegistry(commands, { platform, includeDisabled: true });
    // Enter commits atom labels and paths, but has no global text-reopening binding.
    // T activates the registered Text tool; existing text is edited by a canvas click.
    expect(registry.resolve({ key: "Enter" })).toBeUndefined();
    const menu = buildAppMenuModel({
      rulersVisible: true,
      crosshairsVisible: true,
      canUndo: true,
      canRedo: true,
      hasSelection: true,
      hasSelectedMolecule: true,
      toolbars: [],
      platform
    });

    const accelerated = flattenAppMenuCommands(menu).filter((item) => item.accelerator);
    expect(accelerated.length).toBeGreaterThan(10);
    const unbound = accelerated.flatMap((item) => {
      const chord = normalizeShortcut({ commandId: item.commandId, keys: parseShortcutDisplay(item.accelerator!) }, platform);
      const resolved = registry.resolve({
        key: chord.key,
        ctrlKey: chord.modifiers.includes("Ctrl"),
        altKey: chord.modifiers.includes("Alt"),
        shiftKey: chord.modifiers.includes("Shift"),
        metaKey: chord.modifiers.includes("Meta")
      });
      return resolved === item.commandId ? [] : [`${item.accelerator} → ${resolved ?? "nothing"} (menu: ${item.commandId})`];
    });
    expect(unbound).toEqual([]);
    expect(registry.resolve({ key: ",", ...(platform === "macos" ? { metaKey: true } : { ctrlKey: true }) }))
      .toBe("view.togglePreferences");
  });
});

describe.each(["windows", "macos"] as const)("the one built-in shortcut set (%s)", platform => {
  // There is one set (keybindingSettings.ts); it must resolve the same way on both platforms.
  const registryFor = () => {
    const document = createPhase4Document("Shortcut set");
    const commands = createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
      layerActions: createLayerActions(document),
      toolCommandSpecs: applyKeybindingSchemeToCommands(
        withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry)))
    }, undefined, platform);
    return createDesktopShortcutRegistry(commands, { platform, includeDisabled: true });
  };
  const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };

  it("binds the set's keys in the document window", () => {
    const registry = registryFor();
    expect(registry.resolve({ key: "x" })).toBe("tool.bond");
    expect(registry.resolve({ key: "X", shiftKey: true })).toBe("tool.chain");
    expect(registry.resolve({ key: " " })).toBe("tool.select");
    expect(registry.resolve({ key: "e" })).toBe("tool.reactionArrow");
    expect(registry.resolve({ key: ";", ...mod })).toBe("view.toggleRulers");
    expect(registry.resolve({ key: "x", altKey: true, ...mod })).toBe("view.toggleCrosshairs");
    expect(registry.resolve({ key: "e", ctrlKey: true, metaKey: platform === "macos" })).toBe("export.open");
    const hover = createHoverShortcutTables();
    expect(hover.atom.get("b")).toBe("atom.setHoveredElement.Br");
    expect(hover.atom.get("B")).toBe("atom.setHoveredElement.B");
    expect(hover.atom.get("2")).toBe("atom.addCarbonylToHoveredAtom");
    expect(hover.bond.get("h")).toBe("bond.setHoveredBondDisplay.hashed");
  });

  it("never binds Ctrl+R or F5, so neither can reload the webview", () => {
    const registry = registryFor();
    for (const chord of [{ key: "r", ...mod }, { key: "R", shiftKey: true, ...mod }, { key: "F5" }, { key: "F5", ctrlKey: true }]) {
      expect(registry.resolve(chord), JSON.stringify(chord)).toBeUndefined();
    }
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, platform)).toBe(platform === "windows");
  });

  it("keeps commands the set leaves without a key assignable in Preferences > Keyboard", () => {
    const registry = registryFor();
    const actions = keyboardShortcutActions(platform);
    for (const id of ["tool.eraser", "tool.lasso", "tool.cyclopentane", "tool.plus", "tool.minus", "layout.bringForward"]) {
      expect(actions.find(action => action.id === id && action.scope === "commands"), id).toMatchObject({ defaults: [] });
    }
    // The old preset's keys for them are not bound.
    expect(registry.resolve({ key: "r" })).toBeUndefined();
    expect(actions.find(action => action.id === "tool.bond")?.defaults).toEqual(["X"]);
  });
});

describe("isBrowserReloadChord", () => {
  it("recognises WebView2's reload accelerators off macOS", () => {
    for (const platform of ["windows", "linux"] as const) {
      expect(isBrowserReloadChord({ key: "F5" }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "F5", ctrlKey: true }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "BrowserRefresh" }, platform)).toBe(true);
      expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, platform)).toBe(true);
      // Ctrl+Shift+R is a hard reload; Shift turns the key upper-case.
      expect(isBrowserReloadChord({ key: "R", ctrlKey: true }, platform)).toBe(true);
    }
  });

  it("leaves ordinary typing and other chords alone", () => {
    expect(isBrowserReloadChord({ key: "r" }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "R" }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "s", ctrlKey: true }, "windows")).toBe(false);
    // AltGr arrives as Ctrl+Alt on Windows; AltGr+R types a character on some layouts.
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true, altKey: true }, "windows")).toBe(false);
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true, metaKey: true }, "windows")).toBe(false);
  });

  it("never fires on macOS, where WKWebView has no reload accelerator", () => {
    expect(isBrowserReloadChord({ key: "F5" }, "macos")).toBe(false);
    expect(isBrowserReloadChord({ key: "r", ctrlKey: true }, "macos")).toBe(false);
  });
});

describe("last document close command", () => {
  it("enables Close Document Tab on Windows and Linux, not on macOS", () => {
    const document = createPhase4Document();
    const actions = createQuickActions(document, undefined, { hasMultipleTabs: false });
    const closeKey = { key: "w", ctrlKey: true };

    for (const platform of ["windows", "linux"] as const) {
      const enabled = enableLastDocumentCloseAction(actions, platform);
      expect(createDesktopShortcutRegistry(enabled, platform).resolve(closeKey)).toBe("document.closeTab");
      expect(enabled.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: true });
    }

    const macos = enableLastDocumentCloseAction(actions, "macos");
    expect(createDesktopShortcutRegistry(macos, "macos").resolve({ key: "w", metaKey: true })).toBeUndefined();
    expect(macos.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: false });
  });
});

describe.each(["windows", "macos"] as const)("custom keyboard shortcuts (%s)", platform => {
  it("applies overrides to the window registry, menus, and hovered targets", () => {
    const actions = keyboardShortcutActions(platform);
    const save = actions.find(action => action.id === "document.save")!;
    const bond = actions.find(action => action.id === "tool.bond")!;
    const bromine = actions.find(action => action.id === "atom.setHoveredElement.Br")!;
    const boron = actions.find(action => action.id === "atom.setHoveredElement.B")!;
    expect(bromine.defaults).toEqual(["b"]);
    expect(boron.defaults).toEqual(["B"]);
    expect(actions.every(action => !action.title.startsWith("atom.") && !action.title.startsWith("bond."))).toBe(true);
    const overrides = { commands: { [save.id]: ["Mod+F9"], [bond.id]: ["F10"] }, atom: { [bromine.id]: ["D"] } };
    const document = createPhase4Document("Custom shortcuts");
    const commands = createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined),
      layerActions: createLayerActions(document),
      toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
    }, overrides, platform);
    const registry = createDesktopShortcutRegistry(commands, { platform, overrides });
    const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    expect(registry.resolve({ key: "F9", ...mod })).toBe(save.id);
    expect(registry.resolve({ key: "s", ...mod })).toBeUndefined();
    expect(registry.resolve({ key: "F10" })).toBe(bond.id);
    expect(registry.resolve({ key: "x" })).not.toBe(bond.id);
    const menu = buildAppMenuModel({
      rulersVisible: true, crosshairsVisible: true, canUndo: true, canRedo: true,
      hasSelection: true, hasSelectedMolecule: true, toolbars: [], platform,
      keybindingOverrides: overrides
    });
    expect(flattenAppMenuCommands(menu).find(item => item.commandId === save.id)).toMatchObject({
      accelerator: "Mod+F9", shortcut: platform === "macos" ? "⌘F9" : "Ctrl+F9"
    });
    expect(nativeMenuShortcutOverrides(overrides, platform)).toEqual({
      [save.id]: platform === "macos" ? "Cmd+f9" : "Ctrl+f9"
    });
    const hover = createHoverShortcutTables(overrides);
    expect(hover.atom.get("D")).toBe(bromine.id);
    expect(hover.atom.get("b")).toBeUndefined();
    expect(hover.atom.get("B")).toBe(boron.id);
    const cleared = editShortcut(actions, overrides, save, { kind: "clear" }, platform);
    expect(cleared.kind === "updated" && nativeMenuShortcutOverrides(cleared.overrides, platform)).toEqual({ [save.id]: null });
  });

  // + and - act on the hovered atom only; the charge tools have no key in the set. Shift on + must not
  // make it a different chord, and giving a charge tool the same key is a conflict Preferences reports.
  it("keeps the hover +/- charge keys hover-only, with the charge tools assignable", () => {
    const actions = keyboardShortcutActions(platform);
    const pairs = [
      { hover: "atom.addPositiveChargeToHoveredAtom", tool: "tool.plus", key: "+" },
      { hover: "atom.addNegativeChargeToHoveredAtom", tool: "tool.minus", key: "-" }
    ];
    const outcome = (id: string, scope: "atom" | "commands", edit: Parameters<typeof editShortcut>[3]) => {
      const action = actions.find(candidate => candidate.id === id && candidate.scope === scope)!;
      const result = editShortcut(actions, {}, action, edit, platform);
      return result.kind === "conflict" ? { kind: result.kind, with: result.actions.map(other => other.id) } : { kind: result.kind };
    };
    for (const { hover, tool, key } of pairs) {
      expect(actions.find(action => action.id === hover)).toMatchObject({ scope: "atom", defaults: [key] });
      expect(actions.find(action => action.id === tool)).toMatchObject({ scope: "commands", defaults: [] });
      expect(outcome(hover, "atom", { kind: "reset" })).toEqual({ kind: "updated" });
      expect(outcome(tool, "commands", { kind: "assign", key })).toEqual({ kind: "conflict", with: [hover] });
    }
    const hover = createHoverShortcutTables();
    expect(hover.atom.get("+")).toBe("atom.addPositiveChargeToHoveredAtom");
    expect(hover.atom.get("-")).toBe("atom.addNegativeChargeToHoveredAtom");
    const document = createPhase4Document("Charge keys");
    const registry = createDesktopShortcutRegistry(createMainWindowShortcutCommands({
      quickActions: createQuickActions(document, undefined),
      layerActions: createLayerActions(document),
      toolCommandSpecs: withStandaloneDrawingToolCommands(getToolsetCommandSpecs())
    }, undefined, platform), { platform });
    // With nothing hovered, +/- pick no tool.
    expect(registry.resolve({ key: "+", code: "Equal", shiftKey: true })).toBeUndefined();
    expect(registry.resolve({ key: "-", code: "Minus" })).toBeUndefined();
    // Shift+= reported as "=" (some macOS input paths) reads as the hover table's literal "+".
    const shiftedEqual = { key: "=", code: "Equal", shiftKey: true };
    expect(resolveHoverKey(shiftedEqual, key => hover.atom.get(key)))
      .toEqual({ key: "+", match: "atom.addPositiveChargeToHoveredAtom" });
    expect(resolveHoverKey({ key: "=", code: "Equal" }, key => hover.atom.get(key)).match).toBeUndefined();
  });

  it("records Shift+= as + for a hover action, however the press reports it", () => {
    const press = (init: { key: string; code: string; shiftKey?: boolean }) =>
      ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;
    expect(capturedShortcut("Shift+=", press({ key: "=", code: "Equal", shiftKey: true }), "atom", platform)).toEqual({ key: "+" });
    expect(capturedShortcut("Shift+=", press({ key: "+", code: "Equal", shiftKey: true }), "atom", platform)).toEqual({ key: "+" });
    expect(capturedShortcut("=", press({ key: "=", code: "Equal" }), "atom", platform)).toEqual({ key: "=" });
  });

  it("includes and clears the Windows redo alternate with its action", () => {
    const redo = keyboardShortcutActions(platform).find(action => action.id === "edit.redo");
    expect(redo?.defaults.includes("Ctrl+Y")).toBe(platform === "windows");
    const overrides = { commands: { "edit.redo": [] } };
    const commands = applyKeybindingSchemeToCommands([
      { id: "edit.redo", title: "Redo", icon: "redo", source: "core", shortcut: "Mod+Shift+Z" }
    ], overrides, platform);
    expect(createDesktopShortcutRegistry(commands, { platform, overrides }).resolve({ key: "y", ctrlKey: true })).toBeUndefined();
  });
});
