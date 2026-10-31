// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopShortcutRegistry } from "../keyboardShortcuts";
import { installPluginPanelInputFocus, panelEditableControl, type NativePanelFocusEvent } from "./pluginPanelInputFocus";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function mount(html: string, platform: ShortcutPlatform = "macos", ready = Promise.resolve()) {
  const shell = document.createElement("aside");
  shell.innerHTML = html;
  document.body.append(shell);
  const request = vi.fn(async (editing: boolean, _generation: number) => editing);
  const forward = vi.fn();
  const registry = createDesktopShortcutRegistry([
    { id: "edit.undo", title: "Undo", icon: "undo", shortcut: "CmdOrCtrl+Z" },
    { id: "edit.redo", title: "Redo", icon: "redo", shortcut: "CmdOrCtrl+Shift+Z" },
    { id: "edit.copy", title: "Copy", icon: "copy", shortcut: "CmdOrCtrl+C" },
    { id: "tool.bond", title: "Bond", icon: "undo", shortcut: "b" },
    { id: "tool.disabled", title: "Disabled", icon: "undo", shortcut: "d", enabled: false },
    { id: "view.rulers", title: "Rulers", icon: "undo", shortcut: "CmdOrCtrl+R" },
    { id: "document.closeTab", title: "Close", icon: "close", shortcut: "CmdOrCtrl+W" }
  ], platform);
  const listen = vi.spyOn(shell, "addEventListener");
  let notify!: (event: NativePanelFocusEvent) => void;
  const unsubscribe = vi.fn();
  cleanup = installPluginPanelInputFocus(shell, request, platform, async (listener) => {
    notify = listener;
    await ready;
    return unsubscribe;
  }, { resolve: (event) => registry.resolve(event), forward });
  const down = listen.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener;
  const key = listen.mock.calls.find(([type]) => type === "keydown")![1] as EventListener;
  return {
    shell, request, forward, unsubscribe,
    // jsdom cannot create trusted events. Call the installed handlers with real browser fields.
    press: (target: Element = shell, button = 0) => down({ target, button, isTrusted: true } as unknown as Event),
    key: (target: Element, value: string, modifiers: KeyboardEventInit = {}, handled = false) => {
      const event = new KeyboardEvent("keydown", { key: value, cancelable: true, ...modifiers });
      if (handled) event.preventDefault();
      key({
        target, key: event.key, isTrusted: true, isComposing: event.isComposing,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
        get defaultPrevented() { return event.defaultPrevented; },
        preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation()
      } as unknown as Event);
      return event;
    },
    native: (kind: NativePanelFocusEvent["kind"], generation = request.mock.calls.at(-1)?.[1] ?? 0) =>
      notify({ kind, generation })
  };
}

