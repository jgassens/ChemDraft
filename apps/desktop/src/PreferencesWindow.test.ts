import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { saveExportPreviewEnabled } from "./exportPreviewSettings";
import { saveAutomaticPluginUpdates } from "./pluginUpdateSettings";
import { saveAskToSaveBeforeQuit } from "./quitSettings";
import { saveDrawingSettings } from "./drawingSettings";
import { ELECTRON_MARK_EDITING_STORAGE_KEY, loadDirectElectronMarkEditing, saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";
const KEYBINDINGS_STORAGE_KEY = "chemdraft.keybindings.v1";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Matches the selected option (data-selected="true") for a given radio group + value,
 *  independent of input attribute order. */
const selected = (name: string, value: string) =>
  new RegExp(`data-selected="true"><input[^>]*name="${name}"[^>]*value="${value}"`);

// Scope checkbox assertions to their label now that automatic updates are on by default.
const checkboxLabel = (markup: string, text: string) =>
  markup.match(/<label\b[^>]*>[\s\S]*?<\/label>/g)?.find(label => label.includes(text)) ?? "";

describe("PreferencesWindow", () => {
  it("offers direct electron-mark editing off by default and persists only a boolean opt-in", () => {
    expect(loadDirectElectronMarkEditing()).toBe(false);
    let markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Direct electron-mark editing")).not.toMatch(/type="checkbox"[^>]*checked/);
    for (const invalid of ["null", "{}", "1", "\"true\"", "broken"]) {
      storage.setItem(ELECTRON_MARK_EDITING_STORAGE_KEY, invalid);
      expect(loadDirectElectronMarkEditing()).toBe(false);
    }
    saveDirectElectronMarkEditing(true);
    expect(loadDirectElectronMarkEditing()).toBe(true);
    markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Direct electron-mark editing")).toMatch(/type="checkbox"[^>]*checked/);
    saveDirectElectronMarkEditing(false);
    expect(loadDirectElectronMarkEditing()).toBe(false);
  });
  it("offers automatic plugin checks on by default and reflects opt-out", () => {
    let markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Check for plugin updates automatically")).toMatch(/type="checkbox"[^>]*checked/);
    saveAutomaticPluginUpdates(false);
    markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Check for plugin updates automatically")).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it("offers export preview off by default and reflects the saved opt-in", () => {
    let markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup).toContain("Export preview and size presets");
    expect(markup).toContain("Show a live preview and size presets in the Export window");
    expect(markup).toContain('<span class="preferences-radio-body"><span>Export preview and size presets</span><small>');
    expect(checkboxLabel(markup, "Export preview and size presets")).not.toMatch(/type="checkbox"[^>]*checked/);
    saveExportPreviewEnabled(true);
    markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Export preview and size presets")).toMatch(/type="checkbox"[^>]*checked/);
  });
  it("offers an unchecked quit preference by default and reflects opt-in", () => {
    let markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup).toContain("Ask to save unsaved changes before quitting");
    expect(checkboxLabel(markup, "Ask to save unsaved changes before quitting")).not.toMatch(/type="checkbox"[^>]*checked/);
    saveAskToSaveBeforeQuit(true);
    markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(checkboxLabel(markup, "Ask to save unsaved changes before quitting")).toMatch(/type="checkbox"[^>]*checked/);
  });
  it("renders the keyboard, refinement, engine, and force-field sections with their options", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup).toContain('<h2 id="preferences-keyboard">Keyboard</h2>');
    expect(markup).toMatch(/<input[^>]*type="search"[^>]*aria-label="Search shortcuts"/);
    for (const heading of ["3D refinement", "Embedding engine", "Force field"]) {
      expect(markup).toContain(heading);
    }
    for (const title of ["Fast", "Balanced", "Quality", "Automatic", "RDKit ETKDG", "OpenChemLib (legacy)", "MMFF94s", "MMFF94", "UFF"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain("Requires the RDKit engine");
  });

  it("reflects persisted settings as one selected option per group", () => {
    saveDrawingSettings({ defaultDoubleBond: "centred" });
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "balanced", enginePreference: "openchemlib", forceField: "uff" }));
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    // One selection per radio group (four groups total).
    expect(markup.match(/data-selected="true"/g)).toHaveLength(4);
    expect(markup).toMatch(selected("default-double-bond", "centred"));
    expect(markup).toMatch(selected("spin3d-refinement-mode", "balanced"));
    expect(markup).toMatch(selected("spin3d-engine", "openchemlib"));
    expect(markup).toMatch(selected("spin3d-force-field", "uff"));
  });

  // One built-in shortcut set: the Keyboard page customizes it and offers no preset to choose,
  // whatever an older version stored, and names no other product.
  it.each([
    ["nothing stored", undefined],
    ["the retired preset stored", JSON.stringify({ scheme: "chemdraft" })],
    ["the set stored", JSON.stringify({ scheme: "chemdraw" })],
    ["malformed settings", "{not json"]
  ])("renders no shortcut preset chooser with %s", (_label, stored) => {
    if (stored !== undefined) storage.setItem(KEYBINDINGS_STORAGE_KEY, stored);
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup).not.toMatch(/name="keybinding-scheme"/);
    expect(markup).not.toContain("Shortcut scheme");
    const keyboard = markup.match(/<section[^>]*id="keyboard"[\s\S]*?<\/section>\s*<\/section>/)?.[0];
    expect(keyboard).toBeDefined();
    const visibleText = keyboard!.replace(/<[^>]*>/g, " ");
    expect(visibleText).not.toMatch(/chemdraw|classic|desktop-compatible|preset|scheme/i);
    expect(visibleText).toContain("Reset all to defaults");
  });

  it("defaults to quality / auto / mmff94s when nothing is stored", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup.match(/data-selected="true"/g)).toHaveLength(4);
    expect(markup).toMatch(selected("default-double-bond", "offset"));
    expect(markup).toMatch(selected("spin3d-refinement-mode", "quality"));
    expect(markup).toMatch(selected("spin3d-engine", "auto"));
    expect(markup).toMatch(selected("spin3d-force-field", "mmff94s"));
  });
});
