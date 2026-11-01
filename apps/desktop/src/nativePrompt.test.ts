// @vitest-environment jsdom
import { act, createElement, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { MessageDialogCustomButtons } from "@tauri-apps/plugin-dialog";
import { nativePrompt, nativePromptButtons, setNativePromptProvider, useNativePrompt, type NativePromptOptions } from "./nativePrompt";
import { save } from "./nativeFileDialog";

const plugin = vi.hoisted(() => ({ native: true, owner: "main", message: vi.fn(), invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => plugin.native, invoke: plugin.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: plugin.owner }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: plugin.message, save: plugin.save }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const three: NativePromptOptions = {
  title: "Save changes?", message: "Save this drawing before closing?", kind: "warning",
  choices: [
    { id: "discard", label: "Don't Save", destructive: true },
    { id: "cancel", label: "Cancel", cancel: true },
    { id: "save", label: "Save" }
  ]
};

type NativeDialogAction = "return" | "esc" | "close" | `click:${string}`;
function nativeDialogResult(
  buttons: MessageDialogCustomButtons,
  action: NativeDialogAction,
  platform: "windows" | "macos"
): string {
  // rfd 0.16.0 src/backend/{win_cid,macos}/message_dialog.rs: custom clicks return Custom(title).
  if (action.startsWith("click:")) return action.slice("click:".length);
  // rfd win_cid/message_dialog.rs: nDefaultButton = 0 picks the first TaskDialog button.
  // rfd macos/message_dialog.rs: NSAlert adds ok/cancel or yes/no/cancel in order; first is default.
  if (action === "return") return buttons.ok ?? buttons.yes!;
  if (platform === "windows") {
    // rfd win_cid/message_dialog.rs: TDF_ALLOW_DIALOG_CANCELLATION makes Esc/close return IDCANCEL.
    // tauri-plugin-dialog 2.7.1 src/desktop.rs show_message_dialog: Cancel becomes Custom(cancel)
    // for OkCancelCustom and YesNoCancelCustom; otherwise it passes through as "Cancel".
    return buttons.cancel ?? "Cancel";
  }
  // AppKit gives Esc to the button titled "Cancel". NSAlert has no ordinary close button;
  // "close" models modal dismissal, whose rfd Cancel result Tauri remaps to the cancel slot.
  if (action === "esc") return Object.values(buttons).find((label) => label === "Cancel") ?? buttons.cancel ?? "Cancel";
  return buttons.cancel ?? "Cancel";
}

// Exact choices from the destructive prompt callers; expected layouts preserve today's macOS order.
const destructivePrompts: { name: string; choices: NativePromptOptions["choices"]; macos: MessageDialogCustomButtons }[] = [
  {
    // MainWindow.tsx:9241
    name: "Delete the kept drawing? (MainWindow.tsx)",
    choices: [
      { id: "delete", label: "Delete", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { ok: "Cancel", cancel: "Delete" }
  },
  {
    // MainWindow.tsx:9222
    name: "kept drawings (MainWindow.tsx)",
    choices: [
      { id: "save", label: "Save Drawing…" },
      { id: "delete", label: "Delete", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { yes: "Save Drawing…", no: "Delete", cancel: "Cancel" }
  },
  {
    // MainWindow.tsx:9413
    name: "Save changes before quitting? (MainWindow.tsx)",
    choices: [
      { id: "save", label: "Save" },
      { id: "discard", label: "Don't Save", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { yes: "Save", no: "Don't Save", cancel: "Cancel" }
  },
  {
    // MainWindow.tsx:9463
    name: "Save changes before closing? (MainWindow.tsx)",
    choices: [
      { id: "save", label: "Save" },
      { id: "discard", label: "Don't Save", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { yes: "Save", no: "Don't Save", cancel: "Cancel" }
  },
  {
    // MainWindow.tsx:20612
    name: "Clear Overrides (MainWindow.tsx)",
    choices: [
      { id: "keep", label: "Keep Overrides" },
      { id: "clear", label: "Clear Overrides", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { yes: "Keep Overrides", no: "Clear Overrides", cancel: "Cancel" }
  },
  {
    // plugins/PluginManagerDialog.tsx:226
    name: "Remove Engine (plugins/PluginManagerDialog.tsx)",
    choices: [
      { id: "keep", label: "Keep Engine" },
      { id: "remove", label: "Remove Engine", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ],
    macos: { yes: "Keep Engine", no: "Remove Engine", cancel: "Cancel" }
  }
];
afterEach(() => { plugin.native = true; plugin.owner = "main"; plugin.message.mockReset(); plugin.invoke.mockReset(); plugin.save.mockReset(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("nativePrompt", () => {
  const growth: NativePromptOptions = { title: "ChemDraft Assistant", kind: "info", owner: "document",
    message: "Olympiadane needs a page 1960 × 900 pt. Enlarge the page to fit?",
    choices: [{ id: "enlarge", label: "Enlarge Page" }, { id: "decline", label: "Cancel", cancel: true }] };

  it.each(["macos", "windows", "linux"] as const)("requires the document window as native message-box owner on %s", async platform => {
    for (const [answer, expected] of [["Enlarge Page", "enlarge"], ["Cancel", "decline"]]) {
      plugin.message.mockResolvedValue(answer);
      expect(await nativePrompt(growth, undefined, undefined, undefined, platform)).toBe(expected);
      expect(plugin.message).toHaveBeenLastCalledWith(growth.message, {
        title: growth.title, kind: "info", buttons: { ok: "Enlarge Page", cancel: "Cancel" }
      });
    }
    plugin.owner = "plugin-panel";
    plugin.message.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await nativePrompt(growth, async () => "decline", undefined, undefined, platform)).toBe("decline");
    expect(plugin.message).not.toHaveBeenCalled();
  });

  it.each(["macos", "windows"] as const)("rejects the obsolete platform-dependent three-button growth prompt on %s", platform => {
    expect(() => nativePromptButtons({ ...growth, choices: [growth.choices[0]!,
      // Regression: the obsolete special case silently admitted a third macOS button.
      { id: "decline", label: "Don't enlarge", cancel: true }
    ] } as NativePromptOptions, platform)).toThrow(/Cancel/);
  });

  it("ignores approval after cancellation while the native message box is open", async () => {
    let answer!: (label: string) => void;
    plugin.message.mockImplementation(() => new Promise<string>(resolve => { answer = resolve; }));
    const stop = new AbortController();
    const response = nativePrompt(growth, undefined, stop.signal);
    await vi.waitFor(() => expect(plugin.message).toHaveBeenCalledOnce());
    stop.abort();
    expect(await response).toBe("decline");
    answer("Enlarge Page");
    await vi.waitFor(() => expect(plugin.invoke).toHaveBeenLastCalledWith("suspend_toolset_windows", { suspended: false }));
  });

  it("reports opening only after invoking the native box, before its answer", async () => {
    const calls: string[] = [];
    let answer: (label: string) => void = () => {};
    plugin.invoke.mockResolvedValue(undefined);
    plugin.message.mockImplementation(() => {
      calls.push("box");
      return new Promise<string>((resolve) => { answer = resolve; });
    });
    const showing = vi.fn(() => { calls.push("showing"); });
    const response = nativePrompt(three, undefined, undefined, showing);
    await vi.waitFor(() => expect(showing).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["box", "showing"]);
    answer("Cancel");
    expect(await response).toBe("cancel");
  });

  it.each(["saved", "discard", "cancel", "panel cancelled then cancel", "panel throws then cancel"])(
    "keeps utilities hidden across the complete close chain and releases on ending: %s", async (ending) => {
      let depth = 0;
      const calls: string[] = [];
      plugin.invoke.mockImplementation(async (_command, { suspended }) => {
        if (suspended) { if (depth++ === 0) calls.push("hide"); }
        else { expect(depth).toBeGreaterThan(0); if (--depth === 0) calls.push("restore"); }
      });
      const answers = ending === "discard" ? ["Don't Save"] : ending === "cancel" ? ["Cancel"] :
        ending === "saved" ? ["Save"] : ["Save", "Cancel"];
      plugin.message.mockImplementation(async () => {
        expect(depth).toBeGreaterThan(0);
        expect(calls).not.toContain("restore");
        calls.push("box");
        return answers.shift();
      });
      plugin.save.mockImplementation(async () => {
        expect(depth).toBeGreaterThan(0);
        expect(calls).not.toContain("restore");
        calls.push("panel");
        if (ending === "panel throws then cancel") throw new Error("Panel failed");
        return ending === "saved" ? "drawing.chemdraft" : null;
      });
      const onChoice = vi.fn(async (id: string) => {
        if (id !== "save") return;
        try { if (await save({})) return; } catch { /* The close flow re-asks after a save failure. */ }
        return false;
      });
      function Prompt() {
        const [detail, setDetail] = useState("");
        useNativePrompt({ ...three, message: three.message + detail }, async (id) => {
          const repeat = await onChoice(id);
          if (repeat === false) setDetail(" Save canceled. The tab is still open.");
          return repeat;
        }, "close-request", true);
        return null;
      }
      const container = document.createElement("div"); document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(createElement(StrictMode, null, createElement(Prompt))));
        await act(async () => { await vi.waitFor(() => expect(calls.at(-1)).toBe("restore")); });
        expect(depth).toBe(0);
        expect(calls).toEqual(ending === "saved" ? ["hide", "box", "panel", "restore"] :
          ending.startsWith("panel") ? ["hide", "box", "panel", "box", "restore"] : ["hide", "box", "restore"]);
        if (ending.startsWith("panel")) expect(plugin.message.mock.calls[1]![0]).toContain("Save canceled");
      } finally { await act(async () => root.unmount()); }
      expect(depth).toBe(0);
    }
  );
  it.each([false, true])("suspends before the box and restores in finally (box throws: %s)", async (throws) => {
    const calls: string[] = [];
    plugin.invoke.mockImplementation(async (command, { suspended }) => {
      expect(command).toBe("suspend_toolset_windows");
      calls.push(suspended ? "suspend" : "restore");
    });
    plugin.message.mockImplementation(async () => {
      calls.push("box");
      if (throws) throw new Error("unavailable");
      return "Save";
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallback = vi.fn(async () => { calls.push("fallback"); return "cancel"; });
    expect(await nativePrompt(three, fallback)).toBe(throws ? "cancel" : "save");
    expect(calls).toEqual(throws ? ["suspend", "box", "restore", "fallback"] : ["suspend", "box", "restore"]);
  });

  it("refuses to open the native box when suspension fails", async () => {
    plugin.invoke.mockRejectedValue(new Error("quitting"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await nativePrompt(three, async () => "cancel")).toBe("cancel");
    expect(plugin.message).not.toHaveBeenCalled();
    expect(plugin.invoke).toHaveBeenCalledTimes(1);
  });

  it("retains the native answer if restoration is refused during quit", async () => {
    plugin.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("quitting"));
    plugin.message.mockResolvedValue("Save");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallback = vi.fn();
    expect(await nativePrompt(three, fallback)).toBe("save");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("releases an acquisition aborted while suspension was in flight without opening a box", async () => {
    const controller = new AbortController();
    plugin.invoke.mockImplementation(async (_command, { suspended }) => {
      if (suspended) controller.abort();
    });
    expect(await nativePrompt(three, undefined, controller.signal)).toBe("cancel");
    expect(plugin.message).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(plugin.invoke.mock.calls).toEqual([
      ["suspend_toolset_windows", { suspended: true }], ["suspend_toolset_windows", { suspended: false }]
    ]));
  });

  it("balances every overlapping native prompt independently", async () => {
    const resolve: ((result: string) => void)[] = [];
    plugin.message.mockImplementation(() => new Promise<string>((done) => resolve.push(done)));
    const first = nativePrompt(three);
    const second = nativePrompt(three);
    await vi.waitFor(() => expect(resolve).toHaveLength(2));
    expect(plugin.invoke.mock.calls).toEqual([
      ["suspend_toolset_windows", { suspended: true }], ["suspend_toolset_windows", { suspended: true }]
    ]);
    resolve[1]!("Cancel"); await second;
    resolve[0]!("Save"); await first;
    expect(plugin.invoke.mock.calls.slice(2)).toEqual([
      ["suspend_toolset_windows", { suspended: false }], ["suspend_toolset_windows", { suspended: false }]
    ]);
  });
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

  it("uses ok/cancel for one action beside Cancel", async () => {
    const prompt: NativePromptOptions = { ...three, choices: [
      { id: "resize", label: "Use A3 Page" }, { id: "keep", label: "Cancel", cancel: true }
    ] };
    for (const [result, expected] of [["Use A3 Page", "resize"], ["Cancel", "keep"]]) {
      plugin.message.mockResolvedValue(result);
      expect(await nativePrompt(prompt)).toBe(expected);
    }
    expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({
      buttons: { ok: "Use A3 Page", cancel: "Cancel" }
    }));
  });

  it("uses a single OK button for a notice, including dismissal", async () => {
    const prompt: NativePromptOptions = { ...three, choices: [{ id: "close", label: "OK", cancel: true }] };
    for (const result of ["OK", "Cancel"]) {
      plugin.message.mockResolvedValue(result);
      expect(await nativePrompt(prompt)).toBe("close");
    }
    expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({ buttons: { ok: "OK" } }));
  });

  it("never puts a destructive choice in a three-choice native default slot, regardless of input order", () => {
    expect(nativePromptButtons(three)).toEqual({ yes: "Save", no: "Don't Save", cancel: "Cancel" });
    expect(nativePromptButtons({ ...three, choices: [...three.choices].reverse() })).toEqual({ yes: "Save", no: "Don't Save", cancel: "Cancel" });
    expect(nativePromptButtons({ ...three, choices: [
      { id: "remove", label: "Remove Engine", destructive: true }, { id: "keep", label: "Keep Engine" },
      { id: "cancel", label: "Cancel", cancel: true }
    ] })).toEqual({ yes: "Keep Engine", no: "Remove Engine", cancel: "Cancel" });
  });

  it("defaults a destructive confirmation to Cancel on macOS without duplicating buttons", () => {
    expect(nativePromptButtons({ ...three, choices: [
      { id: "remove", label: "Remove", destructive: true }, { id: "cancel", label: "Cancel", cancel: true }
    ] }, "macos")).toEqual({ ok: "Cancel", cancel: "Remove" });
    for (const prompt of [three, { ...three, choices: [{ id: "a", label: "Use A3 Page" }, { id: "c", label: "Cancel" as const, cancel: true as const }] }]) {
      const labels = Object.values(nativePromptButtons(prompt));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it.each(["MacIntel", "Win32"])("maps confirmation clicks and Escape safely on %s", async (platform) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    const prompt: NativePromptOptions = { ...three, choices: [
      { id: "delete", label: "Delete", destructive: true }, { id: "cancel", label: "Cancel", cancel: true }
    ] };
    for (const [result, id] of [["Delete", "delete"], ["Cancel", "cancel"], ["", "cancel"]]) {
      plugin.message.mockResolvedValue(result);
      expect(await nativePrompt(prompt)).toBe(id);
      expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({
        buttons: platform === "MacIntel" ? { ok: "Cancel", cancel: "Delete" } : { ok: "Delete", cancel: "Cancel" }
      }));
    }
  });

  describe.each(["windows", "macos"] as const)("%s native result mapping", (platform) => {
    it.each(destructivePrompts)("preserves button layout and cancels Esc/Windows close for $name", async ({ choices, macos }) => {
      const prompt: NativePromptOptions = { ...three, choices };
      const expected = platform === "windows" && choices.length === 2
        ? { ok: "Delete", cancel: "Cancel" } : macos;
      expect(nativePromptButtons(prompt, platform)).toEqual(expected);
      // NSAlert has no ordinary close button; only Windows has both dismissal gestures.
      const dismissals = platform === "windows" ? ["esc", "close"] as const : ["esc"] as const;
      for (const action of dismissals) {
        plugin.message.mockImplementation(async (_message, { buttons }) => nativeDialogResult(buttons, action, platform));
        expect(await nativePrompt(prompt, undefined, undefined, undefined, platform)).toBe("cancel");
        expect(plugin.message).toHaveBeenLastCalledWith(prompt.message, expect.objectContaining({ buttons: expected }));
      }
    });

    it("Return chooses Delete on Windows and Cancel on macOS for the two-button confirmation", async () => {
      const prompt: NativePromptOptions = { ...three, choices: destructivePrompts[0]!.choices };
      plugin.message.mockImplementation(async (_message, { buttons }) => nativeDialogResult(buttons, "return", platform));
      expect(await nativePrompt(prompt, undefined, undefined, undefined, platform)).toBe(platform === "windows" ? "delete" : "cancel");
    });

    it.each(destructivePrompts)("runs only the explicitly clicked choice for $name", async ({ choices }) => {
      const prompt: NativePromptOptions = { ...three, choices };
      for (const choice of choices) {
        plugin.message.mockImplementation(async (_message, { buttons }) => nativeDialogResult(buttons, `click:${choice.label}`, platform));
        expect(await nativePrompt(prompt, undefined, undefined, undefined, platform)).toBe(choice.id);
      }
    });
  });

  it("keeps Cancel in the cancel slot for destructive confirmations on Windows and Linux", () => {
    const prompt: NativePromptOptions = { ...three, choices: destructivePrompts[0]!.choices };
    for (const platform of ["windows", "linux"] as const) {
      expect(nativePromptButtons(prompt, platform)).toEqual({ ok: "Delete", cancel: "Cancel" });
    }
  });

  it.each(["windows", "macos", "linux"] satisfies ShortcutPlatform[])("fails closed on unexpected native results for every destructive prompt on %s", async (platform) => {
    for (const { choices } of destructivePrompts) {
      for (const result of ["Ok", "", "Yes"]) {
        plugin.message.mockResolvedValue(result);
        expect(await nativePrompt({ ...three, choices }, undefined, undefined, undefined, platform)).toBe("cancel");
      }
    }
  });

  it("labels the cancel choice Cancel whenever there is a choice, and a notice's button OK (Escape on macOS)", () => {
    // AppKit reaches only a button titled "Cancel" with Escape; any other cancel label stranded the box open.
    const loose = (choices: { id: string; label: string; cancel?: boolean }[]) =>
      ({ ...three, choices } as unknown as NativePromptOptions);
    expect(() => nativePromptButtons(loose([{ id: "resize", label: "Use A3" }, { id: "keep", label: "Keep Current Page", cancel: true }]))).toThrow(/Cancel/);
    expect(() => nativePromptButtons(loose([{ id: "install", label: "Install" }, { id: "no", label: "Not now", cancel: true }]))).toThrow(/Cancel/);
    expect(() => nativePromptButtons(loose([{ id: "install", label: "Install" }, { id: "ok", label: "OK", cancel: true }]))).toThrow(/Cancel/);
    expect(() => nativePromptButtons(loose([{ id: "close", label: "Close", cancel: true }]))).toThrow(/OK/);
    expect(() => nativePromptButtons(loose([{ id: "close", label: "Cancel", cancel: true }]))).toThrow(/OK/);
    // @ts-expect-error a cancel choice's label is "Cancel" or "OK" by type, too
    const typed: NativePromptOptions = { ...three, choices: [{ id: "close", label: "Close", cancel: true }] };
    expect(() => nativePromptButtons(typed)).toThrow();
  });

  it("rejects ambiguous or unsafe choice specifications", () => {
    for (const choices of [[], three.choices.slice(0, 1), [...three.choices, { id: "fourth", label: "Fourth" }],
      [{ id: "delete", label: "Cancel", cancel: true, destructive: true }],
      [{ id: "one", label: "Cancel", cancel: true }, { id: "two", label: "Cancel" }]]) {
      expect(() => nativePromptButtons({ ...three, choices } as NativePromptOptions)).toThrow();
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
});
