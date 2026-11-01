// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopShortcutRegistry } from "../keyboardShortcuts";
import { installPaletteInputFocusLease, installPluginPanelInputFocus, listenPanelDeactivation, panelEditableControl, type NativePanelFocusEvent } from "./pluginPanelInputFocus";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.useRealTimers();
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
    { id: "edit.cut", title: "Cut", icon: "copy", shortcut: "CmdOrCtrl+X" },
    { id: "edit.paste", title: "Paste", icon: "copy", shortcut: "CmdOrCtrl+V" },
    { id: "edit.delete", title: "Delete", icon: "close", shortcut: "Delete" },
    { id: "edit.backspace", title: "Delete", icon: "close", shortcut: "Backspace" },
    { id: "edit.clear", title: "Clear", icon: "close", shortcut: "CmdOrCtrl+K" },
    { id: "edit.selectAll", title: "Select All", icon: "copy", shortcut: "CmdOrCtrl+A" },
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
      const event = new KeyboardEvent("keydown", {
        key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, cancelable: true, ...modifiers
      });
      if (handled) event.preventDefault();
      key({
        target, key: event.key, code: event.code, repeat: event.repeat, isTrusted: true, isComposing: event.isComposing,
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

function selectText(start: Element, end: Element = start): void {
  const range = document.createRange();
  range.setStart(start.firstChild!, 0);
  range.setEnd(end.firstChild!, end.textContent!.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe.each(["macos", "windows"] as const)("persistent panel focus (%s)", (platform) => {
  it.each([
    "<input>", "<textarea></textarea>", "<select><option>One</option></select>",
    "<button>Export</button>", "<h2>Title</h2>", "<canvas></canvas>", "<div>Empty space</div>",
    "<input readonly>", "<input disabled>", '<div contenteditable="true">Text</div>',
    '<input type="number">', '<div contenteditable="plaintext-only">Text</div>',
    '<div contenteditable><span>Nested text</span></div>'
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
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, true]);
    expect(request.mock.calls[1][1]).toBeGreaterThan(request.mock.calls[0][1]);
    native("deactivated");
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, true, false]);
    press(shell);
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, true, false, true]);
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

  it.each([
    ["Delete", {}], ["Backspace", {}], ["Delete", { shiftKey: true }],
    ["x", { primary: true }], ["v", { primary: true }],
    ["v", { primary: true, shiftKey: true }], ["Insert", { shiftKey: true }],
    ["k", { primary: true }], ["z", { primary: true }],
    ["b", {}], ["ArrowRight", {}], ["Enter", {}], ["Tab", {}]
  ] as const)("consumes selection-ending %s with %j before any document command", async (value, modifiers) => {
    const { shell, press, key, forward, request } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    press(text);
    await flush();
    selectText(text);
    const { primary, ...rest } = modifiers as KeyboardEventInit & { primary?: boolean };
    const event = key(text, value, { ...rest, ...(primary ? platform === "macos" ? { metaKey: true } : { ctrlKey: true } : {}) });
    expect(event.defaultPrevented).toBe(true);
    expect(document.getSelection()!.isCollapsed).toBe(true);
    expect(forward).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
    text.dispatchEvent(new KeyboardEvent("keyup", { code: event.code, bubbles: true }));
    expect(key(text, "b").defaultPrevented).toBe(true);
    expect(forward).toHaveBeenCalledExactlyOnceWith("tool.bond");
  });

  it.each([
    ["x", "KeyX", "edit.cut"], ["v", "KeyV", "edit.paste"], ["z", "KeyZ", "edit.undo"]
  ])("owns held %s until keyup after ending report selection", async (value, code, command) => {
    const { shell, press, key, forward } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    press(text);
    await flush();
    selectText(text);
    const modifiers = value.length === 1 ? platform === "macos" ? { metaKey: true } : { ctrlKey: true } : {};
    expect(key(text, value, { code, ...modifiers }).defaultPrevented).toBe(true);
    expect(document.getSelection()!.isCollapsed).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(key(text, value, { code, ...modifiers, repeat: true }).defaultPrevented).toBe(true);
    }
    // Modifier changes must not turn the same held physical key into a drawing shortcut.
    expect(key(text, value.toUpperCase(), { code, repeat: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(forward).not.toHaveBeenCalled();
    // The release can target a different element after focus changes within the panel.
    document.body.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
    expect(key(text, value, { code, ...modifiers }).defaultPrevented).toBe(true);
    expect(forward).toHaveBeenCalledExactlyOnceWith(command);
  });

  it.each(["Backspace", "Delete"])("never forwards %s after it clears selected table text (8.5)", async (value) => {
    const { shell, press, key, forward } = mount('<div class="plugin-report"><table><tbody><tr><td>Report text</td></tr></tbody></table></div>', platform);
    const text = shell.querySelector("td")!;
    press(text);
    await flush();
    selectText(text);
    expect(key(text, value).defaultPrevented).toBe(true);
    expect(document.getSelection()!.isCollapsed).toBe(true);
    // WebView2 can omit repeat or deliver keyup while the key is still held.
    for (const withKeyup of [false, true]) {
      for (const repeat of [true, false, true, false]) {
        if (withKeyup) text.dispatchEvent(new KeyboardEvent("keyup", { code: value, bubbles: true }));
        expect(key(text, value, { repeat }).defaultPrevented).toBe(true);
        expect(forward).not.toHaveBeenCalled();
      }
    }
    key(text, "z", platform === "macos" ? { metaKey: true } : { ctrlKey: true });
    key(text, "b");
    expect(forward.mock.calls).toEqual([["edit.undo"], ["tool.bond"]]);
  });

  it.each(["Backspace", "Delete"])("excludes bare and modified %s without selection while leaving input editing native", async (value) => {
    const { shell, press, key, forward } = mount('<input value="Text"><div class="plugin-report"><p>Report text</p></div>', platform);
    const input = shell.querySelector("input")!;
    const text = shell.querySelector("p")!;
    press(text);
    await flush();
    for (let mask = 0; mask < 16; mask++) {
      const modifiers = { ctrlKey: !!(mask & 1), metaKey: !!(mask & 2), shiftKey: !!(mask & 4), altKey: !!(mask & 8) };
      expect(key(text, value, modifiers).defaultPrevented).toBe(true);
    }
    // No keyup: a panel deletion must not reserve the key when an input gains focus.
    press(input); input.focus();
    await flush();
    for (const repeat of [false, true]) {
      // jsdom has no native editing default; uncancelled keydowns let the browser edit.
      expect(key(input, value, { repeat }).defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(input);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["native deactivation", "window blur", "page hide", "page unload", "hidden page"])("releases consumed keys on %s before keyup", async (loss) => {
    const { shell, press, key, forward, native } = mount('<input><div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    const input = shell.querySelector("input")!;
    press(text);
    await flush();
    for (const value of ["Delete", "b"]) {
      selectText(text);
      expect(key(text, value).defaultPrevented).toBe(true);
      expect(key(text, value, { repeat: true }).defaultPrevented).toBe(true);
    }
    expect(forward).not.toHaveBeenCalled();
    if (loss === "native deactivation") native("deactivated");
    else if (loss === "hidden page") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    } else window.dispatchEvent(new Event(loss === "window blur" ? "blur" : loss === "page hide" ? "pagehide" : "unload"));
    await flush();
    // The held keys were released elsewhere, so no keyup reaches this panel.
    if (loss === "hidden page") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    }
    native("activated");
    press(text);
    await flush();
    expect(document.getSelection()!.isCollapsed).toBe(true);
    expect(key(text, "Delete").defaultPrevented).toBe(true);
    expect(key(text, "Delete", { repeat: true }).defaultPrevented).toBe(true);
    key(text, "b");
    expect(forward.mock.calls).toEqual([["tool.bond"]]);
    press(input); input.focus();
    await flush();
    for (const value of ["Delete", "b"]) {
      expect(key(input, value).defaultPrevented).toBe(false);
      expect(key(input, value, { repeat: true }).defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(input);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["F5", {}], ["F5", { ctrlKey: true }], ["BrowserRefresh", {}],
    ["r", { ctrlKey: true }], ["R", { ctrlKey: true, shiftKey: true }],
    ["r", { metaKey: true }], ["R", { metaKey: true, shiftKey: true }]
  ] as const)("suppresses selected-report reload %s with %j before selection branches", (value, modifiers) => {
    const { shell, key, forward } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    selectText(text);
    expect(key(text, value, modifiers).defaultPrevented).toBe(true);
    expect(document.getSelection()!.toString()).toBe("Report text");
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["drag", "double", "triple"])("preserves browser-created report selection after a %s click gesture", async (gesture) => {
    const { shell, press, key, forward, request } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    const count = gesture === "double" ? 2 : gesture === "triple" ? 3 : 1;
    for (let i = 1; i <= count; i++) {
      press(text);
      // jsdom has no text-selection default action; supply the range the browser creates.
      if (i === count) selectText(text);
      for (const type of gesture === "drag" ? ["pointermove", "pointerup", "click"] : ["pointerup", "click"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail: i });
        text.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      await flush();
    }
    shell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    expect(key(text, "c", platform === "macos" ? { metaKey: true } : { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.getSelection()!.toString()).toBe("Report text");
    expect(forward).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([active]) => active)).toBe(true);
  });

  it("keeps Copy, Select All, Shift extension and modifier keys in the report", () => {
    const { shell, key, forward } = mount('<div class="plugin-report"><p>Report text</p><p>More text</p></div>', platform);
    const [first, last] = shell.querySelectorAll("p");
    selectText(first);
    for (const value of ["c", "C", "a", "A"]) {
      expect(key(first, value, platform === "macos" ? { metaKey: true } : { ctrlKey: true }).defaultPrevented).toBe(false);
    }
    for (const value of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
      expect(key(first, value, { shiftKey: true }).defaultPrevented).toBe(false);
    }
    for (const value of ["Shift", "Control", "Alt", "Meta", "AltGraph"]) {
      expect(key(first, value).defaultPrevented).toBe(false);
    }
    expect(document.getSelection()!.toString()).toBe("Report text");
    selectText(first, last); // Browser default after Select All / Shift extension.
    expect(key(last, "c", platform === "macos" ? { metaKey: true } : { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.getSelection()!.toString()).toBe("Report textMore text");
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["collapsed", "outside", "control", "cross boundary"])("checks report selection boundaries: %s", (boundary) => {
    const { shell, key, forward } = mount('<h2>Heading</h2><div class="plugin-report"><p>Report text</p><button>Action</button></div>', platform);
    const text = shell.querySelector("p")!;
    const heading = shell.querySelector("h2")!;
    if (boundary === "outside") selectText(heading);
    else if (boundary === "control") selectText(shell.querySelector("button")!);
    else if (boundary === "cross boundary") selectText(heading, text);
    else { selectText(text); document.getSelection()!.collapseToEnd(); }
    expect(key(text, "b").defaultPrevented).toBe(true);
    if (boundary === "control" || boundary === "cross boundary") {
      expect(document.getSelection()!.isCollapsed).toBe(true);
      expect(forward).not.toHaveBeenCalled();
    } else expect(forward).toHaveBeenCalledExactlyOnceWith("tool.bond");
  });

  it.each([
    '<input type="number">', '<div contenteditable="plaintext-only">Text</div>',
    '<div contenteditable><span>Nested text</span></div>'
  ])("keeps arrows and editing local in %s", async (html) => {
    const { shell, press, key, request, forward } = mount(html, platform);
    const control = shell.firstElementChild as HTMLElement;
    const target = control.querySelector("span") ?? control;
    expect(panelEditableControl(target.firstChild ?? target)).toBe(control);
    press(target); control.focus();
    await flush();
    for (const value of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(key(target, value).defaultPrevented).toBe(false);
    }
    expect(key(target, "z", platform === "macos" ? { metaKey: true } : { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(control);
    expect(forward).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
  });

  it.each(["Enter", "Escape"])("runs input commit handlers on %s while keeping Escape from panel close", async (value) => {
    const { shell, press, request, forward } = mount("<input>", platform);
    const input = shell.querySelector("input")!;
    press(input); input.focus();
    await flush();
    const commit = vi.fn();
    const outerKey = vi.fn();
    input.addEventListener("keydown", commit);
    window.addEventListener("keydown", outerKey);
    try {
      const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(commit).toHaveBeenCalledOnce();
      expect(document.activeElement).not.toBe(input);
      expect(outerKey).toHaveBeenCalledTimes(value === "Escape" ? 0 : 1);
      expect(event.defaultPrevented).toBe(value === "Escape");
      expect(forward).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([active]) => active)).toEqual([true]);
    } finally {
      window.removeEventListener("keydown", outerKey);
    }
  });

  it.each(["before request", "during request", "after reply"])("rejects the previous activation's loss after a new click (%s)", async (timing) => {
    const { shell, press, request, native } = mount('<input><div class="plugin-report"><p>Report text</p></div>', platform);
    const input = shell.querySelector("input")!;
    const text = shell.querySelector("p")!;
    press(input); input.focus();
    await flush();
    const previous = request.mock.calls[0][1];
    window.dispatchEvent(new Event("blur"));
    native("activated", previous);
    let complete!: (active: boolean) => void;
    if (timing === "during request") request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    press(input); input.focus(); selectText(text);
    if (timing !== "before request") await flush();
    native("deactivated", previous);
    expect(document.activeElement).toBe(input);
    expect(document.getSelection()!.toString()).toBe("Report text");
    if (timing === "during request") complete(true);
    await flush();
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, true]);
    native("deactivated");
    await flush();
    expect(document.activeElement).not.toBe(input);
    expect(document.getSelection()!.isCollapsed).toBe(true);
    expect(request.mock.calls.map(([active]) => active)).toEqual([true, true, false]);
  });

  it("ends the current interaction if native loss precedes the new acquisition request", async () => {
    const { shell, press, request, native } = mount('<input><div class="plugin-report"><p>Report text</p></div>', platform);
    const input = shell.querySelector("input")!;
    press(input); input.focus();
    await flush();
    const previous = request.mock.calls[0][1];
    const lost = vi.fn();
    const stop = listenPanelDeactivation(lost);
    try {
      request.mockResolvedValueOnce(false); // Native refuses to focus a panel that is no longer active.
      press(input); input.focus(); selectText(shell.querySelector("p")!);
      native("deactivated", previous);
      expect(lost).not.toHaveBeenCalled();
      await flush();
      expect(document.activeElement).not.toBe(input);
      expect(document.getSelection()!.isCollapsed).toBe(true);
      expect(lost).toHaveBeenCalledOnce();
      expect(request.mock.calls.map(([active]) => active)).toEqual([true, true]);
    } finally {
      stop();
    }
  });

  it.each([true, false])("rejects generation-0 loss after two clicks while subscribing (acquired: %s)", async (acquired) => {
    let attach!: () => void;
    const { shell, press, request, native } = mount('<input><div class="plugin-report"><p>Report text</p></div>', platform,
      new Promise<void>((resolve) => { attach = resolve; }));
    const input = shell.querySelector("input")!;
    const lost = vi.fn();
    const stop = listenPanelDeactivation(lost);
    try {
      request.mockResolvedValueOnce(acquired);
      press(input); input.focus();
      await flush();
      press(input); input.focus(); selectText(shell.querySelector("p")!);
      native("deactivated", 0);
      expect(request).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(document.getSelection()!.toString()).toBe("Report text");
      expect(lost).not.toHaveBeenCalled();
      attach();
      await flush();
      expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
      if (acquired) {
        expect(document.activeElement).toBe(input);
        expect(document.getSelection()!.toString()).toBe("Report text");
        expect(lost).not.toHaveBeenCalled();
        native("deactivated");
        await flush();
        expect(request.mock.calls.map(([active]) => active)).toEqual([true, false]);
      }
      expect(document.activeElement).not.toBe(input);
      expect(document.getSelection()!.isCollapsed).toBe(true);
      expect(lost).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
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

const pointerHandlers = new WeakMap<HTMLElement, EventListener>();
const keyHandlers = new WeakMap<HTMLElement, EventListener>();
const selectionHandlers = new WeakMap<HTMLElement, { up: EventListener; click: EventListener }>();
function mountPalette(html: string, platform: ShortcutPlatform = "macos", ready: Promise<void> = Promise.resolve(), _palette = true) {
  const shell = document.createElement("aside");
  shell.innerHTML = html;
  document.body.append(shell);
  const request = vi.fn(async (editing: boolean, _generation: number): Promise<boolean> => editing);
  const listen = vi.spyOn(shell, "addEventListener");
  const listenWindow = vi.spyOn(window, "addEventListener");
  let notify!: (event: NativePanelFocusEvent) => void;
  const unsubscribe = vi.fn();
  cleanup = installPaletteInputFocusLease(shell, request, platform, async (listener) => {
    notify = listener;
    await ready;
    return unsubscribe;
  });
  pointerHandlers.set(shell, listen.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener);
  keyHandlers.set(shell, listenWindow.mock.calls.find(([type]) => type === "keydown")![1] as EventListener);
  selectionHandlers.set(shell, {
    up: listenWindow.mock.calls.filter(([type]) => type === "pointerup").at(-1)?.[1] as EventListener,
    click: listen.mock.calls.find(([type]) => type === "click")?.[1] as EventListener
  });
  return { shell, request, activate: () => notify({ kind: "activated", generation: 0 }),
    deactivate: (generation = request.mock.calls.filter(([editing]) => editing).at(-1)?.[1] ?? 0,
      reason?: NativePanelFocusEvent["reason"]) => notify({ kind: "deactivated", generation, reason }), unsubscribe };
}

function pointerDown(target: Element): void {
  // jsdom cannot produce trusted pointer events. Exercise the installed handler with the browser
  // fields explicitly; the separate synthetic-event regression uses real dispatchEvent below.
  const shell = target.closest("aside")!;
  pointerHandlers.get(shell)!({ target, button: 0, isTrusted: true, pointerId: 1, clientX: 10, clientY: 10 } as unknown as Event);
}

function pointerUp(target: Element, dragged = true, isTrusted = true): void {
  selectionHandlers.get(target.closest("aside")!)!.up?.({
    target, button: 0, isTrusted, pointerId: 1, clientX: dragged ? 50 : 10, clientY: 10
  } as unknown as Event);
}

function click(target: Element, detail = 1): void {
  selectionHandlers.get(target.closest("aside")!)!.click({ target, isTrusted: true, detail } as unknown as Event);
}

function key(target: Element, value: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe.each(["macos", "windows"] as const)("palette control focus settling (%s)", (platform) => {
  it.each(["before native loss", "after native loss"])("retains a pointer-opened macOS select through popup blur %s, Escape and typing", async blurOrder => {
    if (platform !== "macos") return;
    vi.useFakeTimers();
    const { shell, request, deactivate } = mountPalette('<select><option>14 pt</option><option>18 pt</option></select>', platform, Promise.resolve(), true);
    const select = shell.querySelector("select")!;
    pointerDown(select); select.focus(); await flush();
    pointerUp(select, false); click(select);
    await vi.runAllTimersAsync();
    if (blurOrder === "before native loss") select.blur();
    deactivate(); // Exact chemdraft://plugin-panel-focus event listened to by the lease.
    if (blurOrder === "after native loss") select.blur();
    await vi.runAllTimersAsync(); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    expect(shell.dataset.paletteInputFocus).toBe("held");
    key(document.body, "Escape"); // WebKit may target body while closing the list.
    await flush();
    expect(document.activeElement).toBe(select);
    expect(shell.dataset.paletteInputFocus).toBe("held");
    const delivered: string[] = [];
    select.addEventListener("keydown", event => { delivered.push(event.key); });
    for (const value of ["1", "8", "ArrowDown"]) {
      expect(key(document.activeElement!, value).defaultPrevented).toBe(false);
    }
    expect(delivered).toEqual(["1", "8", "ArrowDown"]);
    expect(request.mock.calls.every(([editing]) => editing)).toBe(true);
    key(select, "Escape"); await flush();
    expect(shell.dataset.paletteInputFocus).toBeUndefined();
    expect(request.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it.each(["app", "outside"] as const)("ends a macOS select popup lease on real %s loss, even after window-key loss", async reason => {
    if (platform !== "macos") return;
    const { shell, request, deactivate, activate } = mountPalette('<select><option>14 pt</option></select>', platform, Promise.resolve(), true);
    const select = shell.querySelector("select")!;
    pointerDown(select); select.focus(); await flush();
    deactivate(); await flush();
    deactivate(undefined, reason); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    activate(); await flush();
    expect(shell.dataset.paletteInputFocus).toBeUndefined();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["pointer", "Space", "Alt+Down"])("keeps select keys after dismissing a list opened by %s, then hands back on the next Escape", async (opening) => {
    const { shell, request } = mountPalette('<input><select><option value="14">14 pt</option><option value="18">18 pt</option></select>', platform, Promise.resolve(), true);
    const select = shell.querySelector("select")!;
    const input = shell.querySelector("input")!;
    pointerDown(opening === "pointer" ? select : input);
    (opening === "pointer" ? select : input).focus();
    await flush();
    pointerUp(opening === "pointer" ? select : input, false);
    click(opening === "pointer" ? select : input);
    if (opening !== "pointer") {
      select.focus(); // Tab's browser default.
      select.dispatchEvent(new KeyboardEvent("keydown", { key: opening === "Space" ? " " : "ArrowDown",
        altKey: opening === "Alt+Down", bubbles: true, cancelable: true }));
    }
    // WebKit bubbles the NSMenu dismissal Escape. WebView2 consumes that key in
    // its popup: model that native boundary with an event that does not bubble.
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: platform === "macos", cancelable: true }));
    await flush();
    const acquisitions = platform === "macos" && opening !== "pointer" ? [true, true] : [true];
    expect(request.mock.calls.map(([editing]) => editing)).toEqual(acquisitions);
    expect(document.activeElement).toBe(select);
    for (const value of ["1", "8", "ArrowDown"]) expect(key(select, value).defaultPrevented).toBe(false);
    expect(shell.dataset.paletteInputFocus).toBe("held");
    key(select, "Escape");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([...acquisitions, false]);
    expect(document.activeElement).not.toBe(select);
  });

  it("does not retain a popup-dismissal Escape after a completed select pick", async () => {
    const { shell, request } = mountPalette('<select><option>14 pt</option><option>18 pt</option></select>', platform, Promise.resolve(), true);
    const select = shell.querySelector("select")!;
    pointerDown(select); select.focus();
    await flush();
    select.selectedIndex = 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    key(select, "Escape");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it("keeps the lease for Tab to another control, then ends it when Tab leaves the palette", async () => {
    vi.useFakeTimers();
    const { shell, request } = mountPalette('<input><select><option>One</option></select>', platform, Promise.resolve(), true);
    const input = shell.querySelector("input")!;
    const select = shell.querySelector("select")!;
    pointerDown(input); input.focus();
    await flush();
    expect(key(input, "Tab").defaultPrevented).toBe(false);
    select.focus(); // Browser Tab default (jsdom does not traverse).
    await vi.runAllTimersAsync();
    await flush();
    const acquisitions = platform === "macos" ? [true, true] : [true];
    expect(request.mock.calls.map(([editing]) => editing)).toEqual(acquisitions);
    expect(key(select, "Tab").defaultPrevented).toBe(false);
    select.blur(); // No destination remains inside this palette.
    await vi.runAllTimersAsync();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([...acquisitions, false]);
  });

  it.each(["color", "select"])("preserves a %s chooser through native loss and accepts its later change", async (kind) => {
    const { shell, request, deactivate } = mountPalette(kind === "color"
      ? '<input type="color" value="#112233">'
      : '<select><option value="one">One</option><option value="two">Two</option></select>',
    platform, Promise.resolve(), true);
    const control = shell.firstElementChild as HTMLInputElement | HTMLSelectElement;
    const blur = vi.spyOn(control, "blur");
    const commits = vi.fn();
    control.addEventListener("change", () => commits(control.value));
    pointerDown(control);
    control.focus();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    deactivate(); // The native chooser can be the window that took keyboard focus.
    await flush();
    const keepsSelect = platform === "macos" && kind === "select";
    expect(request.mock.calls.map(([editing]) => editing)).toEqual(keepsSelect ? [true] : [true, false]);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(control);
    control.value = kind === "color" ? "#abcdef" : "two";
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(commits).toHaveBeenCalledExactlyOnceWith(kind === "color" ? "#abcdef" : "two");
    expect(request.mock.calls.map(([editing]) => editing)).toEqual(keepsSelect ? [true, true] : [true, false]);
  });

  it("still blurs text entry when native focus is lost", async () => {
    const { shell, request, deactivate } = mountPalette('<input type="text">', platform, Promise.resolve(), true);
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    const blur = vi.spyOn(input, "blur");
    deactivate();
    await flush();
    expect(blur).toHaveBeenCalledExactlyOnceWith();
    expect(document.activeElement).not.toBe(input);
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it("restores a non-text click default that blurs after the native reply", async () => {
    vi.useFakeTimers();
    const { shell, request } = mountPalette('<input type="range">', platform, Promise.resolve(), true);
    const range = shell.querySelector("input")!;
    let settle!: (acquired: boolean) => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    pointerDown(range);
    await flush();
    pointerUp(range, false);
    click(range);
    settle(true);
    await flush(); // Native reply runs between click capture and the browser's final default.
    range.blur();
    await vi.runAllTimersAsync();
    await flush();
    expect(document.activeElement).toBe(range);
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
  });

  it("does not blur a colour control while its native lease reply is pending", async () => {
    const { shell, request } = mountPalette('<input type="color">', platform, Promise.resolve(), true);
    const color = shell.querySelector("input")!;
    const blur = vi.spyOn(color, "blur");
    let settle!: (acquired: boolean) => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    pointerDown(color);
    color.focus(); // The native picker needs its launching control to keep DOM focus.
    await flush();
    expect(document.activeElement).toBe(color);
    expect(blur).not.toHaveBeenCalled();
    pointerUp(color, false);
    click(color);
    settle(true);
    await flush();
    expect(document.activeElement).toBe(color);
    expect(blur).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
  });

  it.each(["same", "another"])("keeps the lease when null-relatedTarget blur returns to %s palette control", async (destination) => {
    vi.useFakeTimers();
    const { shell, request } = mountPalette('<input type="number"><select><option>One</option></select>', platform, Promise.resolve(), true);
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    expect(document.activeElement).toBe(input);
    input.blur(); // WebView2 focusout(null), then focusin: no reliable destination until settled.
    const next = destination === "same" ? input : shell.querySelector("select")!;
    next.focus();
    await vi.runAllTimersAsync();
    await flush();
    const acquisitions = platform === "macos" && destination === "another" ? [true, true] : [true];
    expect(request.mock.calls.map(([editing]) => editing)).toEqual(acquisitions);
    expect(document.activeElement).toBe(next);
    next.blur();
    await vi.runAllTimersAsync();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([...acquisitions, false]);
  });

  it("releases when focus settles outside controls, including a command button", async () => {
    vi.useFakeTimers();
    const { shell, request } = mountPalette('<input><button>Run</button>', platform, Promise.resolve(), true);
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    input.blur();
    shell.querySelector("button")!.focus();
    await vi.runAllTimersAsync();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["checkbox", "range", "color", "date", "radio", "file"])("requires trusted pointer intent for a %s and keeps Enter local", async (type) => {
    const { shell, request } = mountPalette(`<input type="${type}">`, platform, Promise.resolve(), true);
    const input = shell.querySelector("input")!;
    input.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
    input.focus();
    await flush();
    expect(request).not.toHaveBeenCalled();
    pointerDown(input);
    await flush();
    key(input, "Enter");
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    expect(document.activeElement).not.toBe(input);
  });

  it.each(["button", "submit", "reset", "image", "hidden"])("never leases a button-like/hidden input (%s), even through a label", async (type) => {
    const { shell, request } = mountPalette(`<label>Action<input type="${type}"></label><button>Command</button>`, platform, Promise.resolve(), true);
    for (const target of shell.querySelectorAll<HTMLElement>("label, input, button")) {
      pointerDown(target);
      target.focus();
      pointerUp(target, false);
      click(target);
    }
    await flush();
    expect(request.mock.calls.filter(([editing]) => editing)).toEqual([]);
  });

  it("leases the actual range inside a label shared with its number box", async () => {
    const { shell, request } = mountPalette('<label>Length<input type="number"><input type="range"></label>', platform, Promise.resolve(), true);
    const range = shell.querySelector<HTMLInputElement>('input[type="range"]')!;
    pointerDown(range);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.activeElement).toBe(range);
  });
});

// The #244 generation regressions also exercise the palette installer after the panel split.
describe("palette lease generations", () => {
  it("attaches the native listener before requesting a lease", async () => {
    let attach!: () => void;
    const ready = new Promise<void>((resolve) => { attach = resolve; });
    const { shell, request, deactivate } = mountPalette("<input>", "windows", ready);
    pointerDown(shell.querySelector("input")!);
    await flush();
    expect(request).not.toHaveBeenCalled();
    attach();
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    deactivate();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["macos", "windows"] as const)("cancels queued retries when the outstanding lease deactivates (%s)", async (platform) => {
    const { shell, request, deactivate } = mountPalette("<input>", platform);
    let complete!: (acquired: boolean) => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    pointerDown(input);
    deactivate(request.mock.calls[0]![1]);
    complete(true); // Even a stale successful reply cannot revive the queued click.
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    expect(document.activeElement).not.toBe(input);
    pointerDown(input);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false, true]);
  });

  it.each(["false", "error"])("cancels queued retries when the outstanding acquisition returns %s", async (outcome) => {
    const { shell, request } = mountPalette("<input>", "windows");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let complete!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve, reject) => {
      complete = () => outcome === "false" ? resolve(false) : reject(new Error("Focus failed"));
    }));
    const input = shell.querySelector("input")!;
    pointerDown(input);
    await flush();
    pointerDown(input);
    complete();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });


  it.each(["macos", "windows"] as const)("native loss during palette acquisition survives a late successful reply (%s)", async platform => {
    const { shell, request, deactivate, activate } = mountPalette("<input>", platform);
    const input = shell.querySelector("input")!;
    let complete!: (value: boolean) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    pointerDown(input); input.focus(); await flush();
    deactivate();
    activate();
    complete(true); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    expect(document.activeElement).not.toBe(input);
  });

  // A macOS select transition renews a live palette generation. Ordinary repeated
  // clicks deliberately reuse the lease on both hosts, so they cannot create a retry.
  it("ends a pending retry on loss of its predecessor's native generation", async () => {
    const { shell, request, deactivate } = mountPalette('<input><select><option>One</option></select>', "macos");
    pointerDown(shell.querySelector("input")!); await flush();
    const old = request.mock.calls[0]![1];
    let complete!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>(resolve => { complete = () => resolve(true); }));
    pointerDown(shell.querySelector("select")!); await flush();
    deactivate(old, "outside");
    complete(); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true, false]);
  });

  it("ignores native deactivation tagged with an older settled lease generation", async () => {
    const { shell, request, deactivate } = mountPalette('<input><select><option>One</option></select>', "macos");
    pointerDown(shell.querySelector("input")!); await flush();
    const old = request.mock.calls[0]![1];
    pointerDown(shell.querySelector("select")!); await flush();
    deactivate(old, "outside"); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true]);
    deactivate(undefined, "outside"); await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true, false]);
  });
});
