// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { allShellCommands, createCustomSwatchActions } from "./commands";
import { allCustomSwatchCommandIds, customSwatchCommandId, loadCustomSwatches, setCustomSwatchSlot } from "./customColorSwatches";
import { createPhase4Document, insertNativeSingleBondMolecule } from "./documentWorkflow";
import { APPENDABLE_TOOLBAR_WIDGETS, TOOLBAR_WIDGET_TITLES } from "./ToolPalette";
import { createDesktopToolsetRegistry, getToolsetItemGroups } from "./toolsets";
import { buildGallerySections } from "./toolbars/CustomizeMainToolbar/galleryModel";
import { applyToolsetLayoutEdit } from "./toolbars/CustomizeMainToolbar/applyLayoutEdit";
import { emptyLayoutState } from "./toolbars/CustomizeToolbars/layoutStateEdits";
import { TOOLBAR_WIDGET_GRID_SPANS } from "./toolbars/toolbarWidgets";
import { parseToolsetLayoutState } from "@chemdraft/toolset-registry";
import { DialogCoordinator } from "./dialogs/DialogCoordinator";
import { dialogEnvelope, parseDialogMessage, type DialogMessage } from "./dialogs/dialogProtocol";
import type { DialogTransport } from "./dialogs/dialogTransport";

describe("custom color swatch commands and toolbar layout", () => {
  const empty = loadCustomSwatches({ getItem: () => null, setItem: () => {} });
  const set = setCustomSwatchSlot(empty, 1, 2, "#1f5fbf");
  it("registers the complete finite family in the shell with human titles and availability reasons", () => {
    const document = createPhase4Document("Colors");
    const ids = new Set(allCustomSwatchCommandIds());
    const commands = allShellCommands(document, undefined, { customSwatches: set }).filter(command => ids.has(command.id));
    expect(commands.map(command => command.id)).toEqual([...ids]);
    const get = (action: "apply" | "edit" | "clear", slot: 1 | 2 = 2) => commands.find(command => command.id === customSwatchCommandId(1, slot, action))!;
    expect(get("apply")).toMatchObject({ title: "Apply Custom Color 1, Slot 2", enabled: false, disabledReason: "Select an object to change its color" });
    expect(get("edit")).toMatchObject({ title: "Edit Custom Color 1, Slot 2…", enabled: true });
    expect(get("clear")).toMatchObject({ title: "Clear Custom Color 1, Slot 2", enabled: true });
    expect(get("clear", 1)).toMatchObject({ enabled: false, disabledReason: "This custom color is empty" });
    expect(get("apply", 1)).toMatchObject({ enabled: false, disabledReason: "Set this custom color first" });
    const selected = insertNativeSingleBondMolecule(document, { x: 100, y: 100 });
    expect(allShellCommands(selected, undefined, { customSwatches: set }).find(command => command.id === get("apply").id))
      .toMatchObject({ enabled: true, disabledReason: undefined });
    expect(allShellCommands(document, undefined, { customSwatches: set, availability: { hasMoleculeFragmentSelection: true } })
      .find(command => command.id === get("apply").id)?.enabled).toBe(true);
    expect(createCustomSwatchActions(empty, false).filter(command => command.id.endsWith(".edit")).every(command => command.enabled)).toBe(true);
  });

  it("offers four widgets in Object Style, hides their internal commands and keeps defaults unchanged", () => {
    const sections = buildGallerySections(createCustomSwatchActions(set, true), APPENDABLE_TOOLBAR_WIDGETS, new Set(), "");
    expect(sections.find(section => section.id === "objectStyle")?.entries.map(entry => entry.title))
      .toEqual([1, 2, 3, 4].map(n => `Custom Color Swatch ${n}`));
    expect(sections.flatMap(section => section.entries).filter(entry => entry.kind === "command")).toHaveLength(0);
    expect(getToolsetItemGroups("core.main").flat().some(item => item.id.includes("customColorSwatch"))).toBe(false);
  });

  it("saves and reloads two independently placed two-slot grid widgets", () => {
    let layout = emptyLayoutState();
    for (const n of [1, 3]) layout = applyToolsetLayoutEdit(layout, {
      target: { windowId: "main", tabId: "tab-fixture" },
      toolsetId: "core.main", edit: { kind: "addWidget", groupId: "core.main.items", widgetId: `widget.core.customColorSwatch${n}`, index: n }
    }, { presentItemIds: new Set(), commandTitle: () => undefined, widgetTitle: id => TOOLBAR_WIDGET_TITLES[id], widgetLayout: id => TOOLBAR_WIDGET_GRID_SPANS[id] });
    const loaded = parseToolsetLayoutState(JSON.parse(JSON.stringify(layout)));
    const items = getToolsetItemGroups("core.main", createDesktopToolsetRegistry(loaded)).flat().filter(item => item.id.includes("customColorSwatch"));
    expect(items.map(item => item.id)).toEqual(["widget.core.customColorSwatch1", "widget.core.customColorSwatch3"]);
    expect(items.every(item => item.primary.type === "control" && item.layout.colSpan === 2 && item.layout.rowSpan === 1)).toBe(true);
  });
});

