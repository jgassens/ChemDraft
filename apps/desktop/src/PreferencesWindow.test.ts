import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { MemoryStorage } from "./testSupport/memoryStorage";

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

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
  it("renders the refinement, engine, and force-field sections with their options", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    for (const heading of ["3D refinement", "Embedding engine", "Force field"]) {
      expect(markup).toContain(heading);
    }
    for (const title of ["Fast", "Balanced", "Quality", "Automatic", "RDKit ETKDG", "OpenChemLib (legacy)", "MMFF94", "UFF"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain("Requires the RDKit engine");
  });

  it("reflects persisted settings as one selected option per group", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "balanced", enginePreference: "openchemlib", forceField: "uff" }));
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    // One selection per radio group (three groups total).
    expect(markup.match(/data-selected="true"/g)).toHaveLength(3);
    expect(markup).toMatch(selected("spin3d-refinement-mode", "balanced"));
    expect(markup).toMatch(selected("spin3d-engine", "openchemlib"));
    expect(markup).toMatch(selected("spin3d-force-field", "uff"));
  });

  it("defaults to quality / auto / mmff94 when nothing is stored", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup.match(/data-selected="true"/g)).toHaveLength(3);
    expect(markup).toMatch(selected("spin3d-refinement-mode", "quality"));
    expect(markup).toMatch(selected("spin3d-engine", "auto"));
    expect(markup).toMatch(selected("spin3d-force-field", "mmff94"));
  });
});
