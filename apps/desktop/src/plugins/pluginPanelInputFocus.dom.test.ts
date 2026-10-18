// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPluginPanelInputFocus, panelEditableControl } from "./pluginPanelInputFocus";

let cleanup: (() => void) | undefined;
const pointerHandlers = new WeakMap<HTMLElement, EventListener>();
const selectionHandlers = new WeakMap<HTMLElement, { up: EventListener; click: EventListener }>();
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function mount(html: string) {
  const shell = document.createElement("aside");
  shell.innerHTML = html;
  document.body.append(shell);
  const request = vi.fn(async (_editing: boolean) => undefined);
  const listen = vi.spyOn(shell, "addEventListener");
  const listenWindow = vi.spyOn(window, "addEventListener");
  cleanup = installPluginPanelInputFocus(shell, request);
  pointerHandlers.set(shell, listen.mock.calls.find(([type]) => type === "pointerdown")![1] as EventListener);
  selectionHandlers.set(shell, {
    up: listenWindow.mock.calls.filter(([type]) => type === "pointerup").at(-1)?.[1] as EventListener,
    click: listen.mock.calls.find(([type]) => type === "click")?.[1] as EventListener
  });
  return { shell, request };
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

function key(target: Element, value: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("panel input keyboard focus", () => {
  it("retries on a new trusted click if the native request was dropped while background", async () => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    // The native guard may drop that request, without this never-key panel receiving a blur.
    pointerDown(input);
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, true]);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
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

  it.each(["panel click", "document click", "replacement", "collapsed selection"])(
    "clears a report selection lease on %s", async (ending) => {
      const { shell, request } = mount('<div class="plugin-report"><p>Report text</p></div><button>Run</button>');
      const text = shell.querySelector("p")!;
      pointerDown(text);
      selectText(text);
      pointerUp(text);
      await flush();
      expect(request).toHaveBeenCalledExactlyOnceWith(true);
      if (ending === "panel click") pointerDown(shell.querySelector("button")!);
      else if (ending === "document click") window.dispatchEvent(new Event("blur"));
      else if (ending === "replacement") shell.innerHTML = "Replacement report";
      else {
        document.getSelection()?.collapse(text.firstChild, 0);
        document.dispatchEvent(new Event("selectionchange"));
      }
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
    shell.querySelector("select")!.blur();
    await flush();
    input.focus();
    await flush();
    expect(request.mock.calls.map(([editing]) => editing)).toEqual([true, false]);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
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
    expect(request).toHaveBeenCalledExactlyOnceWith(true);
    key(last, "Tab");
    await flush();
    expect(request).toHaveBeenLastCalledWith(false);
    pointerDown(first);
    first.focus();
    await flush();
    key(first, "Tab", true);
    await flush();
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
    expect(request).toHaveBeenLastCalledWith(false);
  });

  it.each(["dom", "native"])("releases the input lease after %s focus leaves the panel", async (kind) => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    await flush();
    if (kind === "native") window.dispatchEvent(new Event("blur"));
    else input.blur();
    await flush();
    expect(request).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("does not apply a stale activation after a fast Escape", async () => {
    const { shell, request } = mount("<input>");
    const input = shell.querySelector("input")!;
    pointerDown(input);
    input.focus();
    key(input, "Escape");
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("returns focus when scrolling the report outside an input without cancelling scrolling", async () => {
    const { shell, request } = mount("<input><div>Report</div>");
    pointerDown(shell.querySelector("input")!);
    shell.querySelector("input")!.focus();
    await flush();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    shell.querySelector("div")!.dispatchEvent(wheel);
    await flush();
    expect(wheel.defaultPrevented).toBe(false);
    expect(request).toHaveBeenLastCalledWith(false);
  });
});