describe("customColor dialog contract", () => {
  const snapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "customColor", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot",
    data: { title: "Custom Color 1, Slot 2", swatch: 1, slot: 2, color: "#1f5fbf" } } as const;
  it("accepts only strict snapshots and actions", () => {
    expect(parseDialogMessage(snapshot)).toBeDefined();
    expect(parseDialogMessage({ ...snapshot, data: { ...snapshot.data, color: null } })).toBeDefined();
    for (const data of [{ ...snapshot.data, swatch: 0 }, { ...snapshot.data, slot: 3 }, { ...snapshot.data, color: "#abcd" },
      { ...snapshot.data, color: "#123456\n" }, { ...snapshot.data, color: "#ABCDEF" }, { ...snapshot.data, extra: true },
      { title: "Color", swatch: 1, slot: 2 }, { ...snapshot.data, title: "bad\0title" }]) expect(parseDialogMessage({ ...snapshot, data })).toBeUndefined();
    for (const data of [{ action: "apply", hex: "#123456" }, { action: "clear" }, { action: "cancel" }]) expect(parseDialogMessage({ ...snapshot, type: "action", data })).toBeDefined();
    for (const data of [{ action: "apply", hex: "#abc" }, { action: "clear", slot: 2 }, { action: "apply", hex: "#123456", swatch: 1 }]) expect(parseDialogMessage({ ...snapshot, type: "action", data })).toBeUndefined();
  });

  it("stores through the owner, deduplicates OK, and targets the retained slot on Clear", async () => {
    const transport: DialogTransport = { subscribe: vi.fn(async () => () => {}), open: vi.fn(async () => ({ hostId: "host", windowLabel: "dialog-main-customColor-1" })), publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const owner = { applyPageSize: vi.fn(), saveCustomColor: vi.fn(), clearCustomColor: vi.fn(), onError: vi.fn() };
    const coordinator = new DialogCoordinator(transport, owner);
    const send = async (type: "ready" | "action", data: unknown) => {
      const s = vi.mocked(transport.open).mock.calls.at(-1)![0];
      await coordinator.receive({ senderWindowId: "dialog-main-customColor-1", windowLabel: "dialog-main-customColor-1", message: { ...dialogEnvelope(s), requestId: crypto.randomUUID(), type, data } });
    };
    try {
      await coordinator.openCustomColor("tab", snapshot.data); await send("ready", {});
      await Promise.all([send("action", { action: "apply", hex: "#abcdef" }), send("action", { action: "apply", hex: "#abcdef" })]);
      expect(owner.saveCustomColor).toHaveBeenCalledExactlyOnceWith(snapshot.data, "#abcdef");
      expect(owner.applyPageSize).not.toHaveBeenCalled();
      await coordinator.openCustomColor("tab", snapshot.data); await send("ready", {}); await send("action", { action: "clear" });
      expect(owner.clearCustomColor).toHaveBeenCalledExactlyOnceWith(snapshot.data);
      expect(owner.onError).not.toHaveBeenCalled();
    } finally { await coordinator.dispose(); }
  });

  it("switches the requested slot without reusing a draft for the previous slot", async () => {
    const transport: DialogTransport = { subscribe: async () => () => {}, open: vi.fn(async () => ({ hostId: "host", windowLabel: "dialog-main-customColor-1" })), publish: async () => {}, close: vi.fn(async () => {}) };
    const coordinator = new DialogCoordinator(transport, { applyPageSize: () => {}, onError: vi.fn() });
    try {
      await coordinator.openCustomColor("tab", snapshot.data);
      await coordinator.openCustomColor("tab", { ...snapshot.data, slot: 1 });
      expect(transport.close).toHaveBeenCalledOnce();
      expect(vi.mocked(transport.open).mock.calls.at(-1)![0]).toMatchObject({ data: { slot: 1 } });
    } finally { await coordinator.dispose(); }
  });
});
