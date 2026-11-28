// @vitest-environment jsdom
// RC7 hands-on (Windows, 125%): x2 toggled at a collapsed caret, then an arrow key moved the caret.
// Typing was correctly normal (the pending script is dropped), but the x2 button still looked on,
// and clicking it then turned subscript on with the button looking unchanged. The Text style
// script buttons now show the effective state at the caret after every move: arrows, Home, End and
// clicks alike. The button state is read from what the toolbars render from (the toolset
// text-style payload's currentTextScript, the `active` of x2 and x²).
import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLSET_TEXT_STYLE_EVENT, type ToolsetTextStylePayload } from "./window-manager";
import { TEXTBOX_TYPING_TEST_TIMEOUT, textboxHarness } from "./textbox123.testHelpers";

describe.each(["macos", "windows"] as const)("script buttons follow the caret (%s)", platform => {
  const h = textboxHarness(platform);
  let lastPayload: ToolsetTextStylePayload | undefined;
  const listener = (event: Event) => { lastPayload = (event as CustomEvent<ToolsetTextStylePayload>).detail; };
  beforeEach(async () => {
    lastPayload = undefined;
    window.addEventListener(TOOLSET_TEXT_STYLE_EVENT, listener);
    await h.setup();
  });
  afterEach(async () => {
    window.removeEventListener(TOOLSET_TEXT_STYLE_EVENT, listener);
    await h.teardown();
  });

  const command = async (id: string) => {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  };
  /** The script whose button is lit: x2 for subscript, x² for superscript, neither for normal. */
  const lit = () => lastPayload?.currentTextScript;
  const runs = () => (h.object().spans ?? []).map(span => [span.text, span.script]);
  /** A caret move the browser makes itself (Left/Right in the hidden textarea), then its keyup. */
  const nativeMove = async (offset: number, key: string) => {
    await act(async () => {
      const editor = h.editor();
      editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      editor.setSelectionRange(offset, offset);
      editor.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    });
  };

  const scripts = [
    ["text.script.subscript", "subscript"],
    ["text.script.superscript", "superscript"]
  ] as const;
  const moves: [string, (caret: number) => Promise<number>][] = [
    ["ArrowLeft", async () => { await nativeMove(0, "ArrowLeft"); return 0; }],
    ["ArrowRight", async () => { await nativeMove(2, "ArrowRight"); return 2; }],
    // Line start and end: Home and End on Windows; Cmd+Left and Cmd+Right on macOS, where Home
    // and End scroll and leave the caret alone.
    ["Home", async () => {
      await (platform === "macos" ? h.press("ArrowLeft", { metaKey: true }) : h.press("Home"));
      return h.editor().selectionStart;
    }],
    ["End", async () => {
      await (platform === "macos" ? h.press("ArrowRight", { metaKey: true }) : h.press("End"));
      return h.editor().selectionStart;
    }],
    ["a click", async () => { await h.click(h.editor(), h.clientAt(2), { timeGap: 1000 }); return h.editor().selectionStart; }]
  ];

  describe.each(scripts)("%s", (id, script) => {
    it.each(moves)("is lit while pending, off after %s, and one click turns it on lit", async (_move, move) => {
      await h.mount("HO", { width: 200, mode: "auto" });
      await nativeMove(1, "ArrowLeft");
      expect(lit()).toBe("normal");
      await command(id);
      expect(lit()).toBe(script);
      const caret = await move(1);
      expect(caret).not.toBe(1);
      expect(h.editor().selectionStart).toBe(h.editor().selectionEnd);
      // The pending script is gone, and so is the lit button.
      expect(lit()).toBe("normal");
      // One click: on, and lit.
      await command(id);
      expect(lit()).toBe(script);
      await h.type("2");
      expect(runs().some(([text, runScript]) => text === "2" && runScript === script)).toBe(true);
      // Typing on at the caret keeps it on and lit.
      expect(lit()).toBe(script);
    }, TEXTBOX_TYPING_TEST_TIMEOUT);
  });

  it("goes off when toggled off at the caret, and shows the script typing would take after a subscript", async () => {
    await h.mount("H", { width: 200, mode: "auto" });
    await nativeMove(1, "End");
    await command("text.script.subscript");
    expect(lit()).toBe("subscript");
    await h.type("2");
    expect(lit()).toBe("subscript");
    await command("text.script.subscript");
    expect(lit()).toBe("normal");
    await h.type("O");
    expect(runs()).toEqual([["H", "normal"], ["2", "subscript"], ["O", "normal"]]);
    expect(lit()).toBe("normal");
    // Back to just after the 2 (a typed character there takes the run it lands in, else the one
    // before it): the O follows, so normal. Just before the 2, the 2's run: subscript.
    await nativeMove(2, "ArrowLeft");
    expect(lit()).toBe("normal");
    await nativeMove(1, "ArrowLeft");
    expect(lit()).toBe("subscript");
    // And one click there turns it off for typing, with the button off.
    await command("text.script.subscript");
    expect(lit()).toBe("normal");
  }, TEXTBOX_TYPING_TEST_TIMEOUT);

  it("shows the selection's script for a range, and the box's own script once editing ends", async () => {
    await h.mount("H2O", { width: 200, mode: "auto" });
    await act(async () => {
      const editor = h.editor();
      editor.setSelectionRange(1, 2);
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    });
    expect(lit()).toBe("normal");
    await command("text.script.subscript");
    expect(lit()).toBe("subscript");
    await command("text.script.subscript");
    expect(lit()).toBe("normal");
  }, TEXTBOX_TYPING_TEST_TIMEOUT);
});

describe("toolbar toggle hover", () => {
  // The pointer usually rests on x2 after clicking it, so a hover drawn like the lit state hid
  // whether the script was on. Hover and the palette's synthetic hover now leave "on" to .active.
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  const rulesFor = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors!.split(",").some(part => selector.test(part.trim())))
    .map(([, selectors, body]) => ({ selectors: selectors!.trim(), body: body! }));

  it.each(["toolbar-text-button", "toolbar-align-button"])("%s hover does not look active", (name) => {
    const hover = rulesFor(new RegExp(`^\\.${name}(:hover|\\.palette-synthetic-hover)`));
    expect(hover.length).toBeGreaterThan(0);
    for (const rule of hover) {
      expect(rule.selectors).toMatch(/:not\(\.active\)/);
      expect(rule.body).not.toMatch(/--cd-bg-active|--cd-focus-ring/);
    }
    const active = rulesFor(new RegExp(`^\\.${name}\\.active$`));
    expect(active.some(rule => /--cd-bg-active/.test(rule.body) && /--cd-focus-ring/.test(rule.body))).toBe(true);
  });
});
