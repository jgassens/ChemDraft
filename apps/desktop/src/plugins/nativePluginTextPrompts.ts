import { boundedPluginTextPromptSnapshot, type PluginTextPromptSnapshot } from "../dialogs/dialogProtocol";
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
  /** The open tabs in tab-strip order, read each time a status is pushed (tabs open, close and move). */
  tabs?(): readonly { id: string; title: string }[];
  onError(message: string): void;
}

/** Submit is available only while the prompt's own tab is active: its command can write nowhere else. */
export function pluginTextPromptTabState(tab: { id: string; title: string }, activeTabId: string | undefined,
  tabs?: readonly { id: string; title: string }[]): PluginTextPromptState {
  if (tab.id === activeTabId) return {};
  const name = Array.from(tab.title);
  // Another open tab with the same name: say which one by its 1-based position in the tab strip.
  const position = tabs && tabs.some(other => other.id !== tab.id && other.title === tab.title)
    ? tabs.findIndex(other => other.id === tab.id) + 1 : 0;
  const label = name.length > 160 ? `${name.slice(0, 159).join("")}…` : tab.title;
  return { submitEnabled: false, statusLine: `Switch back to ${label}${position > 0 ? ` (tab ${position})` : ""} to insert.` };
}

/** Shown while a reopened prompt's own tab is active and its window could hold only the start of the
 *  user's earlier answer; the whole answer is kept on the owner side. */
export const PLUGIN_TEXT_PROMPT_CLIPPED_DRAFT_LINE = "Only the start of your answer fits here. Submit it unchanged to insert all of it.";

/** The state whose status line leaves the least room for the initial value (the bound clips any status
 *  line to 200 characters and 600 serialized bytes). */
const COSTLIEST_STATE: PluginTextPromptState = { submitEnabled: false, statusLine: "状".repeat(200) };

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
  /** `draft` is set on a window reopened with the user's earlier answer: `shown` is what its text field
   *  starts with (the snapshot bound may clip it) and `full` is the whole answer the user submitted. */
  type Draft = { shown: string; full: string };
  type Presented = { id: number; abort: AbortController; state: PluginTextPromptState; draft?: Draft;
    update?: (state: PluginTextPromptState) => Promise<void> };
  let presented: Presented | undefined;
  /** What the user submitted to a prompt that had to be shown again; its next window starts with it. */
  let draft: { id: number; value: string } | undefined;
  let stopped = false;
  /** Submit on or off for the prompt's tab; on its own tab, a clipped draft says how to keep all of it. */
  const stateFor = (tab: { id: string; title: string }, kept: Draft | undefined): PluginTextPromptState => {
    const state = pluginTextPromptTabState(tab, host.activeTabId(), host.tabs?.());
    return kept && kept.shown !== kept.full && state.statusLine === undefined ? { ...state, statusLine: PLUGIN_TEXT_PROMPT_CLIPPED_DRAFT_LINE } : state;
  };
  const finish = (prompt: OpenPluginTextPrompt, shown: Presented, result: PluginTextPromptResult) => {
    if (presented === shown) presented = undefined;
    // A reopened window may hold only the start of the earlier answer. Submitted unchanged, the user
    // still means the whole answer; an edited value is exactly what the user chose to send.
    if (result.status === "submitted" && shown.draft && result.value === shown.draft.shown) result = { status: "submitted", value: shown.draft.full };
    if (result.status === "submitted") prompts.submit(prompt.id, result.value);
    if (prompts.getOpenPrompt()?.id !== prompt.id) return;
    // Submitted while its tab was active, but another tab became active before the window finished
    // closing, so the controller refused it. The prompt still belongs to its open tab: show it again,
    // with Submit off and what the user typed, rather than cancelling the plugin's request.
    const tab = host.documentTab(prompt.documentKey);
    if (result.status === "submitted" && !stopped && tab && tab.id !== host.activeTabId()) {
      draft = { id: prompt.id, value: result.value };
      sync();
      return;
    }
    // Any other value the controller refuses must not leave the request waiting with no window.
    prompts.cancel(prompt.id);
  };
  const sync = () => {
    if (stopped) return;
    const prompt = prompts.getOpenPrompt();
    // Its tab closed or its document was replaced: the controller normally cancels it first.
    const tab = prompt && host.documentTab(prompt.documentKey);
    if (prompt && !tab) { prompts.cancel(prompt.id); return; }
    if (presented && presented.id === prompt?.id) {
      const current = presented;
      const state = tab && stateFor(tab, current.draft);
      if (!state || (state.statusLine === current.state.statusLine && state.submitEnabled === current.state.submitEnabled)) return;
      current.state = state;
      void current.update?.(state).catch(error => host.onError(`${prompt.request.title} could not update: ${String(error)}`));
      return;
    }
    presented?.abort.abort();
    presented = undefined;
    if (!prompt || !tab) return;
    const full = draft?.id === prompt.id ? draft.value : undefined;
    draft = undefined;
    // The window's text field starts with what the snapshot bound keeps of the earlier answer. Bound it
    // here against the costliest state (a 600-byte status line, Submit off), so neither this open nor any
    // later state change can clip it further: `shown` is exactly the text the window starts with.
    const request = pluginTextPromptSnapshot(prompt);
    const kept: Draft | undefined = full === undefined ? undefined : { full,
      shown: boundedPluginTextPromptSnapshot({ ...request, initialValue: full, ...COSTLIEST_STATE }).initialValue };
    const state = stateFor(tab, kept);
    const data = { ...request, ...(kept ? { initialValue: kept.shown } : {}), ...state };
    const abort = new AbortController();
    const shown: Presented = { id: prompt.id, abort, state, draft: kept };
    presented = shown;
    const coordinator = host.coordinator();
    if (!coordinator) {
      host.onError(`${prompt.request.title} could not open: the dialog host is unavailable.`);
      finish(prompt, shown, { status: "cancelled" });
      return;
    }
    void coordinator.promptPluginText(tab.id, data, abort.signal, update => { shown.update = update; })
      .catch(() => ({ status: "cancelled" }) as const)
      .then(result => finish(prompt, shown, result));
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
