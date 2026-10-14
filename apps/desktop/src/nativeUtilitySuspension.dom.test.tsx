// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInAppModalUtilitySuspension } from "./useInAppModalUtilitySuspension";
import { save } from "./nativeFileDialog";

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.desktop, invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));

function DocumentWindow() {
  useInAppModalUtilitySuspension();
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe.each(["MacIntel", "Win32"])("in-app modal utility suspension on %s", (platform) => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  let depth: number;
  let visibility: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    native.desktop = true;
    depth = 0;
    visibility = [];
    native.invoke.mockImplementation(async (_command, { suspended }) => {
      if (suspended) { if (depth++ === 0) visibility.push("hide"); }
      else { if (--depth === 0) visibility.push("restore"); }
    });
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    await unmount();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => root!.render(createElement(DocumentWindow)));
  }
  async function unmount() {
    const current = root;
    root = undefined;
    if (current) await act(async () => current.unmount());
  }
  async function mutate(action: () => void) {
    await act(async () => { action(); });
  }
  function modal() {
    const element = document.createElement("div");
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "true");
    return element;
  }
  const calls = () => native.invoke.mock.calls.map(([, args]) => args.suspended);

  it("acquires on opening a portal modal, ignores unrelated mutations, and releases on closing", async () => {
    await mount();
    const dialog = modal();
    expect(calls()).toEqual([]);
    await mutate(() => document.body.append(dialog));
    expect(calls()).toEqual([true]);
    await mutate(() => dialog.append(document.createElement("input")));
    await mutate(() => dialog.setAttribute("class", "export-dialog"));
    expect(calls()).toEqual([true]);
    await mutate(() => dialog.remove());
    expect(calls()).toEqual([true, false]);
    expect(depth).toBe(0);
    await unmount();
    expect(calls()).toEqual([true, false]);
  });

  it.each([false, true])("holds one acquisition across two modals (first closes first: %s)", async (firstClosesFirst) => {
    await mount();
    const first = modal(), second = modal();
    await mutate(() => document.body.append(first));
    await mutate(() => first.append(second));
    expect(calls()).toEqual([true]);
    // Move the nested dialog out before closing its parent, keeping both open.
    await mutate(() => document.body.append(second));
    await mutate(() => (firstClosesFirst ? first : second).remove());
    expect(calls()).toEqual([true]);
    await mutate(() => (firstClosesFirst ? second : first).remove());
    expect(calls()).toEqual([true, false]);
  });

  it("handles initially open dialogs, subtree removal, and modal replacement during tab changes", async () => {
    const wrapper = document.createElement("section");
    const first = modal();
    wrapper.append(first);
    document.body.append(wrapper);
    await mount();
    expect(calls()).toEqual([true]);
    await mutate(() => wrapper.replaceChildren(modal()));
    expect(calls()).toEqual([true]);
    await mutate(() => wrapper.remove());
    expect(calls()).toEqual([true, false]);
  });

  it("tracks hidden and aria-modal changes without relying on component state", async () => {
    const dialog = modal();
    dialog.hidden = true;
    document.body.append(dialog);
    await mount();
    expect(calls()).toEqual([]);
    await mutate(() => { dialog.hidden = false; });
    expect(calls()).toEqual([true]);
    await mutate(() => { dialog.hidden = true; });
    expect(calls()).toEqual([true, false]);
    await mutate(() => { dialog.hidden = false; });
    await mutate(() => dialog.setAttribute("aria-modal", "false"));
    expect(calls()).toEqual([true, false, true, false]);
  });

  it.each(["display", "visibility", "ancestor", "class"])("ignores CSS-hidden modals (%s), then tracks showing and hiding", async (kind) => {
    const wrapper = document.createElement("section");
    const dialog = modal();
    wrapper.append(dialog);
    const stylesheet = document.createElement("style");
    stylesheet.textContent = ".closed-modal { display: none; }";
    document.body.append(stylesheet, wrapper);
    const hide = () => {
      if (kind === "display") dialog.style.display = "none";
      if (kind === "visibility") dialog.style.visibility = "hidden";
      if (kind === "ancestor") wrapper.style.display = "none";
      if (kind === "class") dialog.className = "closed-modal";
    };
    hide();
    await mount();
    expect(calls()).toEqual([]);
    await mutate(() => { dialog.removeAttribute("style"); wrapper.removeAttribute("style"); dialog.className = ""; });
    expect(calls()).toEqual([true]);
    await mutate(hide);
    expect(calls()).toEqual([true, false]);
  });

  it.each(["native first", "modal first", "native error"])("shares the native counter with a file picker (%s)", async (order) => {
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    const panel = deferred<string | null>();
    native.save.mockReturnValue(panel.promise);
    const picker = save({ title: "Choose export file" });
    // Attach a rejection handler before exercising a failing panel.
    const result = picker.catch((error: unknown) => error);
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledOnce());
    expect(depth).toBe(2);
    expect(visibility).toEqual(["hide"]);
    if (order === "modal first") await mutate(() => dialog.remove());
    if (order === "native error") panel.reject(new Error("picker failed"));
    else panel.resolve(null);
    await result;
    if (order !== "modal first") {
      expect(depth).toBe(1);
      expect(visibility).toEqual(["hide"]);
      await mutate(() => dialog.remove());
    }
    expect(calls()).toEqual([true, true, false, false]);
    expect(depth).toBe(0);
    expect(visibility).toEqual(["hide", "restore"]);
  });

  it("releases exactly once on unmount and stops observing", async () => {
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    await unmount();
    expect(calls()).toEqual([true, false]);
    await mutate(() => { dialog.remove(); document.body.append(modal()); });
    expect(calls()).toEqual([true, false]);
  });

  it.each(["close", "unmount"])("releases a pending acquisition after %s without waiting for IPC", async (ending) => {
    const pending = deferred<void>();
    native.invoke.mockReturnValueOnce(pending.promise);
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    if (ending === "close") await mutate(() => dialog.remove());
    await unmount();
    expect(calls()).toEqual([true]);
    await act(async () => pending.resolve());
    expect(calls()).toEqual([true, false]);
  });

  it("handles quit refusing acquisition without retrying or releasing an unowned counter entry", async () => {
    native.invoke.mockRejectedValue(new Error("quit_in_progress"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    await mutate(() => dialog.append(document.createElement("span")));
    await mutate(() => dialog.remove());
    await unmount();
    expect(calls()).toEqual([true]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("handles quit refusing release, without retrying", async () => {
    native.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("quit_in_progress"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    await mutate(() => dialog.remove());
    await unmount();
    expect(calls()).toEqual([true, false]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not wait for release IPC during unmount", async () => {
    native.invoke.mockResolvedValueOnce(undefined).mockReturnValueOnce(new Promise(() => {}));
    await mount();
    await mutate(() => document.body.append(modal()));
    await unmount();
    expect(calls()).toEqual([true, false]);
  });

  it("releases and disconnects if observing fails while a modal is open", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    const dialog = modal();
    await mutate(() => document.body.append(dialog));
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => { throw new Error("style unavailable"); });
    await mutate(() => dialog.setAttribute("class", "changed"));
    expect(calls()).toEqual([true, false]);
    expect(log).toHaveBeenCalledOnce();
    await unmount();
    expect(calls()).toEqual([true, false]);
  });

  it("makes no native calls and installs no observer in the web build", async () => {
    native.desktop = false;
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    document.body.append(modal());
    await mount();
    await mutate(() => document.body.append(modal()));
    await unmount();
    expect(calls()).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });
});
