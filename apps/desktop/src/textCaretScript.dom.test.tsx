// @vitest-environment jsdom
// Subscript/superscript toggled at a collapsed caret applies to the next typed characters, as in a
// word processor (RC5 report: H, x2, 2, x2, O gave a normal-size 2). Typing uses real events; the
// script toggle runs the registered command, as the Text style toolbar button does.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEXTBOX_TYPING_TEST_TIMEOUT, textboxHarness } from "./textbox123.testHelpers";

describe.each(["macos", "windows"] as const)("script toggled at a collapsed caret (%s)", platform => {
  const h = textboxHarness(platform);
  beforeEach(h.setup);
  afterEach(h.teardown);

  const command = async (id: string) => {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command(id); });
  };
  const caretAtEnd = async () => {
    await act(async () => {
      const editor = h.editor();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
    });
  };
  const runs = () => (h.object().spans ?? []).map(span => [span.text, span.script]);
  const status = () => h.container.querySelector('[role="status"]')?.textContent ?? "";

  it.each([
    ["text.script.subscript", "subscript"],
    ["text.script.superscript", "superscript"]
  ] as const)("%s at the caret styles the next characters, and toggling again goes back to normal", async (id, script) => {
    await h.mount("H", { width: 200, mode: "auto" });
    await caretAtEnd();
    await command(id);
    expect(runs()).toEqual([["H", "normal"]]);
    expect(status()).toMatch(/on for typing/);
    await h.type("2");
    expect(h.object().text).toBe("H2");
    expect(runs()).toEqual([["H", "normal"], ["2", script]]);
    // The script keeps applying while typing continues at the caret.
    await h.type("3");
    expect(runs()).toEqual([["H", "normal"], ["23", script]]);
    await command(id);
    expect(status()).toBe("Normal text for typing");
    await h.type("O");
    expect(h.object().text).toBe("H23O");
    expect(runs()).toEqual([["H", "normal"], ["23", script], ["O", "normal"]]);
    expect(h.editor()).not.toBeNull();
  }, TEXTBOX_TYPING_TEST_TIMEOUT);

  it("drops a toggled script when the caret moves before typing", async () => {
    await h.mount("HO", { width: 200, mode: "auto" });
    await caretAtEnd();
    await command("text.script.subscript");
    await act(async () => {
      const editor = h.editor();
      editor.setSelectionRange(1, 1);
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    });
    await h.type("2");
    expect(h.object().text).toBe("H2O");
    expect(runs()).toEqual([["H2O", "normal"]]);
  }, TEXTBOX_TYPING_TEST_TIMEOUT);

  it("still changes the script of selected text, and turns it off again", async () => {
    await h.mount("H2O", { width: 200, mode: "auto" });
    await act(async () => {
      const editor = h.editor();
      editor.setSelectionRange(1, 2);
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    });
    await command("text.script.subscript");
    expect(runs()).toEqual([["H", "normal"], ["2", "subscript"], ["O", "normal"]]);
    expect(status()).toBe("Updated selected text script");
    await command("text.script.subscript");
    expect(runs()).toEqual([["H2O", "normal"]]);
  }, TEXTBOX_TYPING_TEST_TIMEOUT);
});
