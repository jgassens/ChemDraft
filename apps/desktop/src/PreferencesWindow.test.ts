import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";

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

describe("PreferencesWindow", () => {
  it("renders the keybinding, refinement, engine, and force-field sections with their options", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    for (const heading of ["Keyboard shortcuts", "3D refinement", "Embedding engine", "Force field"]) {
      expect(markup).toContain(heading);
    }
    for (const title of ["ChemDraft", "ChemDraw-compatible", "Fast", "Balanced", "Quality", "Automatic", "RDKit ETKDG", "OpenChemLib (legacy)", "MMFF94s", "MMFF94", "UFF"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain("Requires the RDKit engine");
    // The ChemDraw scheme description quotes ambiguous key names (React SSR escapes them as
    // &quot;) and calls out case sensitivity.
    expect(markup).toContain("&quot;l&quot; for Cl");
    expect(markup).toContain("Case matters for element keys: B = boron, b = Br");
  });

  it("reflects persisted settings as one selected option per group", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "balanced", enginePreference: "openchemlib", forceField: "uff" }));
    storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ scheme: "chemdraw" }));
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    // One selection per radio group (four groups total).
    expect(markup.match(/data-selected="true"/g)).toHaveLength(4);
    expect(markup).toMatch(selected("keybinding-scheme", "chemdraw"));
    expect(markup).toMatch(selected("spin3d-refinement-mode", "balanced"));
    expect(markup).toMatch(selected("spin3d-engine", "openchemlib"));
    expect(markup).toMatch(selected("spin3d-force-field", "uff"));
  });

  it("defaults to chemdraft / quality / auto / mmff94s when nothing is stored", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup.match(/data-selected="true"/g)).toHaveLength(4);
    expect(markup).toMatch(selected("keybinding-scheme", "chemdraft"));
    expect(markup).toMatch(selected("spin3d-refinement-mode", "quality"));
    expect(markup).toMatch(selected("spin3d-engine", "auto"));
    expect(markup).toMatch(selected("spin3d-force-field", "mmff94s"));
  });
});
