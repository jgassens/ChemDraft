import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { message, type MessageDialogCustomButtons } from "@tauri-apps/plugin-dialog";
import { acquireNativeUtilitySuspension, withNativeUtilitySuspension } from "./nativeUtilitySuspension";

/**
 * AppKit maps Escape only to an alert button literally titled "Cancel" (rfd adds custom buttons by
 * title, without key equivalents), so a prompt with a choice to make shows its cancel choice as
 * "Cancel". With Cancel first, AppKit gives neither button the Return default (native probe);
 * Windows defaults to that first, safe button. A notice has one "OK" button.
 */
export const NATIVE_PROMPT_CANCEL_LABEL = "Cancel";
export const NATIVE_PROMPT_ACKNOWLEDGE_LABEL = "OK";
export type NativePromptChoice =
  | { id: string; label: string; cancel?: false; destructive?: boolean }
  | {
      id: string;
      label: typeof NATIVE_PROMPT_CANCEL_LABEL | typeof NATIVE_PROMPT_ACKNOWLEDGE_LABEL;
      cancel: true;
      destructive?: false;
    };
export interface NativePromptOptions {
  title: string;
  message: string;
  kind: "info" | "warning" | "error";
  choices: readonly NativePromptChoice[];
  /** Tauri parents message boxes to the invoking window on both desktop platforms. */
  owner?: "document";
}
export type NativePromptFallback = (prompt: NativePromptOptions) => Promise<string>;
export type NativePromptProvider = (prompt: NativePromptOptions, fallback: NativePromptFallback) => Promise<string>;
let provider: NativePromptProvider | undefined;

/** Test injection is scoped by the returned restore function; it never enables native access. */
export function setNativePromptProvider(next: NativePromptProvider): () => void {
  const previous = provider;
  provider = next;
  return () => { provider = previous; };
}

export function nativePromptButtons(prompt: NativePromptOptions,
  _platform: ShortcutPlatform = detectDesktopShortcutPlatform()): MessageDialogCustomButtons {
  const { choices } = prompt;
  const cancel = choices.find((choice) => choice.cancel);
  if (!cancel || choices.filter((choice) => choice.cancel).length !== 1 ||
      choices.length < 1 || choices.length > 3 || cancel.destructive ||
      choices.filter((choice) => choice.destructive).length > 1 ||
      new Set(choices.map((choice) => choice.id)).size !== choices.length ||
      new Set(choices.map((choice) => choice.label)).size !== choices.length) {
    throw new Error("A prompt needs one safe cancel choice and one to three distinct labelled choices.");
  }
  const actions = choices.filter((choice) => !choice.cancel);
  if (!actions.length) {
    if (cancel.label !== NATIVE_PROMPT_ACKNOWLEDGE_LABEL) throw new Error("A notice's only button is labelled OK.");
    return { ok: cancel.label };
  }
  if (cancel.label !== NATIVE_PROMPT_CANCEL_LABEL) {
    throw new Error("A prompt with a choice labels its cancel button Cancel, the only title Escape reaches on macOS.");
  }
  // Windows source: rfd 0.16.0, src/backend/win_cid/message_dialog.rs, WinMessageDialog::run
  // (tauri-plugin-dialog 2.7.1 enables common-controls-v6). OkCancelCustom orders IDs 1000/1001;
  // TASKDIALOGCONFIG.nDefaultButton = 0 selects the first button. TDF_ALLOW_DIALOG_CANCELLATION
  // makes Escape return IDCANCEL -> "Cancel", not custom ID 1001's label. Keep Cancel first.
  // macOS rfd only calls NSAlert.addButtonWithTitle: the native probe with Cancel first found
  // Escape selects Cancel and neither button is Return's default. Return thus never enlarges
  // on opening either platform's box; an explicitly focused action can still be activated.
  const safe = actions.find((choice) => !choice.destructive);
  if (!safe) return { ok: cancel.label, cancel: actions[0]!.label };
  if (actions.length === 1) return { ok: safe.label, cancel: cancel.label };
  const other = actions.find((choice) => choice !== safe)!;
  return { yes: safe.label, no: other.label, cancel: cancel.label };
}

