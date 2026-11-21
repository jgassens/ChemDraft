import { describe, expect, it, vi } from "vitest";
import type { PluginTextPromptResult, PluginTextPromptState } from "../dialogs/DialogCoordinator";
import type { PluginTextPromptSnapshot } from "../dialogs/dialogProtocol";
import { PluginPromptTextController } from "./PluginPromptTextController";
import { presentPluginTextPromptsNatively } from "./nativePluginTextPrompts";

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
});
