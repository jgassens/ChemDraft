// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactionConditionsDraft } from "@chemdraft/document-workflow-core";
import { ReactionConditionsForm, changeConditionsText } from "./ReactionConditionsForm";
import { validConditionsDraft } from "./dialogProtocol";
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const initial: ReactionConditionsDraft = { side: "above", spans: [{ text: "K2CO3", script: "normal" }] };
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
function type(text: string) {
  const field = container.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
describe("Reaction conditions form", () => {
  it("formats a selection, retains scripts through edits and previews real text safely", async () => {
    let latest = initial;
    function Form() {
      const [draft, setDraft] = useState(initial);
      return createElement(ReactionConditionsForm, { title: "Drawing", draft, onChange: value => { latest = value; setDraft(value); }, onSave: vi.fn(), onCancel: vi.fn() });
    }
    await act(async () => root.render(createElement(Form)));
    const field = container.querySelector("textarea")!;
    expect([...container.querySelectorAll('select option')].map(option=>option.textContent)).toEqual(['Top / inside','Bottom / outside']);
    expect(document.activeElement).toBe(field);
    field.setSelectionRange(1, 2);
    await act(async () => button("subscript").click());
    expect(container.querySelector('.reaction-conditions-preview [data-text-script="subscript"]')?.textContent).toBe("2");
    expect(latest.spans).toEqual([{ text: "K", script: "normal" }, { text: "2", script: "subscript" }, { text: "CO3", script: "normal" }]);
    await act(async () => button("normal").click());
    field.setSelectionRange(5, 5);
    await act(async () => type("K2CO3\n80 <script>"));
    expect(container.querySelector('.reaction-conditions-preview script')).toBeNull();
    expect(container.querySelector('.reaction-conditions-preview')?.textContent).toContain("<script>");
  });
  it.each(["macos", "windows"] as const)("blocks reload and supports %s close keys without submitting multiline text", async platform => {
    const save = vi.fn(), cancel = vi.fn();
    await act(async () => root.render(createElement(ReactionConditionsForm, { title: "Drawing", draft: initial, onChange: vi.fn(), onSave: save, onCancel: cancel, platform })));
    const field = container.querySelector("textarea")!, modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    for (const key of ["F5", "r"]) {
      const event = new KeyboardEvent("keydown", { key, ...modifier, bubbles: true, cancelable: true });
      await act(async () => field.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true);
    }
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(save).not.toHaveBeenCalled();
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ...modifier, bubbles: true, cancelable: true })));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves Unicode offsets and refuses oversized native payloads", () => {
    const draft: ReactionConditionsDraft = { side: "below", spans: [{ text: "μ", script: "normal" }, { text: "2", script: "superscript" }] };
    expect(changeConditionsText(draft, "μ2 + 🙂", "normal").spans).toEqual([...draft.spans, { text: " + 🙂", script: "normal" }]);
    expect(validConditionsDraft(draft)).toBe(true);
    expect(validConditionsDraft({ ...draft, spans: [{ text: "Δ".repeat(1400), script: "normal" }] })).toBe(false);
    expect(validConditionsDraft({ ...draft, spans: [{ text: "x", script: "unknown" }] })).toBe(false);
  });
  it("keeps formatting on the correct repeated character when inserting at the caret", () => {
    const draft: ReactionConditionsDraft = { side: "above", spans: [
      { text: "A", script: "superscript" }, { text: "A", script: "normal" }
    ] };
    expect(changeConditionsText(draft, "AAA", "normal", { start: 0, end: 0 }).spans).toEqual([
      { text: "A", script: "normal" }, { text: "A", script: "superscript" }, { text: "A", script: "normal" }
    ]);
    expect(changeConditionsText(draft, "A", "normal", { start: 0, end: 1 }).spans).toEqual([
      { text: "A", script: "normal" }
    ]);
  });
  it("uses the textarea edit range for repeated formatted text", async () => {
    const initialDraft: ReactionConditionsDraft = { side: "above", spans: [
      { text: "A", script: "superscript" }, { text: "A", script: "normal" }
    ] };
    let latest = initialDraft;
    function Form() {
      const [draft, setDraft] = useState(initialDraft);
      return createElement(ReactionConditionsForm, { title: "Drawing", draft,
        onChange: value => { latest = value; setDraft(value); }, onSave: vi.fn(), onCancel: vi.fn() });
    }
    await act(async () => root.render(createElement(Form)));
    const field = container.querySelector("textarea")!;
    field.setSelectionRange(0, 0);
    await act(async () => {
      field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "A" }));
      type("AAA");
    });
    expect(latest.spans).toEqual([
      { text: "A", script: "normal" }, { text: "A", script: "superscript" }, { text: "A", script: "normal" }
    ]);
    expect(container.querySelector('.reaction-conditions-preview [data-text-script="superscript"]')?.textContent).toBe("A");
  });
  it("keeps the surviving word's script when deleting an earlier repeated word", () => {
    const draft: ReactionConditionsDraft = { side: "above", spans: [
      { text: "AA ", script: "superscript" }, { text: "AA", script: "normal" }
    ] };
    expect(changeConditionsText(draft, "AA", "normal", { start: 0, end: 3 }).spans).toEqual([
      { text: "AA", script: "normal" }
    ]);
  });
  it("uses the beforeinput word-deletion range instead of matching repeated words", async () => {
    const initialDraft: ReactionConditionsDraft = { side: "above", spans: [
      { text: "AA ", script: "superscript" }, { text: "AA", script: "normal" }
    ] };
    let latest = initialDraft;
    function Form() {
      const [draft, setDraft] = useState(initialDraft);
      return createElement(ReactionConditionsForm, { title: "Drawing", draft,
        onChange: value => { latest = value; setDraft(value); }, onSave: vi.fn(), onCancel: vi.fn() });
    }
    await act(async () => root.render(createElement(Form)));
    const field = container.querySelector("textarea")!;
    field.setSelectionRange(0, 0);
    await act(async () => {
      field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteWordForward" }));
      type("AA");
    });
    expect(latest.spans).toEqual([{ text: "AA", script: "normal" }]);
  });
});
