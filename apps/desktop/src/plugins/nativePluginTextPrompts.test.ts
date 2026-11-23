import { describe, expect, it, vi } from "vitest";
import { DialogCoordinator, type PluginTextPromptResult, type PluginTextPromptState } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, pluginTextPromptValueFits, type DialogMessage, type PluginTextPromptSnapshot } from "../dialogs/dialogProtocol";
import type { DialogTransport } from "../dialogs/dialogTransport";
import { PluginPromptTextController } from "./PluginPromptTextController";
import { PLUGIN_TEXT_PROMPT_CLIPPED_DRAFT_LINE, presentPluginTextPromptsNatively } from "./nativePluginTextPrompts";

interface Shown { tabId: string; data: PluginTextPromptSnapshot; signal?: AbortSignal; updates: PluginTextPromptState[];
  answer(result: PluginTextPromptResult): void }

/** Two tabs: "doc-a" is open in tab-1 ("Drawing 1"), "doc-b" in tab-2 ("Drawing 2"). */
function fakeHost({ available = true }: { available?: boolean } = {}) {
  const shown: Shown[] = [];
  const tabs = new Map([["doc-a", { id: "tab-1", title: "Drawing 1" }], ["doc-b", { id: "tab-2", title: "Drawing 2" }]]);
  const view = { activeTabId: "tab-1" };
  const coordinator = {
    promptPluginText: vi.fn((tabId: string, data: PluginTextPromptSnapshot, signal?: AbortSignal,
      onOpen?: (update: (state: PluginTextPromptState) => Promise<void>) => void) =>
      new Promise<PluginTextPromptResult>(resolve => {
        const entry: Shown = { tabId, data, signal, updates: [], answer: resolve };
        onOpen?.(async state => { entry.updates.push(state); });
        shown.push(entry);
        // Like the coordinator: an aborted request closes its window and resolves as cancelled.
        signal?.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }))
  };
  const onError = vi.fn();
  const host = {
    coordinator: () => available ? coordinator : undefined,
    documentTab: (key: string | undefined) => key === undefined ? [...tabs.values()].find(tab => tab.id === view.activeTabId) : tabs.get(key),
    activeTabId: () => view.activeTabId,
    onError
  };
  return { shown, coordinator, onError, host, tabs, view };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("presentPluginTextPromptsNatively", () => {
  it("shows queued prompts from two plugins one window at a time, in order, with independent answers", async () => {
    const prompts = new PluginPromptTextController();
    const { shown, host } = fakeHost();
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const first = prompts.promptText({ id: "org.test.first", name: "First" },
      { title: "Structure from Name", label: "Chemical name", placeholder: "e.g. aspirin", maxLength: 500 }, new AbortController().signal);
    const second = prompts.promptText({ id: "org.test.second", name: "Second" },
      { title: "Second question", label: "Value", initialValue: "seed", submitLabel: "Go", maxLength: 20 }, new AbortController().signal);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ tabId: "tab-1", data: { title: "Structure from Name", label: "Chemical name",
      placeholder: "e.g. aspirin", initialValue: "", submitLabel: "Submit", maxLength: 500, pluginName: "First", pluginId: "org.test.first" } });

    shown[0]!.answer({ status: "submitted", value: "  benzene  " });
    await expect(first).resolves.toEqual({ status: "submitted", value: "  benzene  " });
    await settle();
    expect(shown).toHaveLength(2);
    expect(shown[1]!.data).toMatchObject({ pluginName: "Second", initialValue: "seed", submitLabel: "Go", maxLength: 20 });

    shown[1]!.answer({ status: "cancelled" });
    await expect(second).resolves.toEqual({ status: "cancelled" });
    await settle();
    expect(shown).toHaveLength(2);
    expect(prompts.getOpenPrompt()).toBeUndefined();
    stop();
  });

  it("closes the window when the plugin's request ends and moves on to the next prompt", async () => {
    const prompts = new PluginPromptTextController();
    const { shown, host } = fakeHost();
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const request = new AbortController();
    const first = prompts.promptText({ id: "org.test.first", name: "First" }, { title: "A", label: "A", maxLength: 10 }, request.signal);
    const second = prompts.promptText({ id: "org.test.second", name: "Second" }, { title: "B", label: "B", maxLength: 10 }, new AbortController().signal);
    request.abort();
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(shown[0]!.signal?.aborted).toBe(true);
    expect(shown).toHaveLength(2);
    expect(shown[1]!.data.pluginName).toBe("Second");
    shown[1]!.answer({ status: "submitted", value: "b" });
    await expect(second).resolves.toEqual({ status: "submitted", value: "b" });
    stop();
  });

  it("cancels the plugin's request when the dialog host is unavailable", async () => {
    const prompts = new PluginPromptTextController();
    const { host, onError } = fakeHost({ available: false });
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const answer = prompts.promptText({ id: "org.test.first", name: "First" }, { title: "Ask", label: "A", maxLength: 10 }, new AbortController().signal);
    await expect(answer).resolves.toEqual({ status: "cancelled" });
    expect(onError).toHaveBeenCalledWith("Ask could not open: the dialog host is unavailable.");
    stop();
  });

  it("closes the open window and cancels its request when the document window stops presenting", async () => {
    const prompts = new PluginPromptTextController();
    const { shown, host } = fakeHost();
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const answer = prompts.promptText({ id: "org.test.first", name: "First" }, { title: "Ask", label: "A", maxLength: 10 }, new AbortController().signal);
    stop();
    expect(shown[0]!.signal?.aborted).toBe(true);
    await expect(answer).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps a prompt open with Submit off while another tab is active, and cancels it when its tab closes", async () => {
    let activeKey = "doc-a";
    const prompts = new PluginPromptTextController(() => activeKey);
    const { shown, host, tabs, view } = fakeHost();
    const activate = (tabId: string, key: string) => { view.activeTabId = tabId; activeKey = key; prompts.activeDocumentChanged(); };
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const ask = (title: string, documentKey?: string) => prompts.promptText({ id: `org.test.${title}`, name: title },
      { title, label: title, maxLength: 10 }, new AbortController().signal, documentKey);
    const first = ask("A", "doc-a");
    const firstId = prompts.getOpenPrompt()!.id;
    expect(shown[0]).toMatchObject({ tabId: "tab-1" });
    expect(shown[0]!.data).not.toHaveProperty("submitEnabled");

    // Switching tabs keeps the same window open; Submit goes off with one line naming the prompt's tab.
    activate("tab-2", "doc-b");
    expect(shown[0]!.signal?.aborted).toBe(false);
    expect(shown[0]!.updates).toEqual([{ submitEnabled: false, statusLine: "Switch back to Drawing 1 to insert." }]);
    prompts.activeDocumentChanged();
    expect(shown[0]!.updates).toHaveLength(1);
    // An answer arriving while tab-2 is active is refused and the prompt stays open.
    prompts.submit(firstId, "benzene");
    expect(prompts.getOpenPrompt()?.id).toBe(firstId);

    // Switching back turns Submit on again; the answer then reaches the plugin.
    activate("tab-1", "doc-a");
    expect(shown[0]!.updates[1]).toEqual({});
    shown[0]!.answer({ status: "submitted", value: "benzene" });
    await expect(first).resolves.toEqual({ status: "submitted", value: "benzene" });

    // A prompt asked from tab-1 while tab-2 is active opens on tab-1's window with Submit already off.
    activate("tab-2", "doc-b");
    const second = ask("B", "doc-a");
    await settle();
    expect(shown[1]).toMatchObject({ tabId: "tab-1", data: { submitEnabled: false, statusLine: "Switch back to Drawing 1 to insert." } });
    // Closing tab-1 (or replacing its document) ends it as cancelled and closes the window.
    tabs.delete("doc-a");
    prompts.cancelDocument("doc-a");
    expect(shown[1]!.signal?.aborted).toBe(true);
    await expect(second).resolves.toEqual({ status: "cancelled" });
    // A prompt whose tab is already gone is cancelled without being shown.
    await expect(ask("C", "doc-a")).resolves.toEqual({ status: "cancelled" });
    await settle();
    expect(shown).toHaveLength(2);

    // The window going away (no active document) cancels document-bound prompts only.
    const bound = ask("D", "doc-b");
    const unbound = ask("E");
    prompts.cancelDocument(null);
    await expect(bound).resolves.toEqual({ status: "cancelled" });
    await settle();
    expect(prompts.getOpenPrompt()?.request.title).toBe("E");
    shown.at(-1)!.answer({ status: "submitted", value: "e" });
    await expect(unbound).resolves.toEqual({ status: "submitted", value: "e" });
    stop();
  });

  it("keeps a prompt answered just before its tab lost focus, and shows it again with the typed text", async () => {
    let activeKey = "doc-a";
    const prompts = new PluginPromptTextController(() => activeKey);
    const { shown, host, view } = fakeHost();
    const activate = (tabId: string, key: string) => { view.activeTabId = tabId; activeKey = key; prompts.activeDocumentChanged(); };
    const stop = presentPluginTextPromptsNatively(prompts, host);
    const answer = prompts.promptText({ id: "org.test.first", name: "First" },
      { title: "Ask", label: "A", initialValue: "seed", maxLength: 20 }, new AbortController().signal, "doc-a");
    const id = prompts.getOpenPrompt()!.id;
    // The user submits on tab-1; while the coordinator is still closing that window, tab-2 becomes active
    // and the answer reaches the controller only afterwards, which refuses it.
    activate("tab-2", "doc-b");
    shown[0]!.answer({ status: "submitted", value: "benzene" });
    await settle();
    expect(prompts.getOpenPrompt()?.id).toBe(id);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toMatchObject({ tabId: "tab-1",
      data: { initialValue: "benzene", submitEnabled: false, statusLine: "Switch back to Drawing 1 to insert." } });
    expect(shown[1]!.signal?.aborted).toBe(false);

    // Back on its own tab the answer goes through; a later window for the same prompt starts from the request again.
    activate("tab-1", "doc-a");
    expect(shown[1]!.updates).toEqual([{}]);
    shown[1]!.answer({ status: "submitted", value: "benzene" });
    await expect(answer).resolves.toEqual({ status: "submitted", value: "benzene" });
    stop();
  });

  it("never loses part of an answer the snapshot bound has to clip when the prompt is shown again", async () => {
    // The real coordinator and snapshot bound, so the reopened window holds only what the channel carries.
    let activeKey = "doc-a";
    const prompts = new PluginPromptTextController(() => activeKey);
    const { host, view } = fakeHost();
    const activate = (tabId: string, key: string) => { view.activeTabId = tabId; activeKey = key; prompts.activeDocumentChanged(); };
    let opened = 0;
    let onClose: (() => void) | undefined;
    const transport: DialogTransport = {
      subscribe: vi.fn(async () => vi.fn()),
      open: vi.fn(async () => ({ hostId: `host-${++opened}`, windowLabel: `dialog-main-pluginTextPrompt-${opened}` })),
      publish: vi.fn(async () => {}),
      close: vi.fn(async () => { const run = onClose; onClose = undefined; run?.(); })
    };
    const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }, { readyTimeoutMs: 1000 });
    const snapshotAt = (index: number) => vi.mocked(transport.open).mock.calls[index]![0] as Extract<DialogMessage, { type: "snapshot" }>;
    const deliver = (index: number, type: DialogMessage["type"], data: unknown) => coordinator.receive({
      message: { ...dialogEnvelope(snapshotAt(index)), requestId: crypto.randomUUID(), type, data } as DialogMessage,
      senderWindowId: `dialog-main-pluginTextPrompt-${index + 1}`, windowLabel: `dialog-main-pluginTextPrompt-${index + 1}` });
    const stop = presentPluginTextPromptsNatively(prompts, { ...host, coordinator: () => coordinator });
    const answer = prompts.promptText({ id: "org.test.first", name: "First" },
      { title: "Ask", label: "A", maxLength: 2000 }, new AbortController().signal, "doc-a");
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    await deliver(0, "ready", {});

    // A valid answer the action budget accepts, but longer than a snapshot can carry back as its initial value.
    const full = "語".repeat(933);
    expect(pluginTextPromptValueFits(full, 2000)).toBe(true);
    // Tab-2 becomes active while the submitted window is closing, so the controller refuses the answer.
    onClose = () => activate("tab-2", "doc-b");
    await deliver(0, "action", { action: "submit", value: full });
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(2));
    const reopened = snapshotAt(1).data as PluginTextPromptSnapshot;
    expect(reopened.statusLine).toBe("Switch back to Drawing 1 to insert.");
    expect(reopened.initialValue.length).toBeLessThan(full.length);
    expect(full.startsWith(reopened.initialValue)).toBe(true);
    await deliver(1, "ready", {});

    // Back on its own tab, Submit is on and one line says the whole answer is kept.
    activate("tab-1", "doc-a");
    await vi.waitFor(() => expect(vi.mocked(transport.publish).mock.calls.at(-1)?.[1]).toMatchObject({
      data: { initialValue: reopened.initialValue, statusLine: PLUGIN_TEXT_PROMPT_CLIPPED_DRAFT_LINE } }));
    expect((vi.mocked(transport.publish).mock.calls.at(-1)![1] as { data: PluginTextPromptSnapshot }).data).not.toHaveProperty("submitEnabled");
    // No later state change clips the draft the window opened with.
    for (const [hostId, message] of vi.mocked(transport.publish).mock.calls)
      if (hostId === "host-2") expect((message as { data: PluginTextPromptSnapshot }).data.initialValue).toBe(reopened.initialValue);
    // Submitting the shown draft unchanged delivers every character of the accepted answer.
    await deliver(1, "action", { action: "submit", value: reopened.initialValue });
    await expect(answer).resolves.toEqual({ status: "submitted", value: full });

    // An edited draft is sent exactly as the user left it.
    const edited = prompts.promptText({ id: "org.test.second", name: "Second" },
      { title: "Ask", label: "A", maxLength: 2000 }, new AbortController().signal, "doc-a");
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(3));
    await deliver(2, "ready", {});
    onClose = () => activate("tab-2", "doc-b");
    await deliver(2, "action", { action: "submit", value: full });
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(4));
    await deliver(3, "ready", {});
    activate("tab-1", "doc-a");
    const shortened = `${(snapshotAt(3).data as PluginTextPromptSnapshot).initialValue}!`;
    await deliver(3, "action", { action: "submit", value: shortened });
    await expect(edited).resolves.toEqual({ status: "submitted", value: shortened });
    stop();
    await coordinator.dispose();
  });
});
