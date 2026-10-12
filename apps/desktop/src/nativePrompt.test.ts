// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { nativePrompt, nativePromptButtons, setNativePromptProvider, useNativePrompt, type NativePromptOptions } from "./nativePrompt";

const plugin = vi.hoisted(() => ({ native: true, message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => plugin.native }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: plugin.message }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const three: NativePromptOptions = {
  title: "Save changes?", message: "Save this drawing before closing?", kind: "warning",
  choices: [
    { id: "discard", label: "Don't Save", destructive: true },
    { id: "cancel", label: "Cancel", cancel: true },
    { id: "save", label: "Save" }
  ]
};
afterEach(() => { plugin.native = true; plugin.message.mockReset(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("nativePrompt", () => {
  it.each(three.choices)("maps the custom label $label back to its choice", async (choice) => {
    plugin.message.mockResolvedValue(choice.label);
    expect(await nativePrompt(three)).toBe(choice.id);
    expect(plugin.message).toHaveBeenCalledWith(three.message, {
      title: three.title, kind: "warning", buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" }
    });
  });

  it.each(["Cancel", "", "unexpected"])("maps OS dismissal / unknown result %s to cancel", async (result) => {
    plugin.message.mockResolvedValue(result);
    expect(await nativePrompt(three)).toBe("cancel");
  });

  it("uses ok/cancel for two safe choices and preserves a custom cancel label", async () => {
    const prompt: NativePromptOptions = { ...three, choices: [
      { id: "resize", label: "Use A3" }, { id: "keep", label: "Keep Current Page", cancel: true }
    ] };
    for (const [result, expected] of [["Use A3", "resize"], ["Keep Current Page", "keep"], ["Cancel", "keep"]]) {
      plugin.message.mockResolvedValue(result);
      expect(await nativePrompt(prompt)).toBe(expected);
    }
    expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({
      buttons: { ok: "Use A3", cancel: "Keep Current Page" }
    }));
  });

  it("uses a single labelled ok button for acknowledgement, including dismissal", async () => {
    const prompt: NativePromptOptions = { ...three, choices: [{ id: "close", label: "Close", cancel: true }] };
    for (const result of ["Close", "Cancel"]) {
      plugin.message.mockResolvedValue(result);
      expect(await nativePrompt(prompt)).toBe("close");
    }
    expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({ buttons: { ok: "Close" } }));
  });

  it("never puts a destructive choice in the native default slot, regardless of input order", () => {
    expect(nativePromptButtons(three)).toEqual({ yes: "Save", no: "Don't Save", cancel: "Cancel" });
    expect(nativePromptButtons({ ...three, choices: [...three.choices].reverse() })).toEqual({ yes: "Save", no: "Don't Save", cancel: "Cancel" });
    expect(nativePromptButtons({ ...three, choices: [
      { id: "delete", label: "Remove", destructive: true }, { id: "keep", label: "Keep", cancel: true }
    ] })).toEqual({ yes: "Keep", no: "Remove", cancel: "Keep" });
  });

  it("rejects ambiguous or unsafe choice specifications", () => {
    for (const choices of [[], three.choices.slice(0, 1), [...three.choices, { id: "fourth", label: "Fourth" }],
      [{ id: "delete", label: "Delete", cancel: true, destructive: true }],
      [{ id: "one", label: "Same", cancel: true }, { id: "two", label: "Same" }]]) {
      expect(() => nativePromptButtons({ ...three, choices })).toThrow();
    }
  });

  it("an injected provider gets the same request and may choose the existing fallback", async () => {
    const fallback = vi.fn(async () => "save");
    const fake = vi.fn((prompt: NativePromptOptions, render: (prompt: NativePromptOptions) => Promise<string>) => render(prompt));
    const restore = setNativePromptProvider(fake);
    try {
      expect(await nativePrompt(three, fallback)).toBe("save");
      expect(fake).toHaveBeenCalledWith(three, fallback);
      expect(fallback).toHaveBeenCalledWith(three);
      expect(plugin.message).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("the web fallback renders the retained in-app component and Escape resolves cancel", async () => {
    plugin.native = false;
    const onChoice = vi.fn();
    function ExistingDialog() {
      const prompt = useNativePrompt(three, onChoice, "request");
      return prompt.visible ? createElement("div", {
        role: "dialog", "aria-modal": true, "aria-label": three.title,
        onKeyDown: (event: { key: string }) => { if (event.key === "Escape") prompt.choose("cancel"); }
      }, createElement("button", { onClick: () => prompt.choose("save") }, "Save")) : null;
    }
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ExistingDialog)));
      const dialog = container.querySelector('[role="dialog"]')!;
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("cancel");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(plugin.message).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });

  it("the standalone web fallback restores focus and traps Tab", async () => {
    plugin.native = false;
    const prior = document.createElement("button"); document.body.append(prior); prior.focus();
    const result = nativePrompt(three);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.activeElement?.textContent).toBe("Cancel");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toBe("Save");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(await result).toBe("cancel");
    expect(document.activeElement).toBe(prior);
  });

  it("native API failure falls back without choosing an outcome", async () => {
    plugin.message.mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallback = vi.fn(async () => "cancel");
    expect(await nativePrompt(three, fallback)).toBe("cancel");
    expect(fallback).toHaveBeenCalledWith(three);
  });

  it("StrictMode opens one native box and dispatches one outcome", async () => {
    plugin.message.mockResolvedValue("Cancel");
    const onChoice = vi.fn();
    function Prompt() {
      useNativePrompt(three, onChoice, "strict-request");
      return null;
    }
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(StrictMode, null, createElement(Prompt))));
      await act(async () => { await vi.waitFor(() => expect(plugin.message).toHaveBeenCalledTimes(1)); });
      expect(plugin.message).toHaveBeenCalledTimes(1);
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("cancel");
    } finally { await act(async () => root.unmount()); }
  });

  it("grants message permission to main alone, on both desktop platforms", () => {
    const capability = JSON.parse(readFileSync("apps/desktop/src-tauri/capabilities/native-prompts.json", "utf8"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(["dialog:allow-message"]);
    expect(capability.platforms).toBeUndefined();
  });
});
