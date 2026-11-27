// @vitest-environment jsdom
// One built-in shortcut set: the tour's shortcuts step and Preferences > Keyboard offer no preset to
// choose, even for an install that still stores the retired one, and every window resolves the one
// set's keys. The tour runs in its own native dialog window, so this drives the real chain: TourForm
// in DialogWindow → DialogCoordinator → useGuidedTour, beside every window's useShortcutPreference.
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { MemoryStorage } from "../testSupport/memoryStorage";
import type { DialogMessage } from "../dialogs/dialogProtocol";
import type { KeybindingSettings } from "../keybindingSettings";

const host = vi.hoisted(() => ({
  native: {} as Record<string, unknown>,
  desktop: true,
  invoke: vi.fn(),
  listeners: new Set<(settings: KeybindingSettings) => void>(),
  toDialog: undefined as ((message: DialogMessage) => void) | undefined,
  toOwner: undefined as ((message: DialogMessage) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: host.invoke }));
vi.mock("../dialogs/dialogContentFit", () => ({
  measureDialogContentWhenFontsReady: async () => undefined, observeDialogContent: () => () => {}
}));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(),
  isDesktopRuntime: () => host.desktop,
  // Tauri's emit reaches every window, the sender included.
  listenForKeybindingSettings: async (handler: (settings: KeybindingSettings) => void) => {
    host.listeners.add(handler);
    return () => { host.listeners.delete(handler); };
  },
  broadcastKeybindingSettings: async (settings: KeybindingSettings) => {
    host.listeners.forEach(listener => listener(JSON.parse(JSON.stringify(settings)) as KeybindingSettings));
  }
}));
// The dialog window's side of the native host: messages hop through a macrotask, as over IPC.
vi.mock("../dialogs/dialogTransport", () => ({
  subscribeDialogHost: async (_hostId: string, receive: (message: DialogMessage) => void) => {
    host.toDialog = receive;
    return () => {};
  },
  sendDialogMessage: async (_hostId: string, message: DialogMessage) => { setTimeout(() => host.toOwner!(message), 0); }
}));

import { DialogWindow } from "../dialogs/DialogWindow";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { PreferencesWindow } from "../PreferencesWindow";
import { useShortcutPreference } from "../useShortcutPreference";
import { KEYBINDING_STORAGE_KEY, loadKeybindingSettings, saveKeybindingSettings } from "../keybindingSettings";
import { createHoverShortcutTables } from "../keybindingScheme";
import { buildAppMenuModel, flattenAppMenuCommands } from "../appMenu";
import { createMainWindowShortcutCommands } from "../keyboardShortcuts";
import { createQuickActions } from "../commands";
import { formatShortcutLabel, getToolsetCommandSpecs } from "../toolsets";
import { useGuidedTour } from "./useGuidedTour";
import type { TourAction } from "./tourCommands";

const DIALOG_LABEL = "dialog-main-guidedTour-1";
let mainSettings: KeybindingSettings | undefined;

/** The document window's part of the tour, wired as MainWindow wires it. */
function DocumentWindow() {
  const settings = useShortcutPreference();
  mainSettings = settings;
  const coordinator = useRef<DialogCoordinator>(undefined);
  const action = useRef<(action: TourAction) => Promise<void>>(async () => {});
  const tour = useGuidedTour({
    coordinator: () => coordinator.current, readyAndIdle: () => true,
    shortcutOverrides: settings.overrides, mode: "suppress", setStatus: () => {}
  });
  action.current = next => tour.completeOrRun(next, { invoke: async () => {}, has: () => true });
  useEffect(() => {
    coordinator.current = new DialogCoordinator({
      subscribe: async handler => {
        host.toOwner = message => handler({ message, senderWindowId: DIALOG_LABEL, windowLabel: DIALOG_LABEL });
        return () => {};
      },
      open: async snapshot => {
        setTimeout(() => host.toDialog!(snapshot), 0);
        return { hostId: "tour", windowLabel: DIALOG_LABEL };
      },
      publish: async (_hostId, message) => { setTimeout(() => host.toDialog!(message), 0); },
      close: async () => {}
    }, { guidedTourAction: next => action.current(next), applyPageSize: () => {}, onError: () => {} });
    void tour.open();
  }, []);
  return null;
}

/** Resolve a command's shortcut label the way the document window does. */
function shortcutFor(commandId: string, settings: KeybindingSettings, platform: ShortcutPlatform) {
  const commands = createMainWindowShortcutCommands({
    quickActions: createQuickActions(createEmptyDocument(), undefined), layerActions: [], toolCommandSpecs: getToolsetCommandSpecs()
  }, settings.overrides?.chemdraw, platform);
  const spec = commands.find(command => command.id === commandId);
  return formatShortcutLabel(spec?.shortcut || spec?.defaultShortcut, platform);
}
function menuShortcut(commandId: string, settings: KeybindingSettings, platform: ShortcutPlatform) {
  return flattenAppMenuCommands(buildAppMenuModel({
    platform, keybindingOverrides: settings.overrides?.chemdraw,
    rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false,
    hasSelection: false, hasSelectedMolecule: false, toolbars: []
  })).find(item => item.commandId === commandId)?.shortcut;
}

