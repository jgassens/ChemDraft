import { describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "./DialogCoordinator";
import {
  boundedPluginTextPromptSnapshot, dialogEnvelope, parseDialogMessage, pluginTextPromptValueFits,
  PLUGIN_TEXT_PROMPT_MAX_BYTES, type DialogMessage, type PluginTextPromptSnapshot
} from "./dialogProtocol";
import type { DialogTransport } from "./dialogTransport";

const prompt = (overrides: Partial<PluginTextPromptSnapshot> = {}): PluginTextPromptSnapshot => ({
  title: "Structure from Name", label: "Chemical name", placeholder: "e.g. aspirin", initialValue: "",
  submitLabel: "Insert", maxLength: 500, pluginName: "Name to Structure (OPSIN)", pluginId: "org.chemdraft.opsin", ...overrides
});
const envelope = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-1", dialogKind: "pluginTextPrompt",
  sessionId: "session-1", requestId: "request-1", snapshotRevision: 1 } as const;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("pluginTextPrompt contract", () => {
  it("accepts the normalized request and rejects unknown fields, missing fields and out-of-range limits", () => {
    const good = { ...envelope, type: "snapshot", data: prompt() };
    expect(parseDialogMessage(good)).toEqual(good);
    expect(parseDialogMessage({ ...good, data: prompt({ placeholder: "", initialValue: "" }) })).toBeDefined();
    expect(parseDialogMessage({ ...good, data: prompt({ title: "x".repeat(200), maxLength: 2000 }) })).toBeDefined();
    expect(parseDialogMessage({ ...good, data: prompt({ statusLine: "x".repeat(200), submitEnabled: false }) })).toBeDefined();
    const { placeholder: _omitted, ...missing } = prompt();
    for (const data of [
      { ...prompt(), path: "/private" }, missing,
      prompt({ title: "" }), prompt({ title: "x".repeat(201) }), prompt({ label: "" }), prompt({ label: "x".repeat(201) }),
      prompt({ placeholder: "x".repeat(201) }), prompt({ submitLabel: "" }), prompt({ submitLabel: "x".repeat(201) }),
      prompt({ maxLength: 0 }), prompt({ maxLength: 2001 }), prompt({ maxLength: 1.5 }),
      prompt({ maxLength: 4, initialValue: "12345" }), prompt({ pluginName: "" }), prompt({ pluginName: "x".repeat(129) }),
      prompt({ pluginId: "" }), prompt({ title: "a\0b" }), { ...prompt(), maxLength: "500" },
      prompt({ statusLine: "" }), prompt({ statusLine: "x".repeat(201) }), { ...prompt(), statusLine: null },
      { ...prompt(), submitEnabled: "false" }, { ...prompt(), submitEnabled: null }
    ]) expect(parseDialogMessage({ ...good, data })).toBeUndefined();
    expect(parseDialogMessage({ ...good, type: "result", data: { status: "accepted" } })).toBeUndefined();
  });

  it("accepts only submit with a bounded value and cancel as actions", () => {
    const action = (data: unknown) => parseDialogMessage({ ...envelope, type: "action", data });
    expect(action({ action: "submit", value: "  benzene  " })).toBeDefined();
    expect(action({ action: "submit", value: "x".repeat(2000) })).toBeDefined();
    expect(action({ action: "cancel" })).toBeDefined();
    for (const data of [{ action: "submit", value: "" }, { action: "submit", value: "x".repeat(2001) }, { action: "submit" },
      { action: "submit", value: 3 }, { action: "submit", value: "a", extra: true }, { action: "cancel", value: "a" },
      { action: "apply", value: "a" }, { action: "enlarge" }, { action: "submit", value: "a\0" }])
      expect(action(data)).toBeUndefined();
    // Multibyte answers longer than the channel budget fail closed rather than reaching the owner truncated.
    expect(action({ action: "submit", value: "語".repeat(1500) })).toBeUndefined();
  });

  it("fits any normalized request inside the native message budget, keeping the initial value first", () => {
    const worstEnvelope = { ...envelope, documentTabId: "x".repeat(128), sessionId: "x".repeat(128), requestId: "x".repeat(128),
      snapshotRevision: Number.MAX_SAFE_INTEGER };
    const huge = prompt({ title: "題".repeat(200), label: "標".repeat(200), placeholder: "例".repeat(200), submitLabel: "挿".repeat(200),
      pluginName: "名".repeat(500), pluginId: "i".repeat(400), maxLength: 2000, initialValue: "a".repeat(2000) });
    const bounded = boundedPluginTextPromptSnapshot(huge);
    const message = { ...worstEnvelope, type: "snapshot", data: bounded };
    expect(bytes(message)).toBeLessThanOrEqual(PLUGIN_TEXT_PROMPT_MAX_BYTES);
    expect(parseDialogMessage(message)).toEqual(message);
    expect(bounded.initialValue).toBe("a".repeat(2000));
    for (const field of ["title", "label", "pluginName", "pluginId", "submitLabel"] as const) expect(bounded[field].length).toBeGreaterThan(0);
    // An ordinary request is passed through unchanged.
    expect(boundedPluginTextPromptSnapshot(prompt())).toEqual(prompt());
    // A multibyte initial value too large for the channel is clipped on a code point boundary.
    const emoji = boundedPluginTextPromptSnapshot(prompt({ maxLength: 2000, initialValue: "😀".repeat(1000) }));
    expect(emoji.initialValue.length).toBeLessThan(2000);
    expect([...emoji.initialValue].every(character => character === "😀")).toBe(true);
    expect(bytes({ ...worstEnvelope, type: "snapshot", data: emoji })).toBeLessThanOrEqual(PLUGIN_TEXT_PROMPT_MAX_BYTES);
  });

  it("always delivers the documented 1,600 bytes of initial value and accepts answers of about 2,800 bytes", () => {
    // The limits PluginDialogsAPI.promptText and AUTHORING.md state, with every other field at its worst.
    const worstEnvelope = { ...envelope, documentTabId: "x".repeat(128), sessionId: "x".repeat(128), requestId: "x".repeat(128),
      snapshotRevision: Number.MAX_SAFE_INTEGER };
    const worst = (initialValue: string) => boundedPluginTextPromptSnapshot(prompt({ title: "題".repeat(200), label: "標".repeat(200),
      placeholder: "例".repeat(200), submitLabel: "挿".repeat(200), pluginName: "名".repeat(128), pluginId: "i".repeat(256),
      maxLength: 2000, statusLine: "状".repeat(200), submitEnabled: false, initialValue }));
    for (const initialValue of ["a".repeat(1600), "語".repeat(533)]) {
      const bounded = worst(initialValue);
      expect(bounded.initialValue).toBe(initialValue);
      expect(bytes({ ...worstEnvelope, type: "snapshot", data: bounded })).toBeLessThanOrEqual(PLUGIN_TEXT_PROMPT_MAX_BYTES);
    }
    expect(pluginTextPromptValueFits("語".repeat(933), 2000)).toBe(true);
    expect(pluginTextPromptValueFits("語".repeat(934), 2000)).toBe(false);
  });

  it("checks a submitted value against the request's limit and the channel budget", () => {
    expect(pluginTextPromptValueFits("benzene", 500)).toBe(true);
    expect(pluginTextPromptValueFits("", 500)).toBe(false);
    expect(pluginTextPromptValueFits("x".repeat(11), 10)).toBe(false);
    expect(pluginTextPromptValueFits("x".repeat(2000), 2000)).toBe(true);
    expect(pluginTextPromptValueFits("語".repeat(1500), 2000)).toBe(false);
  });
});

