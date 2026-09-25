import { describe, expect, it } from "vitest";
import { isBrowserReloadChord } from "./keyboardShortcuts";

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