describe.each(["macos", "windows"] as const)("persistent panel focus (%s)", (platform) => {
  it.each([
    "<input>", "<textarea></textarea>", "<select><option>One</option></select>",
    "<button>Export</button>", "<h2>Title</h2>", "<canvas></canvas>", "<div>Empty space</div>",
    "<input readonly>", "<input disabled>", '<div contenteditable="true">Text</div>'
  ])("keeps focus after a click on %s", async (html) => {
    const { shell, press, request, native } = mount(html, platform);
    press(shell.firstElementChild!);
    await flush();
    shell.firstElementChild!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    shell.firstElementChild!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    native("activated");
    shell.append(document.createElement("p"));
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    press(shell);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    native("deactivated");
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, false]);
    press(shell);
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, false, true]);
  });

  it("does not take focus on mount, report/menu replacement, DOM focus, synthetic clicks or idle activation", async () => {
    const { shell, request, native } = mount("<input>", platform);
    shell.querySelector("input")!.focus();
    shell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    native("activated");
    shell.innerHTML = '<div role="menu" data-plugin-panel-input-menu="true"><button>PNG</button></div>';
    shell.querySelector("button")!.focus();
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([1, 2])("allows mouse button %s to retain native activation", async (button) => {
    const { shell, press, request } = mount("<p>Text</p>", platform);
    press(shell, button);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
  });

  it("keeps menu focus across hand-back-style DOM blur, menu closure and report updates", async () => {
    const { shell, press, request, native } = mount("<button>Export</button>", platform);
    press(shell.querySelector("button")!);
    await flush();
    shell.insertAdjacentHTML("beforeend", '<div role="menu" data-plugin-panel-input-menu="true"><button>PNG</button></div>');
    const item = shell.querySelector<HTMLElement>('[role="menu"] button')!;
    item.focus();
    item.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: shell }));
    item.blur();
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
    shell.querySelector('[role="menu"]')!.remove();
    shell.innerHTML = "<p>New result</p>";
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
    native("deactivated");
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it("keeps input Enter, Escape and Tab local without returning OS focus", async () => {
    const { shell, press, request } = mount('<input id="first"><button>Run</button><input id="last">', platform);
    const first = shell.querySelector<HTMLInputElement>("#first")!;
    const last = shell.querySelector<HTMLInputElement>("#last")!;
    const send = (target: HTMLElement, key: string) => target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true
    }));
    press(first); first.focus();
    await flush();
    send(first, "Tab");
    expect(document.activeElement).toBe(last);
    send(last, "Tab");
    expect(document.activeElement).not.toBe(last);
    first.focus();
    send(first, "Enter");
    expect(document.activeElement).not.toBe(first);
    first.focus();
    send(first, "Escape");
    expect(document.activeElement).not.toBe(first);
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
  });

  it("forwards undo, tools and platform redo once, without moving focus", async () => {
    const { shell, press, key, forward, request } = mount("<button>Action</button>", platform);
    const button = shell.querySelector("button")!;
    press(button);
    await flush();
    const primary = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    expect(key(button, "z", primary).defaultPrevented).toBe(true);
    expect(key(button, "b").defaultPrevented).toBe(true);
    expect(key(button, platform === "windows" ? "y" : "z",
      platform === "windows" ? primary : { ...primary, shiftKey: true }).defaultPrevented).toBe(true);
    expect(forward.mock.calls).toEqual([["edit.undo"], ["tool.bond"], ["edit.redo"]]);
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
  });

  it("leaves editing, IME, handled keys, disabled commands and open-menu keys local", async () => {
    const { shell, press, key, forward } = mount("<input><button>Action</button>", platform);
    const input = shell.querySelector("input")!;
    const button = shell.querySelector("button")!;
    press(input); input.focus();
    await flush();
    const primary = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    key(input, "z", primary);
    key(button, "b", { isComposing: true });
    key(button, "d");
    key(button, "b", {}, true);
    shell.insertAdjacentHTML("beforeend", '<div role="menu" data-plugin-panel-input-menu="true"><button>PNG</button></div>');
    key(button, "b");
    key(button, "Escape");
    expect(forward).not.toHaveBeenCalled();
  });

  it("preserves report selection copy and consumes its Escape without releasing focus", async () => {
    const { shell, press, key, request, forward } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    press(text);
    await flush();
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()!.addRange(range);
    expect(key(text, "c", platform === "macos" ? { metaKey: true } : { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.getSelection()!.toString()).toBe("Report text");
    expect(key(text, "Escape").defaultPrevented).toBe(true);
    expect(document.getSelection()!.toString()).toBe("");
    expect(forward).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
  });

  it("leaves window-close accelerators to the focused panel and never forwards document close", async () => {
    const { shell, press, key, forward, request } = mount("<button>Action</button>", platform);
    press(shell);
    await flush();
    const close = key(shell, platform === "macos" ? "w" : "F4",
      platform === "macos" ? { metaKey: true } : { altKey: true });
    expect(close.defaultPrevented).toBe(false);
    key(shell, "w", { ctrlKey: true });
    expect(forward).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
  });

  it("never forwards synthetic keyboard events", () => {
    const { shell, forward } = mount("<button>Action</button>", platform);
    shell.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    expect(forward).not.toHaveBeenCalled();
  });
});