function host() {
  let opened = 0;
  const transport: DialogTransport = {
    subscribe: vi.fn(async () => vi.fn()),
    open: vi.fn(async () => ({ hostId: `host-${++opened}`, windowLabel: `dialog-main-pluginTextPrompt-${opened}` })),
    publish: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  };
  const owner = { applyPageSize: vi.fn(), onError: vi.fn(), onSettled: vi.fn(), onPluginTextPromptClosed: vi.fn() };
  const coordinator = new DialogCoordinator(transport, owner, { readyTimeoutMs: 1000 });
  const snapshotAt = (index: number) => vi.mocked(transport.open).mock.calls[index]![0] as Extract<DialogMessage, { type: "snapshot" }>;
  const deliver = (index: number, type: DialogMessage["type"], data: unknown, sender = `dialog-main-pluginTextPrompt-${index + 1}`) =>
    coordinator.receive({ message: { ...dialogEnvelope(snapshotAt(index)), requestId: crypto.randomUUID(), type, data } as DialogMessage,
      senderWindowId: sender, windowLabel: `dialog-main-pluginTextPrompt-${index + 1}` });
  return { transport, owner, coordinator, snapshotAt, deliver };
}

describe("DialogCoordinator.promptPluginText", () => {
  it("opens a native session with the prompt snapshot and resolves Submit with the exact text", async () => {
    const h = host();
    const answer = h.coordinator.promptPluginText("tab-1", prompt());
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    expect(h.snapshotAt(0)).toMatchObject({ dialogKind: "pluginTextPrompt", documentTabId: "tab-1", type: "snapshot", data: prompt() });
    await h.deliver(0, "ready", {});
    await h.deliver(0, "action", { action: "submit", value: "  benzene  " });
    await expect(answer).resolves.toEqual({ status: "submitted", value: "  benzene  " });
    expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("host-1", "apply");
    expect(h.owner.onPluginTextPromptClosed).toHaveBeenCalledExactlyOnceWith("tab-1");
    await h.coordinator.dispose();
  });

  it("resolves Cancel (also Escape and Cmd+. in the form) and the title-bar close as cancelled", async () => {
    for (const close of [
      (h: ReturnType<typeof host>) => h.deliver(0, "action", { action: "cancel" }),
      (h: ReturnType<typeof host>) => h.deliver(0, "closed", { reason: "close" }, "main")
    ]) {
      const h = host();
      const answer = h.coordinator.promptPluginText("tab-1", prompt());
      await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
      await h.deliver(0, "ready", {});
      await close(h);
      await expect(answer).resolves.toEqual({ status: "cancelled" });
      expect(h.owner.onPluginTextPromptClosed).toHaveBeenCalledExactlyOnceWith("tab-1");
      await h.coordinator.dispose();
    }
  });

  it("ignores forged senders, answers over the request's limit and actions before ready", async () => {
    const h = host();
    let settled = false;
    const answer = h.coordinator.promptPluginText("tab-1", prompt({ maxLength: 5 }));
    void answer.then(() => { settled = true; });
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    await h.deliver(0, "action", { action: "submit", value: "early" });
    await h.deliver(0, "ready", {});
    await h.deliver(0, "action", { action: "submit", value: "forged" }, "dialog-main-pageSize-1");
    await h.deliver(0, "action", { action: "submit", value: "toolong" });
    await Promise.resolve();
    expect(settled).toBe(false);
    await h.deliver(0, "action", { action: "submit", value: "short" });
    await expect(answer).resolves.toEqual({ status: "submitted", value: "short" });
    await h.coordinator.dispose();
  });

  it("closes the window when the request aborts and ignores a late Submit", async () => {
    const h = host();
    const abort = new AbortController();
    const answer = h.coordinator.promptPluginText("tab-1", prompt(), abort.signal);
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    await h.deliver(0, "ready", {});
    abort.abort();
    await expect(answer).resolves.toEqual({ status: "cancelled" });
    expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("host-1", "cancel");
    await h.deliver(0, "action", { action: "submit", value: "late" });
    expect(h.transport.close).toHaveBeenCalledOnce();
    await h.coordinator.dispose();
  });

  it("closes a window that registers only after its request aborted", async () => {
    const h = host();
    let register!: (value: { hostId: string; windowLabel: string }) => void;
    vi.mocked(h.transport.open).mockImplementation(() => new Promise(resolve => { register = resolve; }));
    const abort = new AbortController();
    const answer = h.coordinator.promptPluginText("tab-1", prompt(), abort.signal);
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    abort.abort();
    register({ hostId: "late", windowLabel: "dialog-main-pluginTextPrompt-1" });
    await expect(answer).resolves.toEqual({ status: "cancelled" });
    expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("late", "cancel");
    expect(h.owner.onPluginTextPromptClosed).not.toHaveBeenCalled();
    await h.coordinator.dispose();
  });

  it("does not open for an already-aborted request and cancels when its tab closes", async () => {
    const h = host();
    const aborted = new AbortController();
    aborted.abort();
    await expect(h.coordinator.promptPluginText("tab-1", prompt(), aborted.signal)).resolves.toEqual({ status: "cancelled" });
    expect(h.transport.open).not.toHaveBeenCalled();
    const answer = h.coordinator.promptPluginText("tab-1", prompt());
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    await h.deliver(0, "ready", {});
    await h.coordinator.closeTab("tab-1");
    await expect(answer).resolves.toEqual({ status: "cancelled" });
    expect(h.transport.close).toHaveBeenCalledExactlyOnceWith("host-1", "ownerTabClose");
    expect(h.owner.onPluginTextPromptClosed).not.toHaveBeenCalled();
    await h.coordinator.dispose();
  });

  it("keeps two prompts for one drawing in independent sessions with independent answers", async () => {
    const h = host();
    const first = h.coordinator.promptPluginText("tab-1", prompt({ pluginName: "First" }));
    const second = h.coordinator.promptPluginText("tab-1", prompt({ pluginName: "Second" }));
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledTimes(2));
    expect(h.snapshotAt(0).sessionId).not.toBe(h.snapshotAt(1).sessionId);
    await h.deliver(0, "ready", {});
    await h.deliver(1, "ready", {});
    await h.deliver(1, "action", { action: "submit", value: "two" });
    await expect(second).resolves.toEqual({ status: "submitted", value: "two" });
    await h.deliver(0, "action", { action: "cancel" });
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await h.coordinator.dispose();
  });

  it("turns Submit off and on in place while the window stays open, refusing an answer while it is off", async () => {
    const h = host();
    let update!: (state: { statusLine?: string; submitEnabled?: boolean }) => Promise<void>;
    let settled = false;
    const answer = h.coordinator.promptPluginText("tab-1", prompt(), undefined, value => { update = value; });
    void answer.then(() => { settled = true; });
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    await h.deliver(0, "ready", {});
    const off = { statusLine: "Switch back to Drawing 1 to insert.", submitEnabled: false };
    await update(off);
    // The same session and revision, so the window keeps the user's draft; only the state changes.
    expect(h.transport.publish).toHaveBeenLastCalledWith("host-1", { ...h.snapshotAt(0), data: { ...prompt(), ...off } });
    await h.deliver(0, "action", { action: "submit", value: "benzene" });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.transport.close).not.toHaveBeenCalled();
    await update({});
    expect(h.transport.publish).toHaveBeenLastCalledWith("host-1", { ...h.snapshotAt(0), data: prompt() });
    await h.deliver(0, "action", { action: "submit", value: "benzene" });
    await expect(answer).resolves.toEqual({ status: "submitted", value: "benzene" });
    await h.coordinator.dispose();
  });

  it("publishes a state change made while the window was still opening", async () => {
    const h = host();
    let register!: (value: { hostId: string; windowLabel: string }) => void;
    vi.mocked(h.transport.open).mockImplementation(() => new Promise(resolve => { register = resolve; }));
    let update!: (state: { statusLine?: string; submitEnabled?: boolean }) => Promise<void>;
    const answer = h.coordinator.promptPluginText("tab-1", prompt(), undefined, value => { update = value; });
    await vi.waitFor(() => expect(h.transport.open).toHaveBeenCalledOnce());
    await update({ statusLine: "Switch back to Drawing 1 to insert.", submitEnabled: false });
    expect(h.transport.publish).not.toHaveBeenCalled();
    register({ hostId: "host-1", windowLabel: "dialog-main-pluginTextPrompt-1" });
    await vi.waitFor(() => expect(h.transport.publish).toHaveBeenCalledOnce());
    expect(vi.mocked(h.transport.publish).mock.calls[0]![1]).toMatchObject({ data: { submitEnabled: false } });
    await h.deliver(0, "ready", {});
    await h.deliver(0, "action", { action: "cancel" });
    await expect(answer).resolves.toEqual({ status: "cancelled" });
    await h.coordinator.dispose();
  });
});
