// @vitest-environment jsdom
// The tour shows a plugin's step only when the menus show that plugin, and always explains plugins
// on a card of their own before any step shows one. Every case runs on macOS and on Windows from one host (AGENTS.md section 1).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { buildAppMenuModel, flattenAppMenuCommands, type PluginAppMenuItem } from "../appMenu";
import { buildOfficialPluginMenuItems, NAME_TO_STRUCTURE_COMMAND_ID } from "../plugins/officialPluginMenus";
import { buildPluginMenuItems } from "../plugins/pluginMenuModel";
import { OFFICIAL_PLUGIN_CATALOG } from "../plugins/pluginUpdates";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { TourForm } from "./TourForm";
import { availableTourPluginCommands, TOUR_NAME_COMMAND, TOUR_PLUGIN_COMMANDS, type TourPluginCommand, type TourTryCommand } from "./tourCommands";
import { PLUGIN_AUTHORING_GUIDE_URL, tourSteps } from "./tourSteps";
import { useGuidedTour } from "./useGuidedTour";

const platforms = ["macos", "windows"] as const;
const schemes = ["chemdraft", "chemdraw"] as const;

/** One registered command per official plugin, keyed by the plugin id that owns it. */
const OFFICIAL_COMMANDS: Record<string, string> = {
  "org.chemdraft.naming.orthonym": "plugin.orthonymNaming.insertName",
  "org.chemdraft.nmr.predictor": "plugin.nmrPredictor.predict",
  "org.chemdraft.opsin.nameToStructure": NAME_TO_STRUCTURE_COMMAND_ID,
  "org.chemdraft.ocsr.molscribe": "plugin.molscribe.recognize"
};

/** The menu items MainWindow gets from usePluginRuntime, for a set of installed plugins. */
function menuItemsFor(installed: readonly string[], disabled: readonly string[] = []): PluginAppMenuItem[] {
  const commands = new Map<string, CommandDefinition>(installed.map(pluginId => {
    const id = OFFICIAL_COMMANDS[pluginId]!;
    return [id, { id, title: id, pluginId, enabled: !disabled.includes(pluginId) } as unknown as CommandDefinition];
  }));
  return [...buildPluginMenuItems([]), ...buildOfficialPluginMenuItems(id => commands.get(id))];
}

const allPluginIds = OFFICIAL_PLUGIN_CATALOG.map(entry => entry.pluginId);
const PLUGINS_TITLE = "Add features with plugins";
const STATUS_BAR_TITLE = "Keep an eye on the status bar";
const STATUS_BAR_TEXT = "The status bar in the lower-left corner of the drawing window keeps you posted as you work. It shows tips for " +
  "the tool you’re using and for keys that change what a drag does, and it tells you what you’ve selected.";
const PLUGINS_TEXT = "ChemDraft does more through plugins. Official plugins add NMR prediction, structure recognition from images, " +
  "and chemical naming. To get them, choose Plugins > Add or Remove Plugins… and install one from the catalog of official plugins. " +
  "Beyond the official ones, you can vibe code your own: choose Plugins > Vibe Code Your Own Plugin… for step-by-step help. " +
  "The plugin authoring guide is at:";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text);
const click = (text: string) => act(() => button(text)!.click());

/** Walk the whole tour with Next, recording each step and every Try it offered, then press Finish. */
function walk(onAction: ReturnType<typeof vi.fn>) {
  const seen: { counter: string; title: string; text: string; tried?: unknown }[] = [];
  for (;;) {
    const entry = {
      counter: container.querySelector(".guided-tour-counter")!.textContent!,
      title: container.querySelector("h1")!.textContent!,
      text: [...container.querySelectorAll(".guided-tour-content > p:not(.guided-tour-counter)")].map(p => p.textContent).join("\n"),
      tried: undefined as unknown
    };
    if (button("Try it")) {
      click("Try it");
      entry.tried = onAction.mock.lastCall![0];
    }
    seen.push(entry);
    if (!button("Next")) break;
    click("Next");
  }
  click("Finish");
  expect(onAction).toHaveBeenLastCalledWith({ action: "finish" });
  return seen;
}

