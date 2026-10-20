// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPluginPanelInputFocus, panelEditableControl, type NativePanelFocusEvent } from "./pluginPanelInputFocus";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

let cleanup: (() => void) | undefined;
const pointerHandlers = new WeakMap<HTMLElement, EventListener>();
const keyHandlers = new WeakMap<HTMLElement, EventListener>();
const selectionHandlers = new WeakMap<HTMLElement, { up: EventListener; click: EventListener }>();
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function mount(html: string, platform: ShortcutPlatform = "macos", ready: Promise<void> = Promise.resolve()) {
  const shell = document.createElement("aside");
  shell.innerHTML = html;
  document.body.append(shell);
  const request = vi.fn(async (editing: boolean, _generation: number): Promise<boolean> => editing);
  const listen = vi.spyOn(shell, "addEventListener");
  const listenWindow = vi.spyOn(window, "addEventListener");
  let notify!: (event: NativePanelFocusEvent) => void;
  const unsubscribe = vi.fn();
  cleanup = installPluginPanelInputFocus(shell, request, platform, async (listener) => {
    notify = listener;
    await ready;
    return unsubscribe;
  });
  pointerHandlers.set(shell, listen.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener);
  keyHandlers.set(shell, listen.mock.calls.find(([type]) => type === "keydown")![1] as EventListener);
  selectionHandlers.set(shell, {
    up: listenWindow.mock.calls.filter(([type]) => type === "pointerup").at(-1)?.[1] as EventListener,
    click: listen.mock.calls.find(([type]) => type === "click")?.[1] as EventListener
  });
  return { shell, request, activate: () => notify({ kind: "activated", generation: 0 }),
    deactivate: (generation = request.mock.calls.filter(([editing]) => editing).at(-1)?.[1] ?? 0) =>
      notify({ kind: "deactivated", generation }), unsubscribe };
}

function pointerDown(target: Element): void {
  // jsdom cannot produce trusted pointer events. Exercise the installed handler with the browser
  // fields explicitly; the separate synthetic-event regression uses real dispatchEvent below.
  const shell = target.closest("aside")!;
  pointerHandlers.get(shell)!({ target, button: 0, isTrusted: true, pointerId: 1, clientX: 10, clientY: 10 } as unknown as Event);
}

function selectText(target: Element, end = target): void {
  const range = document.createRange();
  range.setStart(target.firstChild!, 0);
  range.setEnd(end.firstChild!, end.textContent!.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
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

function trustedKey(target: Element, value: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, cancelable: true, ...modifiers });
  // jsdom cannot dispatch trusted keyboard events; call the installed handler as for pointers.
  keyHandlers.get(target.closest("aside")!)!({
    target, key: event.key, isTrusted: true, isComposing: event.isComposing,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
    get defaultPrevented() { return event.defaultPrevented; },
    preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation()
  } as unknown as Event);
  return event;
}

