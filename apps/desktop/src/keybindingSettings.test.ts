import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBINDING_SETTINGS,
  isKeybindingScheme,
  isKeybindingSettings,
  loadKeybindingSettings,
  saveKeybindingSettings
} from "./keybindingSettings";
// jsdom in this project doesn't expose localStorage, and the module reads
// globalThis.localStorage — so stub a minimal in-memory store for these tests.
import { MemoryStorage } from "./testSupport/memoryStorage";

const STORAGE_KEY = "chemdraft.keybindings.v1";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keybindingSettings", () => {
  it("defaults to the native ChemDraft scheme", () => {
    expect(DEFAULT_KEYBINDING_SETTINGS).toEqual({ scheme: "chemdraft" });
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
  });

  it("persists and reloads the chosen scheme", () => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
    saveKeybindingSettings({ scheme: "chemdraft" });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraft" });
  });

  it("falls back to the default on unknown schemes and corrupt JSON", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ scheme: "vim" }));
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
  });

  it("type-guards schemes and settings payloads", () => {
    expect(isKeybindingScheme("chemdraw")).toBe(true);
    expect(isKeybindingScheme("chemdraft")).toBe(true);
    expect(isKeybindingScheme("vim")).toBe(false);
    expect(isKeybindingSettings({ scheme: "chemdraw" })).toBe(true);
    expect(isKeybindingSettings({ scheme: "vim" })).toBe(false);
    expect(isKeybindingSettings(undefined)).toBe(false);
    expect(isKeybindingSettings(null)).toBe(false);
  });
});
