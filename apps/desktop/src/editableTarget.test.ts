// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEditableTarget } from "./editableTarget";

describe("isEditableTarget", () => {
  it.each(["text", "number"])("accepts a %s input", type => {
    const input = document.createElement("input");
    input.type = type;
    expect(isEditableTarget(input)).toBe(true);
  });

  it("accepts an input without a type and keeps read-only text inputs editable", () => {
    const input = document.createElement("input");
    expect(isEditableTarget(input)).toBe(true);
    input.readOnly = true;
    expect(isEditableTarget(input)).toBe(true);
  });

  it.each(["checkbox", "radio", "range", "button"])("rejects a %s input", type => {
    const input = document.createElement("input");
    input.type = type;
    expect(isEditableTarget(input)).toBe(false);
  });

  it("rejects selects and disabled inputs", () => {
    expect(isEditableTarget(document.createElement("select"))).toBe(false);
    const input = document.createElement("input");
    input.disabled = true;
    expect(isEditableTarget(input)).toBe(false);
  });

  it("accepts textareas", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
  });

  it("accepts contenteditable elements and respects explicit false inheritance", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isEditableTarget(editable)).toBe(true);

    const nonEditableChild = document.createElement("span");
    nonEditableChild.setAttribute("contenteditable", "false");
    editable.append(nonEditableChild);
    expect(isEditableTarget(nonEditableChild)).toBe(false);

    const nonEditable = document.createElement("div");
    nonEditable.setAttribute("contenteditable", "false");
    const editableChild = document.createElement("span");
    editableChild.setAttribute("contenteditable", "true");
    nonEditable.append(editableChild);
    expect(isEditableTarget(nonEditableChild)).toBe(false);
    expect(isEditableTarget(editableChild)).toBe(true);
  });

  it("accepts descendants of text object editors", () => {
    const editor = document.createElement("div");
    editor.className = "text-object-editor";
    const child = document.createElement("span");
    editor.append(child);
    expect(isEditableTarget(child)).toBe(true);
  });

  it("handles null and text node targets", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createTextNode("text"))).toBe(false);
    const textarea = document.createElement("textarea");
    const text = document.createTextNode("text");
    textarea.append(text);
    expect(isEditableTarget(text)).toBe(true);
  });
});