it("subscribes before acquisition and cancels a queued request on native loss", async () => {
  let attach!: () => void;
  const { press, request, native } = mount("<button>Action</button>", "windows",
    new Promise<void>((resolve) => { attach = resolve; }));
  press();
  await flush();
  expect(request).not.toHaveBeenCalled();
  native("deactivated");
  attach();
  await flush();
  expect(request.mock.calls.map(([active]) => active)).toEqual([false]);
});

it("native loss wins over a late acquisition reply", async () => {
  const { press, request, native } = mount("<input>", "windows");
  let complete!: (active: boolean) => void;
  request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = resolve; }));
  press();
  await flush();
  native("deactivated");
  complete(true);
  await flush();
  expect(request.mock.calls.map(([active]) => active)).toEqual([true, false]);
});

it.each(["dropped", "error"])("allows another click to retry a %s acquisition without automatic retries", async (failure) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { press, request } = mount("<input>");
  if (failure === "dropped") request.mockResolvedValueOnce(false);
  else request.mockRejectedValueOnce(new Error("Focus unavailable"));
  press();
  await flush();
  expect(request).toHaveBeenCalledTimes(1);
  press();
  await flush();
  expect(request.mock.calls.map(([active]) => active)).toEqual([true, true]);
  expect(log).toHaveBeenCalledTimes(failure === "error" ? 1 : 0);
});

it("preserves multiline, IME and local button keys", async () => {
  const { shell, press, key, request, forward } = mount("<textarea></textarea><button>Action</button>");
  const textarea = shell.querySelector("textarea")!;
  press(textarea); textarea.focus();
  await flush();
  expect(key(textarea, "Enter").defaultPrevented).toBe(false);
  expect(key(textarea, "Escape", { isComposing: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(textarea);
  const button = shell.querySelector("button")!;
  for (const value of ["Enter", " ", "ArrowDown", "Tab"]) {
    expect(key(button, value).defaultPrevented).toBe(false);
  }
  expect(forward).not.toHaveBeenCalled();
  expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
});

it("keeps Tab in a portalled modal while retaining native panel focus at either end", async () => {
  const { shell, press, request } = mount('<input id="inline"><div aria-modal="true"><input id="first"><input id="last"></div>');
  const first = shell.querySelector<HTMLInputElement>("#first")!;
  const last = shell.querySelector<HTMLInputElement>("#last")!;
  press(first); first.focus();
  await flush();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).not.toBe(shell.querySelector("#inline"));
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(last);
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement).not.toBe(last);
  await flush();
  expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
});

it("ignores an older native event after a new click has acquired focus", async () => {
  const { press, request, native } = mount("<input>", "windows");
  press();
  await flush();
  const first = request.mock.calls[0][1];
  native("deactivated");
  await flush();
  press();
  await flush();
  native("deactivated", first);
  await flush();
  expect(request.mock.calls.map(([active]) => active)).toEqual([true, false, true]);
});

it("cleans up subscriptions and never takes focus after teardown", async () => {
  const { press, request, unsubscribe } = mount("<input>");
  press();
  cleanup!();
  cleanup = undefined;
  await flush();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([active]) => active)).toEqual([false]);
});

it("recognizes associated editable labels without treating fixed content as editable", () => {
  const { shell } = mount('<label for="field">Value</label><input id="field"><div contenteditable="false">Fixed</div>');
  expect(panelEditableControl(shell.querySelector("label"))).toBe(shell.querySelector("input"));
  expect(panelEditableControl(shell.querySelector("div"))).toBeUndefined();
});

it("forwards a registered Ctrl+R and suppresses unclaimed Windows browser reload chords", () => {
  const { shell, key, forward } = mount("<button>Action</button><input>", "windows");
  const button = shell.querySelector("button")!;
  expect(key(button, "r", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(forward.mock.calls).toEqual([["view.rulers"]]);
  expect(key(button, "F5").defaultPrevented).toBe(true);
  expect(key(shell.querySelector("input")!, "r", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(forward).toHaveBeenCalledTimes(1);
});
