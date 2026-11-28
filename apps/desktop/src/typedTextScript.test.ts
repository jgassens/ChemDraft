import { describe, expect, it } from "vitest";
import { createPhase4Document, insertNativeTextObject, textObjectFormattingRuns, textScriptForTypingAt, updateNativeTextObjectText } from "./documentWorkflow";
import {
  pendingTypedScriptSurvivesSelection, recordTextEditFormatting, stepTextEditFormatting, toggledPendingTypedScript,
  typedScriptInsertion, type TextEditFormattingState
} from "./typedTextScript";
import type { TextObject } from "@chemdraft/chem-core";

describe("script toggled at a collapsed caret", () => {
  it("toggles on, then off, at the same caret, for subscript and superscript alike", () => {
    for (const script of ["subscript", "superscript"] as const) {
      const on = toggledPendingTypedScript(undefined, "t", 1, script, "normal");
      expect(on).toEqual({ objectId: "t", caret: 1, script });
      expect(toggledPendingTypedScript(on, "t", 1, script, "normal").script).toBe("normal");
      // Inside text that already has the script, the toggle turns it off for typing.
      expect(toggledPendingTypedScript(undefined, "t", 3, script, script).script).toBe("normal");
    }
    // A pending script at another caret is ignored.
    const elsewhere = toggledPendingTypedScript(undefined, "t", 1, "subscript", "normal");
    expect(toggledPendingTypedScript(elsewhere, "t", 4, "subscript", "normal").script).toBe("subscript");
    // Switching from subscript to superscript at the caret.
    expect(toggledPendingTypedScript(elsewhere, "t", 1, "superscript", "normal").script).toBe("superscript");
  });

  it("finds an insertion at the pending caret and follows the caret", () => {
    const pending = { objectId: "t", caret: 1, script: "subscript" as const };
    expect(typedScriptInsertion(pending, "t", "HO", "H2O")).toEqual({
      range: { start: 1, end: 2 }, next: { objectId: "t", caret: 2, script: "subscript" }
    });
    // Repeated letters: the caret, not a text diff, decides which character is new.
    expect(typedScriptInsertion({ ...pending, caret: 1 }, "t", "HH", "HHH")?.range).toEqual({ start: 1, end: 2 });
    expect(typedScriptInsertion(pending, "t", "HO", "HO2")).toBeUndefined();
    expect(typedScriptInsertion(pending, "t", "HO", "H")).toBeUndefined();
    expect(typedScriptInsertion(pending, "other", "HO", "H2O")).toBeUndefined();
    expect(typedScriptInsertion(undefined, "t", "HO", "H2O")).toBeUndefined();
  });

  it("uses the caret after the change to place an ambiguous repeated-letter insertion", () => {
    const pending = { objectId: "t", caret: 1, script: "subscript" as const };
    // HO to HOO: the text alone fits an O typed at offset 1, but the caret says offset 2.
    expect(typedScriptInsertion(pending, "t", "HO", "HOO")?.range).toEqual({ start: 1, end: 2 });
    expect(typedScriptInsertion(pending, "t", "HO", "HOO", 3)).toBeUndefined();
    expect(typedScriptInsertion(pending, "t", "HO", "HOO", 2)).toEqual({
      range: { start: 1, end: 2 }, next: { objectId: "t", caret: 2, script: "subscript" }
    });
    expect(typedScriptInsertion(pending, "t", "HO", "H23O", 3)?.range).toEqual({ start: 1, end: 3 });
  });

  it("keeps a pending script only while the caret stays at the toggled offset", () => {
    const pending = { objectId: "t", caret: 1, script: "subscript" as const };
    expect(pendingTypedScriptSurvivesSelection(pending, "t", { start: 1, end: 1 })).toBe(true);
    expect(pendingTypedScriptSurvivesSelection(pending, "t", { start: 2, end: 2 })).toBe(false);
    expect(pendingTypedScriptSurvivesSelection(pending, "t", { start: 1, end: 2 })).toBe(false);
    expect(pendingTypedScriptSurvivesSelection(pending, "other", { start: 1, end: 1 })).toBe(false);
    expect(pendingTypedScriptSurvivesSelection(undefined, "t", { start: 1, end: 1 })).toBe(false);
  });

  it("gives typed characters the script and sizes the box with it", () => {
    const doc = insertNativeTextObject(createPhase4Document("Typed script"), { x: 100, y: 100 }, "H");
    const id = doc.pages[0].objects.find(object => object.type === "text")!.id;
    const plain = updateNativeTextObjectText(doc, id, "H2");
    const typed = updateNativeTextObjectText(doc, id, "H2", undefined, { range: { start: 1, end: 2 }, script: "subscript" });
    const text = (d: typeof doc) => d.pages[0].objects.find(object => object.id === id) as TextObject;
    expect(text(plain).spans).toEqual([{ text: "H2", script: "normal", style: {} }]);
    expect(text(typed).spans).toEqual([{ text: "H", script: "normal", style: {} }, { text: "2", script: "subscript", style: {} }]);
    expect(textScriptForTypingAt(text(typed), 2)).toBe("subscript");
    expect(textScriptForTypingAt(text(typed), 1)).toBe("subscript");
    expect(textScriptForTypingAt(text(typed), 0)).toBe("normal");
  });

  describe("formatting of native undo states", () => {
    const normal = (text: string) => ({ text, script: "normal" as const, style: {} });
    const sub = (text: string) => ({ text, script: "subscript" as const, style: {} });
    const pending = { objectId: "t", caret: 1, script: "subscript" as const };
    const h: TextEditFormattingState = { text: "H", spans: [normal("H")], pending };
    const h2: TextEditFormattingState = { text: "H2", spans: [normal("H"), sub("2")], pending: { ...pending, caret: 2 } };
    const h23: TextEditFormattingState = { text: "H23", spans: [normal("H"), sub("23")], pending: { ...pending, caret: 3 } };

    it("steps back and forward to the exact runs and pending script of each state", () => {
      let timeline = recordTextEditFormatting(undefined, "t", h, h2);
      timeline = recordTextEditFormatting(timeline, "t", h2, h23);
      const undo = stepTextEditFormatting(timeline, "t", "undo", h23, "H2")!;
      expect(undo.state).toEqual(h2);
      const redo = stepTextEditFormatting(undo.timeline, "t", "redo", undo.state, "H23")!;
      expect(redo.state).toEqual(h23);
      // The browser merged both characters into one undo step: the undo passes over H2.
      const merged = stepTextEditFormatting(timeline, "t", "undo", h23, "H")!;
      expect(merged.state).toEqual(h);
      expect(stepTextEditFormatting(merged.timeline, "t", "redo", merged.state, "H23")?.state).toEqual(h23);
    });

    it("refreshes the state being left and drops redo states after a new edit", () => {
      const timeline = recordTextEditFormatting(undefined, "t", h, h2);
      // H2 was restyled (all subscript) after it was recorded; a redo back to it keeps that.
      const restyled = { ...h2, spans: [sub("H2")] };
      const undo = stepTextEditFormatting(timeline, "t", "undo", restyled, "H")!;
      expect(stepTextEditFormatting(undo.timeline, "t", "redo", undo.state, "H2")?.state).toEqual(restyled);
      const branched = recordTextEditFormatting(undo.timeline, "t", h, { text: "HO", spans: [normal("HO")] });
      expect(stepTextEditFormatting(branched, "t", "redo", branched.states[branched.index]!, "H2")).toBeUndefined();
      expect(stepTextEditFormatting(branched, "t", "undo", branched.states[branched.index]!, "H")?.state).toEqual(h);
    });

    it("gives up when the timeline does not match the editor", () => {
      const timeline = recordTextEditFormatting(undefined, "t", h, h2);
      expect(stepTextEditFormatting(undefined, "t", "undo", h2, "H")).toBeUndefined();
      expect(stepTextEditFormatting(timeline, "other", "undo", h2, "H")).toBeUndefined();
      expect(stepTextEditFormatting(timeline, "t", "undo", h23, "H")).toBeUndefined();
      expect(stepTextEditFormatting(timeline, "t", "undo", h2, "X")).toBeUndefined();
      expect(recordTextEditFormatting(timeline, "other", h, h2)).toEqual({ objectId: "other", states: [h, h2], index: 1 });
    });

    it("puts back exact runs on the text object, and ignores runs that do not spell the text", () => {
      const doc = insertNativeTextObject(createPhase4Document("Restored runs"), { x: 100, y: 100 }, "H");
      const id = doc.pages[0].objects.find(object => object.type === "text")!.id;
      const text = (d: typeof doc) => d.pages[0].objects.find(object => object.id === id) as TextObject;
      const typed = updateNativeTextObjectText(doc, id, "H2", undefined, { range: { start: 1, end: 2 }, script: "subscript" });
      const runs = textObjectFormattingRuns(text(typed));
      expect(runs).toEqual([normal("H"), sub("2")]);
      const plain = updateNativeTextObjectText(typed, id, "H");
      // Without the runs, re-adding the 2 would take the normal H's run.
      expect(text(updateNativeTextObjectText(plain, id, "H2")).spans).toEqual([normal("H2")]);
      const restored = updateNativeTextObjectText(plain, id, "H2", undefined, undefined, runs);
      expect(text(restored).spans).toEqual(runs);
      expect(text(restored).height).toBe(text(typed).height);
      expect(text(updateNativeTextObjectText(plain, id, "H3", undefined, undefined, runs)).spans).toEqual([normal("H3")]);
    });
  });
});