describe.each(platforms)("tour plugin steps on %s", platform => {
  it("reads plugin availability off the menu items: one plugin adds only its own step", () => {
    expect(availableTourPluginCommands(menuItemsFor([]))).toEqual([]);
    expect(availableTourPluginCommands(menuItemsFor(allPluginIds))).toEqual([...TOUR_PLUGIN_COMMANDS]);
    for (const pluginId of allPluginIds) {
      const expected = pluginId === "org.chemdraft.opsin.nameToStructure" ? [TOUR_NAME_COMMAND] : [];
      expect(availableTourPluginCommands(menuItemsFor([pluginId]))).toEqual(expected);
      // Disabled in the plugin manager: the menus drop the item, so the tour does too.
      expect(availableTourPluginCommands(menuItemsFor([pluginId], [pluginId]))).toEqual([]);
    }
    // A contributed item the menus show greyed out does not count either.
    const greyed: PluginAppMenuItem = { location: "structure", command: {
      kind: "command", id: "x", commandId: TOUR_NAME_COMMAND, label: "Convert", enabled: false, pluginContributed: true } };
    expect(availableTourPluginCommands([greyed])).toEqual([]);
  });

  it("with no plugins installed, shows no plugin step or Try it, counts 9 steps, and finishes", () => {
    for (const plugins of [undefined, availableTourPluginCommands(menuItemsFor([]))]) {
      act(() => root.unmount());
      root = createRoot(container);
      const onAction = vi.fn();
      act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={plugins} onAction={onAction} />));
      const seen = walk(onAction);
      expect(seen.map(step => step.counter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `Step ${n} of 9`));
      expect(seen.map(step => step.tried)).toEqual([
        undefined,
        { action: "tryTourCommand", command: "view.openKeyboardPreferences" },
        { action: "tryTourCommand", command: "help.tour.openSample" },
        undefined,
        undefined,
        undefined,
        { action: "tryTourCommand", command: "analyze.molecularProperties" },
        undefined, undefined
      ]);
      expect(seen[3]).toMatchObject({ title: STATUS_BAR_TITLE, text: STATUS_BAR_TEXT });
      expect(seen[4]).toMatchObject({ title: PLUGINS_TITLE, text: `${PLUGINS_TEXT}\n${PLUGIN_AUTHORING_GUIDE_URL}` });
      expect(seen[5]).toMatchObject({
        title: "Structure search",
        text: "Use Tools to search PubChem or Reaxys by the selected structure. Optional plugin: add Name to Structure from " +
          "Plugins > Add or Remove Plugins… to draw a structure from a chemical name."
      });
      expect(seen.map(step => step.text).join("\n")).not.toContain("The Name to Structure plugin draws");
      expect(seen.at(-1)!.title).toBe("Make it yours");
    }
  });

  it("with every plugin installed, shows the plugins card and then the plugin's own step", () => {
    const onAction = vi.fn();
    const plugins = availableTourPluginCommands(menuItemsFor(allPluginIds));
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={plugins} onAction={onAction} />));
    const seen = walk(onAction);
    expect(seen.map(step => step.counter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `Step ${n} of 9`));
    expect(seen.map(step => step.title)).toEqual([
      "Welcome to ChemDraft", "Choose your shortcuts", "Draw a structure", STATUS_BAR_TITLE, PLUGINS_TITLE,
      "Names and structure search", "Analysis and 3D", "Save, export, and copy", "Make it yours"
    ]);
    expect(seen[5]).toEqual({
      counter: "Step 6 of 9", title: "Names and structure search",
      text: "The Name to Structure plugin draws from a chemical name through the Structure menu. Use Tools to search PubChem or Reaxys by the selected structure.",
      tried: { action: "tryTourCommand", command: TOUR_NAME_COMMAND }
    });
    expect(seen[4]).toMatchObject({ text: `${PLUGINS_TEXT}\n${PLUGIN_AUTHORING_GUIDE_URL}`, tried: undefined });
  });

  it("always explains plugins before any step shows a plugin feature (derived from the step data)", () => {
    const pluginCommands: readonly TourTryCommand[] = TOUR_PLUGIN_COMMANDS;
    const pluginWords = /plugin/i;
    for (const scheme of schemes) {
      for (const plugins of [[], TOUR_PLUGIN_COMMANDS] as readonly (readonly TourPluginCommand[])[]) {
        const steps = tourSteps(scheme, platform, plugins);
        const cards = steps.flatMap((step, index) => step.introducesPlugins ? [index] : []);
        expect(cards).toHaveLength(1);
        const card = cards[0]!;
        expect(steps[card]!.title).toBe(PLUGINS_TITLE);
        // A step shows a plugin feature when it declares the plugin, offers a plugin command as its Try
        // it, or mentions plugins in its text. Each such step must come after the card.
        const showsPlugin = steps.flatMap((step, index) => index !== card && (
          step.plugin !== undefined
          || (step.tryCommand !== undefined && pluginCommands.includes(step.tryCommand))
          || pluginWords.test(step.text)
        ) ? [index] : []);
        // Never vacuous: Name to Structure is shown (installed) or named as optional (not installed).
        expect(showsPlugin.length).toBeGreaterThan(0);
        for (const index of showsPlugin) expect(card).toBeLessThan(index);
        // A step whose Try it runs a plugin command declares that plugin, so the data stays honest.
        for (const step of steps) {
          if (step.tryCommand !== undefined && pluginCommands.includes(step.tryCommand)) expect(step.plugin).toBe(step.tryCommand);
        }
      }
    }
  });

  it("words the plugins card in the menu's own words", () => {
    const sections = buildAppMenuModel({
      platform, rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false,
      hasSelection: false, hasSelectedMolecule: false, toolbars: []
    });
    const menu = sections.find(section => section.id === "plugins")!;
    const labels = flattenAppMenuCommands([menu]).map(item => item.label);
    expect([menu.label, ...labels]).toEqual(["Plugins", "Add or Remove Plugins…", "Vibe Code Your Own Plugin…"]);
    for (const scheme of schemes) {
      for (const plugins of [[], TOUR_PLUGIN_COMMANDS] as readonly (readonly TourPluginCommand[])[]) {
        const step = tourSteps(scheme, platform, plugins).find(item => item.introducesPlugins)!;
        expect(step).toEqual({ title: PLUGINS_TITLE, text: PLUGINS_TEXT, url: PLUGIN_AUTHORING_GUIDE_URL, introducesPlugins: true });
        expect(step.text).toContain("you can vibe code your own");
        expect(step.text).toContain(`${menu.label} > ${labels[0]}`);
        expect(step.text).toContain(`${menu.label} > ${labels[1]}`);
        expect(step.text).not.toMatch(/colour|catalogue|chemdraw|marvin|chemsketch|ketcher/i);
      }
    }
  });

  it("keeps the step list fixed while the tour is open when a plugin is installed or removed", () => {
    const onAction = vi.fn();
    const render = (plugins: readonly TourPluginCommand[]) =>
      act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={plugins} onAction={onAction} />));
    render([...TOUR_PLUGIN_COMMANDS]);
    for (let step = 1; step < 6; step++) click("Next");
    expect(container.textContent).toContain("Step 6 of 9");
    render([]);
    expect(container.textContent).toContain("Step 6 of 9");
    expect(container.querySelector("h1")!.textContent).toBe("Names and structure search");
    expect(button("Try it")).toBeDefined();

    act(() => root.unmount());
    root = createRoot(container);
    render([]);
    for (let step = 1; step < 6; step++) click("Next");
    render([...TOUR_PLUGIN_COMMANDS]);
    expect(container.textContent).toContain("Step 6 of 9");
    expect(container.querySelector("h1")!.textContent).toBe("Structure search");
    expect(button("Try it")).toBeUndefined();
    for (let step = 6; step < 9; step++) click("Next");
    expect(container.textContent).toContain("Step 9 of 9");
    expect(button("Next")).toBeUndefined();
    click("Finish");
    expect(onAction).toHaveBeenLastCalledWith({ action: "finish" });
  });

  it("takes the menu's plugin list when the browser tour opens, and Finish saves the tour as seen", async () => {
    let available: readonly TourPluginCommand[] = [];
    let api: ReturnType<typeof useGuidedTour> | undefined;
    const invoke = vi.fn(async () => undefined);
    function Host() {
      const tour = useGuidedTour({
        coordinator: () => undefined, readyAndIdle: () => true, scheme: "chemdraft", platform,
        plugins: () => available, mode: "suppress", setStatus: () => {}
      });
      api = tour;
      return tour.renderBrowser(action => tour.completeOrRun(action, { invoke, has: () => available.length > 0 }));
    }
    await act(async () => root.render(createElement(Host)));
    await act(async () => { await api!.open(); });
    await act(async () => { await import("./TourForm"); });
    expect(container.textContent).toContain("Step 1 of 9");
    available = [...TOUR_PLUGIN_COMMANDS];
    for (let step = 1; step < 6; step++) await act(async () => { button("Next")!.click(); });
    // Installed after the tour opened: step 6 stays the version without it.
    expect(container.textContent).toContain("Step 6 of 9");
    expect(button("Try it")).toBeUndefined();
    for (let step = 6; step < 9; step++) await act(async () => { button("Next")!.click(); });
    await act(async () => { button("Finish")!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(localStorage.getItem("chemdraft.guidedTourSeen")).toBe("true");
    expect(container.querySelector(".guided-tour")).toBeNull();

    // Reopened after the plugin was installed: its step is back, and Try it reaches it.
    await act(async () => { await api!.open(); });
    expect(container.textContent).toContain("Step 1 of 9");
    for (let step = 1; step < 6; step++) await act(async () => { button("Next")!.click(); });
    await act(async () => { button("Try it")!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(invoke).toHaveBeenLastCalledWith(TOUR_NAME_COMMAND);
  });
});
