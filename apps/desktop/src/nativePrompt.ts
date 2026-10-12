import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { message, type MessageDialogCustomButtons } from "@tauri-apps/plugin-dialog";
import { acquireNativeUtilitySuspension, withNativeUtilitySuspension } from "./nativeUtilitySuspension";

/**
 * AppKit maps Escape only to an alert button literally titled "Cancel" (rfd adds custom buttons by
 * title, without key equivalents), so a prompt with a choice to make shows its cancel choice as
 * "Cancel". A notice with nothing to choose has one "OK" button, which Return dismisses.
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

export function nativePromptButtons(prompt: NativePromptOptions): MessageDialogCustomButtons {
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
  // The plugin has no default-button option: the first button (ok/yes) is always the default, so it
  // must be a safe action. A lone destructive action needs a safe alternative beside Cancel.
  const safe = actions.find((choice) => !choice.destructive);
  if (!safe) throw new Error("A destructive action is never the default button; offer a safe action too.");
  if (actions.length === 1) return { ok: safe.label, cancel: cancel.label };
  const other = actions.find((choice) => choice !== safe)!;
  return { yes: safe.label, no: other.label, cancel: cancel.label };
}

export async function nativePrompt(
  prompt: NativePromptOptions,
  fallback: NativePromptFallback = renderPromptFallback,
  signal?: AbortSignal
): Promise<string> {
  const buttons = nativePromptButtons(prompt);
  const cancel = prompt.choices.find((choice) => choice.cancel)!;
  if (signal?.aborted) return cancel.id;
  if (provider) {
    const result = await provider(prompt, fallback);
    return prompt.choices.find((choice) => choice.id === result)?.id ?? cancel.id;
  }
  if (!isTauri()) return fallback(prompt);
  let result: string;
  try {
    await Promise.resolve();
    // React StrictMode replays mount effects. Its first request must not open a second OS box.
    if (signal?.aborted) return cancel.id;
    result = await withNativeUtilitySuspension(async () => {
      if (signal?.aborted) return cancel.label;
      return message(prompt.message, { title: prompt.title, kind: prompt.kind, buttons });
    });
  } catch (error) {
    console.error("Native prompt failed", error);
    return fallback(prompt);
  }
  // Custom buttons return their label and an OS dismissal returns Cancel, which is also the cancel
  // choice's label. Fail closed on any unexpected result; never read labels as positional button IDs.
  return prompt.choices.find((choice) => choice.label === result)?.id ?? cancel.id;
}

/** Existing React dialogs provide the fallback; their buttons resolve the same prompt promise.
 * `suspendSequence` keeps a close flow hidden through its choice callback and any re-asks. */
export function useNativePrompt(
  prompt: NativePromptOptions,
  onChoice: (id: string) => void | boolean | Promise<void | boolean>,
  requestKey: string | number | undefined,
  suspendSequence = false
): { visible: boolean; choose: (id: string) => void } {
  const current = useRef({ prompt, onChoice });
  current.current = { prompt, onChoice };
  const resolve = useRef<((id: string) => void) | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const suspension = useRef<Promise<(() => Promise<void>) | undefined>>(undefined);
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
    void nativePrompt(current.current.prompt, fallback, controller.signal).then(async (id) => {
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
