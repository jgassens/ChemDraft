import type { PluginTextPromptSnapshot } from "../dialogs/dialogProtocol";
import type { PluginTextPromptResult, PluginTextPromptState } from "../dialogs/DialogCoordinator";
import type { OpenPluginTextPrompt, PluginPromptTextController } from "./PluginPromptTextController";

/** The controller surface the desktop shell needs; its queue keeps one prompt on screen at a time. */
export type PluginTextPromptQueue = Pick<PluginPromptTextController, "getOpenPrompt" | "subscribe" | "submit" | "cancel">;

export interface PluginTextPromptDialogHost {
  /** The document window's dialog coordinator, if the native dialog host is available. */
  coordinator(): { promptPluginText(tabId: string, data: PluginTextPromptSnapshot, signal?: AbortSignal,
    onOpen?: (update: (state: PluginTextPromptState) => Promise<void>) => void): Promise<PluginTextPromptResult> } | undefined;
  /** The open tab holding the document a prompt's command started on (the active tab for a prompt
   *  bound to no document), or undefined once that tab closed or its document was replaced. */
  documentTab(documentKey: string | undefined): { id: string; title: string } | undefined;
  activeTabId(): string | undefined;
  onError(message: string): void;
}

/** Submit is available only while the prompt's own tab is active: its command can write nowhere else. */
export function pluginTextPromptTabState(tab: { id: string; title: string }, activeTabId: string | undefined): PluginTextPromptState {
  if (tab.id === activeTabId) return {};
  const name = Array.from(tab.title);
  return { submitEnabled: false, statusLine: `Switch back to ${name.length > 160 ? `${name.slice(0, 159).join("")}…` : tab.title} to insert.` };
}

export function pluginTextPromptSnapshot(prompt: OpenPluginTextPrompt): PluginTextPromptSnapshot {
  const { request } = prompt;
  return {
    title: request.title,
    label: request.label,
    placeholder: request.placeholder ?? "",
    initialValue: request.initialValue ?? "",
    submitLabel: request.submitLabel || "Submit",
    maxLength: request.maxLength,
    pluginName: prompt.pluginName,
    pluginId: prompt.pluginId
  };
}

/**
 * Presents the controller's open prompt through the shared native dialog host, one at a time, in
 * queue order. Submit resolves the plugin's request with the exact text; Cancel, Escape, Cmd+. and
 * closing the window resolve it as cancelled. When the request ends first (its command returned,
 * the plugin was disabled), the controller drops the prompt and this closes its window.
 */
export function presentPluginTextPromptsNatively(prompts: PluginTextPromptQueue, host: PluginTextPromptDialogHost): () => void {
  type Presented = { id: number; abort: AbortController; state: PluginTextPromptState;
    update?: (state: PluginTextPromptState) => Promise<void> };
  let presented: Presented | undefined;
  let stopped = false;
  const finish = (prompt: OpenPluginTextPrompt, result: PluginTextPromptResult) => {
    if (presented?.id === prompt.id) presented = undefined;
    if (result.status === "submitted") prompts.submit(prompt.id, result.value);
    // A value the controller refuses must not leave the request waiting with no window.
    if (prompts.getOpenPrompt()?.id === prompt.id) prompts.cancel(prompt.id);
  };
  const sync = () => {
    if (stopped) return;
    const prompt = prompts.getOpenPrompt();
    // Its tab closed or its document was replaced: the controller normally cancels it first.
    const tab = prompt && host.documentTab(prompt.documentKey);
    if (prompt && !tab) { prompts.cancel(prompt.id); return; }
    const state = tab && pluginTextPromptTabState(tab, host.activeTabId());
    if (presented && presented.id === prompt?.id) {
      const current = presented;
      if (!state || (state.statusLine === current.state.statusLine && state.submitEnabled === current.state.submitEnabled)) return;
      current.state = state;
      void current.update?.(state).catch(error => host.onError(`${prompt.request.title} could not update: ${String(error)}`));
      return;
    }
    presented?.abort.abort();
    presented = undefined;
    if (!prompt || !tab || !state) return;
    const abort = new AbortController();
    const shown: Presented = { id: prompt.id, abort, state };
    presented = shown;
    const coordinator = host.coordinator();
    if (!coordinator) {
      host.onError(`${prompt.request.title} could not open: the dialog host is unavailable.`);
      finish(prompt, { status: "cancelled" });
      return;
    }
    void coordinator.promptPluginText(tab.id, { ...pluginTextPromptSnapshot(prompt), ...state }, abort.signal, update => { shown.update = update; })
      .catch(() => ({ status: "cancelled" }) as const)
      .then(result => finish(prompt, result));
  };
  const unsubscribe = prompts.subscribe(sync);
  sync();
  return () => {
    stopped = true;
    unsubscribe();
    presented?.abort.abort();
    presented = undefined;
  };
}