describe("panel input keyboard focus", () => {
  it("attaches the native listener before requesting a lease", async () => {
    let attach!: () => void;
    const ready = new Promise<void>((resolve) => { attach = resolve; });
    const { shell, request, deactivate } = mount("<input>", "windows", ready);
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

  it.each(["macos", "windows"] as const)("hands non-lease clicks back only on Windows (%s)", async (platform) => {
    const { shell, request } = mount('<h2>Heading</h2><div class="plugin-report"><table><tbody><tr><td>Value</td></tr></tbody></table><p></p></div><button>Run</button><canvas></canvas>', platform);
    for (const target of shell.querySelectorAll("h2, td, p, button, canvas")) {
      request.mockClear();
      const action = vi.fn();
      target.addEventListener("click", action);
      pointerDown(target);
      await flush();
      expect(request).not.toHaveBeenCalled();
      pointerUp(target, false);
      click(target);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(action).toHaveBeenCalledOnce();
      expect(request.mock.calls.map(([editing]) => editing)).toEqual(platform === "windows" ? [false] : []);
    }
  });

  it.each(["input", "select", "drag", "double", "triple"])("Windows %s leases suppress pointer hand-back until Escape", async (kind) => {
    const { shell, request } = mount('<input><select><option>One</option></select><div class="plugin-report"><p>Report text</p></div>', "windows");
    const target = shell.querySelector(kind === "input" || kind === "select" ? kind : "p")!;
    pointerDown(target);
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) target.focus();
    await flush();
    if (kind === "drag" || kind === "double" || kind === "triple") selectText(target);
    pointerUp(target, kind === "drag");
    // Include an IPC turn between up and click: a double/triple selection must not queue a
    // false request whose delayed native blur would cancel its about-to-start lease.
    await flush();
    if (kind === "double" || kind === "triple") expect(request).not.toHaveBeenCalled();
    click(target, kind === "double" ? 2 : kind === "triple" ? 3 : 1);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    key(target, "Escape");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["input", "select", "drag", "double", "triple"])(
    "preserves a Windows %s lease through its own asynchronous activation blur/focus", async (kind) => {
      vi.useFakeTimers();
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const { shell, request, activate, deactivate } = mount('<input><select><option>One</option></select><div class="plugin-report"><p>Report text</p></div>', "windows");
      let complete!: () => void;
      request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = () => resolve(true); }));
      const input = kind === "input" || kind === "select";
      const target = shell.querySelector<HTMLElement>(input ? kind : "p")!;
      pointerDown(target);
      if (input) target.focus();
      else selectText(target);
      pointerUp(target, kind === "drag");
      click(target, kind === "double" ? 2 : kind === "triple" ? 3 : 1);
      await flush();
      expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
      // SetActiveWindow and WebView2 set_focus can produce native activation, DOM
      // focusout and window blur before the acquisition IPC has replied.
      activate();
      if (input) target.blur();
      hasFocus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(64);
      expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
      complete();
      await flush();
      await vi.advanceTimersByTimeAsync(4);
      hasFocus.mockReturnValue(true);
      if (input) target.focus();
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(64);
      expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
      if (input) expect(document.activeElement).toBe(target);
      else {
        expect(document.getSelection()?.toString()).toBe("Report text");
        const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
        target.dispatchEvent(copy);
        expect(copy.defaultPrevented).toBe(false);
      }
      // Only a native top-level loss is a lease boundary.
      hasFocus.mockReturnValue(false);
      deactivate();
      await flush();
      expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
      if (!input) expect(document.getSelection()?.toString()).toBe("");
    });

  it.each(["macos", "windows"] as const)("native loss during acquisition survives a late successful reply (%s)", async (platform) => {
    const { shell, request, deactivate, activate } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    let complete!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = () => resolve(true); }));
    const text = shell.querySelector("p")!;
    pointerDown(text); selectText(text); pointerUp(text); click(text);
    await flush();
    // Sol's P1: click document while the acquisition reply is pending, then delayed
    // native focus makes hasFocus true again. The native loss must remain terminal.
    deactivate();
    expect(document.getSelection()?.toString()).toBe("");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    activate();
    window.dispatchEvent(new Event("focus"));
    complete();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it("preserves selection through activation blur lasting longer than 32 ms after completion", async () => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div>', "windows");
    const text = shell.querySelector("p")!;
    pointerDown(text); selectText(text); pointerUp(text); click(text);
    await flush();
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(1000);
    hasFocus.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(32);
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.getSelection()?.toString()).toBe("Report text");
  });

  it("hands idle native Windows activation back without DOM focus evidence", async () => {
    vi.useFakeTimers();
    const { request, activate } = mount("<button>Run</button>", "windows");
    activate();
    await vi.advanceTimersByTimeAsync(32);
    expect(request).toHaveBeenCalledExactlyOnceWith(false, expect.any(Number));
  });

  it.each(["pending", "active"])("does not redirect Windows activation during a %s lease", async (timing) => {
    vi.useFakeTimers();
    const { shell, request, activate } = mount("<input>", "windows");
    let complete!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = () => resolve(true); }));
    activate(); // Delivered before the trusted input pointerdown.
    pointerDown(shell.querySelector("input")!);
    shell.querySelector("input")!.focus();
    await flush();
    if (timing === "active") { complete(); await flush(); }
    activate();
    await vi.advanceTimersByTimeAsync(64);
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    complete();
  });

  it("does not redirect native activation during a report drag and cancels timers on teardown", async () => {
    vi.useFakeTimers();
    const { shell, request, activate, unsubscribe } = mount('<div class="plugin-report"><p>Report text</p></div>', "windows");
    const text = shell.querySelector("p")!;
    activate();
    pointerDown(text);
    await vi.advanceTimersByTimeAsync(64);
    expect(request).not.toHaveBeenCalled();
    selectText(text); pointerUp(text); click(text);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    key(text, "Escape");
    await flush();
    request.mockClear();
    activate();
    cleanup!(); cleanup = undefined;
    await vi.advanceTimersByTimeAsync(64);
    expect(request).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not interrupt Windows chart drags, hover, wheel or synthetic clicks", async () => {
    const { shell, request } = mount("<canvas></canvas>", "windows");
    const chart = shell.querySelector("canvas")!;
    pointerDown(chart);
    for (const type of ["pointermove", "wheel", "pointerup", "click"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      chart.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    await flush();
    expect(request).not.toHaveBeenCalled();
    pointerUp(chart);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(false, expect.any(Number));
  });

  it("supersedes a queued Windows hand-back when the next gesture takes a lease", async () => {
    const { shell, request } = mount("<button>Run</button><input>", "windows");
    pointerDown(shell.querySelector("button")!);
    pointerUp(shell.querySelector("button")!, false);
    click(shell.querySelector("button")!);
    pointerDown(shell.querySelector("input")!);
    shell.querySelector("input")!.focus();
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
  });

  it("preserves a Windows selection gesture across blur when there is no lease to end", async () => {
    const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div>', "windows");
    const text = shell.querySelector("p")!;
    pointerDown(text);
    // The previous ordinary click's hand-back can produce both kinds of blur. Neither is
    // an input/selection lease ending, and neither should erase this gesture's intent.
    shell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    await flush();
    selectText(text);
    pointerUp(text);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.getSelection()?.toString()).toBe("Report text");
  });

  it.each(["before completion", "after completion"])("keeps a newer Windows lease across stale hand-back blur %s", async (timing) => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { shell, request, deactivate } = mount("<button>Run</button><input>", "windows");
    let completeHandBack!: () => void;
    let completeLease!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { completeHandBack = () => resolve(false); }));
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { completeLease = () => resolve(true); }));
    const button = shell.querySelector("button")!;
    pointerDown(button);
    click(button);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([false]);
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    if (timing === "after completion") {
      completeHandBack();
      await flush();
    }
    // The old false IPC can deliver native/DOM blur after the new pointerdown.
    window.dispatchEvent(new Event("blur"));
    shell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    completeHandBack();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([false, true]);
    completeLease();
    await flush();
    expect(document.activeElement).toBe(input);
    // Once the new lease has settled, a real loss of focus must still finish it.
    hasFocus.mockReturnValue(false);
    deactivate();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([false, true, false]);
  });

  it.each(["Enter", " "])("does not hand back a Windows keyboard click from %s", async (activation) => {
    const { shell, request } = mount('<button>Run</button><div class="plugin-report"><p>Report text</p></div>', "windows");
    const button = shell.querySelector("button")!;
    button.focus();
    key(button, activation);
    click(button, 0);
    await flush();
    expect(request).not.toHaveBeenCalled();
    const text = shell.querySelector("p")!;
    pointerDown(text);
    selectText(text);
    pointerUp(text);
    click(text);
    await flush();
    key(button, activation);
    click(button, 0);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    expect(document.getSelection()?.toString()).toBe("Report text");
  });

  it("requires a matching unconsumed pointer gesture for Windows click hand-back", async () => {
    const { shell, request } = mount("<button>Run</button><h2>Title</h2>", "windows");
    const button = shell.querySelector("button")!;
    const title = shell.querySelector("h2")!;
    click(button);
    pointerDown(title);
    click(button);
    await flush();
    expect(request).not.toHaveBeenCalled();
    pointerDown(button);
    click(button);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([false]);
    request.mockClear();
    click(button);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["macos", "windows"] as const)("ends a dropped background acquisition immediately (%s)", async (platform) => {
    const { shell, request } = mount("<input>", platform);
    request.mockResolvedValueOnce(false);
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    expect(document.activeElement).not.toBe(input);
    pointerDown(input); input.focus();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false, true]);
  });

  it("a dropped background lease cannot suppress later idle activation", async () => {
    vi.useFakeTimers();
    const { shell, request, activate } = mount("<input>", "windows");
    request.mockResolvedValueOnce(false);
    const input = shell.querySelector("input")!;
    pointerDown(input); pointerUp(input); click(input);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    request.mockClear();
    activate();
    await vi.advanceTimersByTimeAsync(64);
    expect(request).toHaveBeenCalledExactlyOnceWith(false, expect.any(Number));
  });

  it.each(["macos", "windows"] as const)("cancels queued retries when the outstanding lease deactivates (%s)", async (platform) => {
    const { shell, request, deactivate } = mount("<input>", platform);
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
    const { shell, request } = mount("<input>", "windows");
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

  it("ends a pending retry on loss of its predecessor's native generation", async () => {
    const { shell, request, deactivate } = mount("<input>", "windows");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    await flush();
    const old = request.mock.calls[0]![1];
    let complete!: () => void;
    request.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = () => resolve(true); }));
    pointerDown(input);
    await flush();
    deactivate(old);
    complete();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true, false]);
  });

  it("ignores native deactivation tagged with an older settled lease generation", async () => {
    const { shell, request, deactivate } = mount("<input>", "windows");
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    const old = request.mock.calls[0]![1];
    pointerDown(input);
    await flush();
    deactivate(old);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true]);
    deactivate();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true, false]);
  });

  it.each(["macos", "windows"] as const)("releases selection leases on non-copy keys (%s)", async (platform) => {
    const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    const scrollKeys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End", "PageUp", "PageDown", " "];
    for (const value of [...scrollKeys, "m", "1", "Tab", "Enter"]) {
      request.mockClear();
      pointerDown(text); selectText(text); pointerUp(text); click(text);
      await flush();
      const event = trustedKey(text, value);
      await flush();
      expect(document.getSelection()?.isCollapsed, value).toBe(true);
      expect(request.mock.calls.map(([editing]) => editing), value).toEqual([true, false]);
      expect(event.defaultPrevented, value).toBe(scrollKeys.includes(value));
    }
  });

  it.each(["macos", "windows"] as const)("keeps selection leases for copy, select-all, extension and modifiers (%s)", async (platform) => {
    const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div>', platform);
    const text = shell.querySelector("p")!;
    pointerDown(text); selectText(text); pointerUp(text); click(text);
    await flush();
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const value of ["c", "C", "a", "A"]) {
        expect(trustedKey(text, value, modifiers).defaultPrevented).toBe(false);
      }
    }
    for (const value of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]) {
      expect(trustedKey(text, value, { shiftKey: true }).defaultPrevented).toBe(false);
    }
    for (const value of ["Shift", "Control", "Alt", "Meta"]) {
      expect(trustedKey(text, value).defaultPrevented).toBe(false);
    }
    // Scripted key events cannot release a user's selection lease.
    key(text, "ArrowRight");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    expect(document.getSelection()?.toString()).toBe("Report text");
  });

  it.each(["macos", "windows"] as const)("keeps input leases on trusted arrows (%s)", async (platform) => {
    const { shell, request } = mount("<input>", platform);
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    for (const value of ["ArrowRight", "ArrowDown"]) {
      expect(trustedKey(input, value).defaultPrevented).toBe(false);
    }
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    expect(document.activeElement).toBe(input);
  });

  it.each(["collapse", "outside", "control"])("ends a settled selection lease when its range changes: %s", async (change) => {
    const { shell, request } = mount('<input><div class="plugin-report"><p>Report text</p><button>Action</button></div>', "windows");
    const text = shell.querySelector("p")!;
    pointerDown(text); selectText(text); pointerUp(text); click(text);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    if (change === "collapse") {
      key(text, "ArrowRight");
      document.getSelection()!.collapseToEnd(); // Browser default action after the key.
    } else if (change === "control") {
      selectText(shell.querySelector("button")!);
    } else {
      const outside = document.createElement("p");
      outside.textContent = "Outside the report";
      document.body.append(outside);
      selectText(outside);
    }
    document.dispatchEvent(new Event("selectionchange"));
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it("lets the full-size overlay consume Escape before releasing its input lease", async () => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    const closeOverlay = (event: KeyboardEvent): void => { event.preventDefault(); };
    shell.addEventListener("keydown", closeOverlay, { capture: true, once: true });
    key(input, "Escape");
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["drag", "double", "triple"])("leases focus for a trusted %s selection and preserves native copy", async (gesture) => {
    const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div>');
    const text = shell.querySelector("p")!;
    pointerDown(text);
    selectText(text);
    pointerUp(text, gesture === "drag");
    if (gesture !== "drag") selectionHandlers.get(shell)!.click?.({
      target: text, isTrusted: true, detail: gesture === "double" ? 2 : 3
    } as unknown as Event);
    // Native key acquisition may focus the body; this must not end the text lease.
    shell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
    shell.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(document.getSelection()?.toString()).toBe("Report text");
    const escape = key(shell, "Escape");
    await flush();
    expect(escape.defaultPrevented).toBe(true);
    expect(document.getSelection()?.toString()).toBe("");
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it.each(["plain click", "empty drag", "synthetic up", "script", "outside text", "cross boundary"])(
    "does not lease focus for %s", async (gesture) => {
      const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div><h2>Window title</h2>');
      const text = shell.querySelector("p")!;
      const title = shell.querySelector("h2")!;
      const target = gesture === "outside text" ? title : text;
      if (gesture !== "script") pointerDown(target);
      if (gesture !== "empty drag") selectText(target, gesture === "cross boundary" ? title : target);
      document.dispatchEvent(new Event("selectionchange"));
      pointerUp(target, gesture !== "plain click", gesture !== "synthetic up");
      if (gesture === "synthetic up") target.dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true }));
      await flush();
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each(["panel click", "document click", "replacement"])(
    "clears a report selection lease on %s", async (ending) => {
      const { shell, request, deactivate } = mount('<div class="plugin-report"><p>Report text</p></div><button>Run</button>');
      const text = shell.querySelector("p")!;
      pointerDown(text);
      selectText(text);
      pointerUp(text);
      await flush();
      expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
      if (ending === "panel click") pointerDown(shell.querySelector("button")!);
      else if (ending === "document click") deactivate();
      else shell.innerHTML = "Replacement report";
      await flush();
      expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
      expect(document.getSelection()?.toString()).toBe("");
    }
  );

  it("requires a trusted input pointer-down before programmatic focus may borrow the keyboard", async () => {
    const { shell, request } = mount("<input><select><option>One</option></select>");
    const input = shell.querySelector("input")!;
    input.focus();
    await flush();
    expect(request).not.toHaveBeenCalled();
    input.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await flush();
    expect(request).not.toHaveBeenCalled();
    pointerDown(input);
    input.focus();
    await flush();
    shell.querySelector("select")!.focus();
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    shell.querySelector("select")!.blur();
    await flush();
    input.focus();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
  });

  it("releases the lease when a snapshot removes a focused control without focusout", async () => {
    const { shell, request } = mount("<select><option>One</option></select>");
    const select = shell.querySelector("select")!;
    pointerDown(select);
    select.focus();
    await flush();
    const focusout = vi.fn();
    shell.addEventListener("focusout", focusout);
    shell.innerHTML = "<p>Replacement report</p>";
    await flush();
    expect(focusout).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });
  it.each([
    '<input type="text">', '<input type="number">', "<textarea></textarea>",
    "<select><option>One</option></select>", '<div contenteditable="true"><span>Text</span></div>',
    '<div contenteditable="plaintext-only">Text</div>', '<div contenteditable>Text</div>'
  ])("requests native focus for %s", async (html) => {
    const { shell, request } = mount(html);
    const control = shell.firstElementChild!;
    pointerDown(control.lastElementChild ?? control);
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
  });

  it.each([
    "<button>Run</button>", '<a href="#">Link</a>', "<canvas></canvas>", "<h2>Title</h2>",
    "<div>Empty space</div>", '<input type="button">', '<input readonly>', '<textarea readonly></textarea>',
    '<input disabled>', '<div contenteditable="false">Text</div>',
    '<div contenteditable="true"><span contenteditable="false">Fixed</span></div>'
  ])("does not request native focus for %s", async (html) => {
    const { shell, request } = mount(html);
    pointerDown(shell.querySelector("span") ?? shell.firstElementChild!);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it("handles associated labels and programmatic keyboard focus without duplicate requests", async () => {
    const { shell, request } = mount('<label for="field">Value</label><input id="field">');
    expect(panelEditableControl(shell.querySelector("label"))).toBe(shell.querySelector("input"));
    pointerDown(shell.querySelector("label")!);
    shell.querySelector("input")!.focus();
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
  });

  it.each(["Escape", "Enter"])("returns focus on %s and preserves the commit/close behavior", async (value) => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    const commit = vi.fn();
    const outerKey = vi.fn();
    input.addEventListener("keydown", commit);
    document.body.addEventListener("keydown", outerKey, { once: true });
    key(input, value);
    await flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(input);
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
    expect(outerKey).toHaveBeenCalledTimes(value === "Escape" ? 0 : 1);
    document.body.removeEventListener("keydown", outerKey);
  });

  it("keeps multiline Enter and IME Enter/Escape in the input", async () => {
    const { shell, request } = mount("<textarea></textarea>");
    const input = shell.querySelector("textarea")!;
    pointerDown(input);
    input.focus();
    await flush();
    key(input, "Enter");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    expect(document.activeElement).toBe(input);
  });

  it("tabs between editable controls, then returns to the drawing at either end", async () => {
    const { shell, request } = mount('<input id="first"><button>Run</button><input disabled><input id="last">');
    const first = shell.querySelector<HTMLInputElement>("#first")!;
    const last = shell.querySelector<HTMLInputElement>("#last")!;
    pointerDown(first);
    first.focus();
    await flush();
    key(first, "Tab");
    await flush();
    expect(document.activeElement).toBe(last);
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
    key(last, "Tab");
    await flush();
    expect(request).toHaveBeenLastCalledWith(false, expect.any(Number));
    pointerDown(first);
    first.focus();
    await flush();
    key(first, "Tab", true);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false, true, false]);
  });

  it("keeps Tab navigation inside the active portalled modal", async () => {
    const shell = document.createElement("aside");
    shell.innerHTML = '<select id="inline"><option>Inline</option></select>';
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<select id="modal-first"><option>First</option></select><select id="modal-last"><option>Last</option></select>';
    document.body.append(shell, modal);
    const request = vi.fn(async (editing: boolean, _generation: number) => editing);
    const listen = vi.spyOn(document.body, "addEventListener");
    cleanup = installPluginPanelInputFocus(document.body, request);
    const down = listen.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener;
    const modalFirst = modal.querySelector<HTMLSelectElement>("#modal-first")!;
    const modalLast = modal.querySelector<HTMLSelectElement>("#modal-last")!;

    // Use the same trusted-pointer handler path as the lease tests; jsdom cannot synthesize trust.
    down({ target: modalFirst, button: 0, isTrusted: true, pointerId: 1, clientX: 10, clientY: 10 } as unknown as Event);
    modalFirst.focus();
    await flush();
    key(modalFirst, "Tab", true);
    await flush();
    expect(document.activeElement).not.toBe(shell.querySelector("#inline"));
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);

    down({ target: modalFirst, button: 0, isTrusted: true, pointerId: 1, clientX: 10, clientY: 10 } as unknown as Event);
    modalFirst.focus();
    await flush();
    key(modalFirst, "Tab");
    await flush();
    expect(document.activeElement).toBe(modalLast);
    key(modalLast, "Tab");
    await flush();
    expect(document.activeElement).not.toBe(modalLast);
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false, true, false]);
  });

  it("returns focus on non-input click and still delivers button actions", async () => {
    const { shell, request } = mount("<input><button>Run</button>");
    pointerDown(shell.querySelector("input")!);
    shell.querySelector("input")!.focus();
    await flush();
    const button = shell.querySelector("button")!;
    const action = vi.fn();
    button.addEventListener("click", action);
    pointerDown(button);
    button.click();
    await flush();
    expect(action).toHaveBeenCalledOnce();
    expect(request).toHaveBeenLastCalledWith(false, expect.any(Number));
  });

  it.each(["macos", "windows"] as const)("ignores DOM blur and ends on native deactivation (%s)", async (platform) => {
    const { shell, request, deactivate } = mount("<input>", platform);
    const input = shell.querySelector("input")!;
    pointerDown(input); input.focus();
    await flush();
    input.blur();
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true]);
    deactivate();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
  });

  it("does not apply a stale activation after a fast Escape", async () => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    key(input, "Escape");
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(false, expect.any(Number));
  });

  it("scrolling alone does not end a native lease or cancel scrolling", async () => {
    const { shell, request } = mount("<input><div>Report</div>");
    pointerDown(shell.querySelector("input")!);
    shell.querySelector("input")!.focus();
    await flush();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    shell.querySelector("div")!.dispatchEvent(wheel);
    await flush();
    expect(wheel.defaultPrevented).toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith(true, expect.any(Number));
  });
});