export async function nativePrompt(
  prompt: NativePromptOptions,
  fallback: NativePromptFallback = renderPromptFallback,
  signal?: AbortSignal,
  onShowing?: () => void | Promise<void>,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): Promise<string> {
  const buttons = nativePromptButtons(prompt, platform);
  const cancel = prompt.choices.find((choice) => choice.cancel)!;
  if (signal?.aborted) return cancel.id;
  const response = showNativePrompt(prompt, fallback, signal, onShowing, platform, buttons);
  if (!signal) return response;
  // The native API cannot dismiss an open OS box. Release the caller immediately and ignore any
  // later answer; the suspension remains until the actual box closes.
  let stop!: () => void;
  try {
    return await Promise.race([response, new Promise<string>(resolve => {
      stop = () => resolve(cancel.id);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}

async function showNativePrompt(prompt: NativePromptOptions, fallback: NativePromptFallback,
  signal: AbortSignal | undefined, onShowing: (() => void | Promise<void>) | undefined,
  platform: ShortcutPlatform, buttons: MessageDialogCustomButtons): Promise<string> {
  const cancel = prompt.choices.find(choice => choice.cancel)!;
  if (provider) {
    let usingFallback = false;
    const response = provider(prompt, onShowing ? (options) => {
      usingFallback = true;
      return fallback(options);
    } : fallback);
    if (!usingFallback) await onShowing?.();
    const result = await response;
    return prompt.choices.find((choice) => choice.id === result)?.id ?? cancel.id;
  }
  if (!isTauri()) return fallback(prompt);
  let result: string;
  try {
    await Promise.resolve();
    // React StrictMode replays mount effects. Its first request must not open a second OS box.
    if (signal?.aborted) return cancel.id;
    if (prompt.owner === "document" && getCurrentWindow().label !== "main") {
      throw new Error(`A document-owned prompt must be invoked from the main window on ${platform}.`);
    }
    result = await withNativeUtilitySuspension(async () => {
      if (signal?.aborted) return cancel.label;
      const response = message(prompt.message, { title: prompt.title, kind: prompt.kind, buttons });
      await onShowing?.();
      return response;
    });
  } catch (error) {
    if (signal?.aborted) return cancel.id;
    console.error("Native prompt failed", error);
    return fallback(prompt);
  }
  // Custom buttons return their label and an OS dismissal returns Cancel, which is also the cancel
  // choice's label. Fail closed on any unexpected result; never read labels as positional button IDs.
  return prompt.choices.find((choice) => choice.label === result)?.id ?? cancel.id;
}

/** Existing React dialogs provide the fallback; their buttons resolve the same prompt promise.
 * `suspendSequence` keeps utilities hidden through the choice callback and any re-asks.
 * A native-only flow can supply a safe fallback instead of rendering a React dialog.
 * `onShowing` runs after native invocation, or after React mounts the fallback. */
export function useNativePrompt(
  prompt: NativePromptOptions,
  onChoice: (id: string) => void | boolean | Promise<void | boolean>,
  requestKey: string | number | undefined,
  suspendSequence = false,
  promptFallback?: NativePromptFallback,
  onShowing?: () => void | Promise<void>
): { visible: boolean; choose: (id: string) => void } {
  const current = useRef({ prompt, onChoice, onShowing });
  current.current = { prompt, onChoice, onShowing };
  const resolve = useRef<((id: string) => void) | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const suspension = useRef<Promise<(() => Promise<void>) | undefined>>(undefined);
  useEffect(() => {
    if (visible) void current.current.onShowing?.();
  }, [visible, requestKey]);
  useEffect(() => {
    if (requestKey === undefined || !suspendSequence) { suspension.current = undefined; return; }
    let disposed = false;
    // One outer acquisition survives retries and the choice callback's Save panel. Each box and
    // panel also acquires independently, so unmounting while one is open cannot reveal utilities.
    const acquisition = Promise.resolve().then(() => disposed ? undefined : acquireNativeUtilitySuspension())
      .catch((error) => {
        console.error("Could not suspend floating windows for prompt sequence", error);
        return undefined;
      });
    suspension.current = acquisition;
    return () => {
      disposed = true;
      void acquisition.then((release) => release?.());
    };
  }, [requestKey, suspendSequence]);
  useEffect(() => {
    if (requestKey === undefined) { setVisible(false); return; }
    let disposed = false;
    const controller = new AbortController();
    const acquisition = suspension.current;
    const fallback: NativePromptFallback = () => new Promise((done) => {
      if (disposed) { done(current.current.prompt.choices.find((choice) => choice.cancel)!.id); return; }
      resolve.current = done;
      setVisible(true);
    });
    void nativePrompt(current.current.prompt, promptFallback ?? fallback, controller.signal,
      () => disposed ? undefined : current.current.onShowing?.()).then(async (id) => {
      if (disposed) return;
      resolve.current = undefined;
      // Wait for React to publish Save's status before asking again with its failure detail.
      const repeat = await current.current.onChoice(id) === false;
      if (disposed) return;
      if (repeat) setAttempt((value) => value + 1);
      else {
        setVisible(false);
        await acquisition?.then((release) => release?.());
      }
    }).catch(async (error) => {
      console.error("Native prompt choice failed", error);
      await acquisition?.then((release) => release?.());
    });
    return () => {
      disposed = true;
      controller.abort();
      resolve.current?.(current.current.prompt.choices.find((choice) => choice.cancel)!.id);
      resolve.current = undefined;
    };
  }, [requestKey, attempt]);
  return { visible, choose: (id) => resolve.current?.(id) };
}

/** Browser-only message fallback for callers that did not previously own a React modal. */
function renderPromptFallback(prompt: NativePromptOptions): Promise<string> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const backdrop = document.createElement("div");
    backdrop.className = "plugin-prompt-backdrop";
    const dialog = document.createElement("section");
    dialog.className = "plugin-prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", prompt.title);
    const title = document.createElement("h2");
    title.textContent = prompt.title;
    const text = document.createElement("p");
    text.textContent = prompt.message;
    const footer = document.createElement("footer");
    footer.className = "plugin-prompt-actions";
    const finish = (id: string) => {
      backdrop.remove();
      if (previous?.isConnected) previous.focus();
      resolve(id);
    };
    for (const choice of prompt.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plugin-manager-button";
      button.textContent = choice.label;
      button.onclick = () => finish(choice.id);
      footer.append(button);
    }
    dialog.append(title, text, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);
    const buttons = Array.from(footer.querySelectorAll("button"));
    buttons[prompt.choices.findIndex((choice) => choice.cancel)]?.focus();
    dialog.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(prompt.choices.find((choice) => choice.cancel)!.id);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
  });
}