const roots: Root[] = [];
const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 10)); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  host.native = {};
  host.desktop = true;
  host.listeners.clear();
  // The native preferences file: a patch updates only the fields it names (lib.rs apply_patch).
  host.invoke.mockReset().mockImplementation(async (command: string, args?: { patch?: Record<string, unknown> }) => {
    if (command === "desktop_preferences") {
      if (args?.patch) host.native = { ...host.native, ...args.patch };
      return { ...host.native };
    }
    return undefined;
  });
  mainSettings = undefined;
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["macos", "windows"] as const)("shows one shortcut set in the tour and Preferences, even with the retired preset stored, on %s", async platform => {
  // An install that has not moved yet: both stores still name the retired preset.
  host.native = { shortcutScheme: "chemdraft" };
  localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraft" }));
  const preferences = await mount(createElement(PreferencesWindow));
  const tour = await mount(createElement(DialogWindow, { hostId: "tour" }));
  await mount(createElement(DocumentWindow));
  await act(async () => { await import("./TourForm"); });
  await settle();

  // Every window resolves the one set.
  const settings = loadKeybindingSettings();
  expect(settings.scheme).toBe("chemdraw");
  expect(mainSettings?.scheme).toBe("chemdraw");
  const rulers = platform === "macos" ? "⌘;" : "Ctrl+;";
  expect(shortcutFor("view.toggleRulers", settings, platform)).toBe(rulers);
  expect(menuShortcut("view.toggleRulers", settings, platform)).toBe(rulers);

  // No preset chooser anywhere.
  expect(preferences.querySelectorAll("input[type=radio][name=keybinding-scheme]")).toHaveLength(0);
  const button = (text: string) => [...tour.querySelectorAll("button")].find(item => item.textContent === text)!;
  await act(async () => button("Next").click());
  expect(tour.querySelector("h1")?.textContent).toBe("Keyboard shortcuts");
  expect(tour.querySelectorAll("input[type=radio], fieldset")).toHaveLength(0);
  // The tour window formats keys for the platform it runs on; the Rulers example is the set's semicolon chord.
  expect([...tour.querySelectorAll(".guided-tour-shortcuts > span")].find(item => item.textContent?.startsWith("Rulers"))
    ?.querySelector("kbd")?.textContent).toMatch(/;$/);
  expect(tour.textContent).toContain("Preferences > Keyboard");
  // Opening and stepping through the tour changes no shortcut setting.
  await act(async () => button("Next").click());
  await settle();
  expect(host.invoke).not.toHaveBeenCalledWith("desktop_preferences", { patch: expect.objectContaining({ shortcutScheme: expect.anything() }) });
  expect(tour.querySelector("[role=alert]")).toBeNull();
});

/** The browser build draws the tour inside the document window, wired as MainWindow wires it. */
function BrowserDocumentWindow() {
  const settings = useShortcutPreference();
  const tour = useGuidedTour({
    coordinator: () => undefined, readyAndIdle: () => true,
    shortcutOverrides: settings.overrides, mode: "suppress", setStatus: () => {}
  });
  useEffect(() => { void tour.open(); }, []);
  return tour.renderBrowser(async next => tour.completeOrRun(next, { invoke: async () => {}, has: () => true }));
}

const SINGLE_BOND = "atom.addSingleBondToHoveredAtom";

describe.each(["native window", "browser"] as const)("tour drawing lesson on the %s surface", surface => {
  it.each([
    // The retired preset's custom keys are never applied: the set's own key is named.
    ["the built-in key", { chemdraft: { atom: { [SINGLE_BOND]: ["k"] } } }, "press 1 to add a single bond"],
    ["a custom key", { chemdraw: { atom: { [SINGLE_BOND]: ["j"] } } }, "press j to add a single bond"],
    ["no key when it is cleared", { chemdraw: { atom: { [SINGLE_BOND]: [] } } }, undefined]
  ] as const)("names %s for Add Single Bond to Hovered Atom", async (_label, overrides, expected) => {
    saveKeybindingSettings({ scheme: "chemdraw", overrides });
    // The canvas reads the same table.
    const custom = "chemdraw" in overrides ? overrides.chemdraw : undefined;
    expect(createHoverShortcutTables(custom).atom.get("1")).toBe(custom ? undefined : SINGLE_BOND);
    host.desktop = surface === "native window";
    const tour = surface === "native window" ? await mount(createElement(DialogWindow, { hostId: "tour" })) : undefined;
    const main = await mount(createElement(surface === "native window" ? DocumentWindow : BrowserDocumentWindow));
    const root = tour ?? main;
    await act(async () => { await import("./TourForm"); });
    await settle();
    const button = (text: string) => [...root.querySelectorAll("button")].find(item => item.textContent === text)!;
    const drawingText = () => [...root.querySelectorAll("h1")].find(h => h.textContent === "Draw a structure")!.nextElementSibling!.textContent!;
    await act(async () => button("Next").click());
    await act(async () => button("Next").click());
    expect(drawingText()).toContain("Click and drag with the bond tool");
    if (expected) expect(drawingText()).toContain(expected);
    else expect(drawingText(), "a cleared binding names no key").not.toMatch(/press \S+ to add a single bond/);
  });
});
