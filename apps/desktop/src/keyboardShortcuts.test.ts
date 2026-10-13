import { normalizeShortcut, parseShortcutDisplay } from "@chemdraft/shortcut-engine";
import { describe, expect, it } from "vitest";
import { buildAppMenuModel, flattenAppMenuCommands } from "./appMenu";
import { createLayerActions, createQuickActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { withStandaloneDrawingToolCommands } from "./drawingTools";
import { applyKeybindingSchemeToCommands } from "./keybindingScheme";
import {
  createDesktopShortcutRegistry,
  createMainWindowShortcutCommands,
  enableWindowsLastDocumentCloseAction,
  isBrowserReloadChord
} from "./keyboardShortcuts";
import { desktopToolsetRegistry, getToolsetCommandSpecs } from "./toolsets";

describe("document window shortcuts", () => {
  // Every accelerator the menu advertises must reach its command through the document window's own
  // registry. On macOS an unclaimed key still reaches the native menu's accelerator, so a gap here was
  // invisible; WebView2 on Windows never forwards it, so the same gap is a dead shortcut there.
  it.each([
    ["windows", "chemdraft"],
    ["windows", "chemdraw"],
    ["macos", "chemdraft"],
    ["macos", "chemdraw"]
  ] as const)("binds every menu accelerator to its command (%s, %s scheme)", (platform, scheme) => {
    const document = createPhase4Document("Shortcuts");
    const toolCommandSpecs = applyKeybindingSchemeToCommands(
      withStandaloneDrawingToolCommands(getToolsetCommandSpecs(desktopToolsetRegistry)),
      scheme
    );
    const commands = createMainWindowShortcutCommands(
      {
        quickActions: createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
        layerActions: createLayerActions(document),
        toolCommandSpecs
      },
      scheme
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
      keybindingScheme: scheme
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
  it("enables Close Document Tab only on Windows", () => {
    const document = createPhase4Document();
    const actions = createQuickActions(document, undefined, { hasMultipleTabs: false });
    const closeKey = { key: "w", ctrlKey: true };

    const windows = enableWindowsLastDocumentCloseAction(actions, "windows");
    expect(createDesktopShortcutRegistry(windows, "windows").resolve(closeKey)).toBe("document.closeTab");
    expect(windows.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: true });

    const macos = enableWindowsLastDocumentCloseAction(actions, "macos");
    expect(createDesktopShortcutRegistry(macos, "macos").resolve({ key: "w", metaKey: true })).toBeUndefined();
    expect(macos.find((action) => action.id === "document.closeTab")).toMatchObject({ enabled: false });
  });
});
