// @vitest-environment jsdom
// On the desktop the tour runs in its own native dialog window, which has no plugin runtime. The
// document window reads the menus' plugin list when the tour opens and sends it in the guidedTour
// snapshot. This drives the real chain: useGuidedTour → DialogCoordinator → (snapshot) →
// DialogWindow → TourForm, on macOS and on Windows from one host (AGENTS.md section 1).
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { parseDialogMessage, type DialogMessage } from "../dialogs/dialogProtocol";

const host = vi.hoisted(() => ({
  invoke: vi.fn(),
  opened: [] as DialogMessage[],
  /** Every message the dialog window sent to the native host. */
  sent: [] as DialogMessage[],
  toDialog: undefined as ((message: DialogMessage) => void) | undefined,
  toOwner: undefined as ((message: DialogMessage) => void) | undefined
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: host.invoke }));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(),
  isDesktopRuntime: () => true
}));
// The dialog window's side of the native host: messages hop through a macrotask, as over IPC. Sending
// is the real sendDialogMessage, so a message its protocol check refuses never reaches the host; only
// the IPC call underneath it, Rust's dialog_send, is stood in for (see dialogSend below).
vi.mock("../dialogs/dialogTransport", async original => ({
  ...await original<typeof import("../dialogs/dialogTransport")>(),
  subscribeDialogHost: async (_hostId: string, receive: (message: DialogMessage) => void) => {
    host.toDialog = receive;
    return () => {};
  }
}));

/** Rust's dialog_send: the guide link is opened by the host itself and never relayed to the owner. */
function dialogSend(command: string, args?: unknown) {
  if (command !== "dialog_send") return {};
  const { message } = args as { hostId: string; message: DialogMessage };
  host.sent.push(message);
  if (message.type === "action" && message.data.action === "openGuide") return undefined;
  setTimeout(() => host.toOwner!(message), 0);
  return undefined;
}

import { DialogWindow } from "../dialogs/DialogWindow";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { buildOfficialPluginMenuItems, NAME_TO_STRUCTURE_COMMAND_ID } from "../plugins/officialPluginMenus";
import { buildPluginMenuItems } from "../plugins/pluginMenuModel";
import { useGuidedTour } from "./useGuidedTour";
import { availableTourPluginCommands, PLUGIN_AUTHORING_GUIDE_URL, TOUR_NAME_COMMAND, type TourAction } from "./tourCommands";

const DIALOG_LABEL = "dialog-main-guidedTour-1";
const invokeCommand = vi.fn(async (_id: string) => undefined);

/** The document window's part of the tour, wired as MainWindow wires it: the plugin list comes off the menu items. */
function DocumentWindow({ nameToStructure }: { nameToStructure: boolean }) {
  const coordinator = useRef<DialogCoordinator>(undefined);
  const action = useRef<(action: TourAction) => Promise<void>>(async () => {});
  const command = { id: NAME_TO_STRUCTURE_COMMAND_ID, title: "Name to Structure", pluginId: "org.chemdraft.opsin.nameToStructure", enabled: true } as unknown as CommandDefinition;
  const menuItems = [...buildPluginMenuItems([]), ...buildOfficialPluginMenuItems(id => nameToStructure && id === command.id ? command : undefined)];
  const tour = useGuidedTour({
    coordinator: () => coordinator.current, readyAndIdle: () => true, scheme: "chemdraft",
    plugins: () => availableTourPluginCommands(menuItems), mode: "suppress", setStatus: () => {}
  });
  action.current = next => tour.completeOrRun(next, { invoke: invokeCommand, has: id => nameToStructure && id === TOUR_NAME_COMMAND });
  useEffect(() => {
    coordinator.current = new DialogCoordinator({
      subscribe: async handler => {
        host.toOwner = message => handler({ message, senderWindowId: DIALOG_LABEL, windowLabel: DIALOG_LABEL });
        return () => {};
      },
      open: async snapshot => {
        host.opened.push(snapshot);
        setTimeout(() => host.toDialog!(snapshot), 0);
        return { hostId: "tour", windowLabel: DIALOG_LABEL };
      },
      publish: async (_hostId, message) => { setTimeout(() => host.toDialog!(message), 0); },
      close: async () => {}
    }, { guidedTourAction: next => action.current(next), applyPageSize: () => {}, onError: message => { throw new Error(message); } });
    void tour.open();
  }, []);
  return null;
}

const roots: Root[] = [];
const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 10)); });

/** The tour window's laid-out size. Measurement itself is the real dialogContentFit code; only layout,
 *  which jsdom does not do, is stood in for, so the window sends the same measured ready it sends natively. */
const TOUR_WIDTH = 520;
const TOUR_HEIGHT = 412;
const rect = (width: number, height: number) => ({
  x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({})
}) as DOMRect;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".guided-tour")) return rect(TOUR_WIDTH, TOUR_HEIGHT);
    if (this.matches(".guided-tour-sizer-step")) return rect(TOUR_WIDTH - 48, 240);
    if (this.matches(".guided-tour-sizer .guided-tour-actions")) return rect(TOUR_WIDTH - 48, 44);
    return rect(0, 0);
  });
  vi.stubGlobal("localStorage", new MemoryStorage());
  host.opened = [];
  host.sent = [];
  host.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => dialogSend(command, args));
  invokeCommand.mockClear();
});
afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Open the tour from the document window into the native dialog window and go to step 6, which shows
 *  Name to Structure (the plugins card, step 5, comes first). */
async function openToNameStep(nameToStructure: boolean) {
  const tour = await mount(createElement(DialogWindow, { hostId: "tour" }));
  await mount(createElement(DocumentWindow, { nameToStructure }));
  await act(async () => { await import("./TourForm"); });
  await settle();
  const button = (text: string) => [...tour.querySelectorAll("button")].find(item => item.textContent === text);
  for (let step = 1; step < 6; step++) await act(async () => { button("Next")!.click(); });
  expect(tour.querySelector(".guided-tour-counter")!.textContent).toBe("Step 6 of 9");
  return { tour, button };
}

describe.each([["macos", "MacIntel"], ["windows", "Win32"]] as const)("the native tour window on %s", (platform, navigatorPlatform) => {
  beforeEach(() => { vi.spyOn(navigator, "platform", "get").mockReturnValue(navigatorPlatform); });

  it("reports its measured size in ready, through the real protocol check, to the native host's dialog_send", async () => {
    const tour = await mount(createElement(DialogWindow, { hostId: "tour" }));
    await mount(createElement(DocumentWindow, { nameToStructure: false }));
    await act(async () => { await import("./TourForm"); });
    await settle();
    expect(tour.querySelector(".guided-tour")).not.toBeNull();
    // The window is a content-fit dialog: its one ready carries the measurement, and Rust reveals the
    // hidden window only when that ready arrives. A refused ready never reaches dialog_send at all.
    const readies = host.invoke.mock.calls.filter(([command, args]) => command === "dialog_send" &&
      (args as { message: DialogMessage }).message.type === "ready");
    expect(readies).toHaveLength(1);
    const [, args] = readies[0]!;
    expect(args).toMatchObject({ hostId: "tour" });
    const { message } = args as { message: DialogMessage };
    expect(message).toMatchObject({ dialogKind: "guidedTour", type: "ready",
      data: { contentHeight: TOUR_HEIGHT, contentWidth: TOUR_WIDTH, pixelRatio: window.devicePixelRatio || 1 } });
    // What crosses IPC is JSON, and the serialized message passes the same check on arrival.
    expect(parseDialogMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(tour.querySelector("[role=alert]")).toBeNull();
  });

  it("shows Name to Structure and its Try it when the menus offer the plugin", async () => {
    const { tour, button } = await openToNameStep(true);
    expect(host.opened).toHaveLength(1);
    expect(host.opened[0]).toMatchObject({ dialogKind: "guidedTour", type: "snapshot",
      data: { title: "Take the Tour", scheme: "chemdraft", automatic: false, plugins: [TOUR_NAME_COMMAND] } });
    expect(tour.querySelector("h1")!.textContent).toBe("Names and structure search");
    expect(tour.textContent).toContain("The Name to Structure plugin draws from a chemical name through the Structure menu.");
    expect(tour.textContent).not.toContain("Optional plugin");
    await act(async () => { button("Try it")!.click(); });
    await settle();
    expect(invokeCommand).toHaveBeenLastCalledWith(TOUR_NAME_COMMAND);
    expect(tour.querySelector("[role=alert]")).toBeNull();

    // The dialog window used this platform's own wording on the last step.
    for (let step = 6; step < 9; step++) await act(async () => { button("Next")!.click(); });
    expect(tour.textContent).toContain(platform === "macos" ? "Choose ChemDraft > Settings… (⌘,)" : "Choose File > Preferences… (Ctrl+,)");
  });

  it("sends the guide link to the native host once per click, Enter or middle-click, never to the document window", async () => {
    const { tour, button } = await openToNameStep(false);
    await act(async () => { button("Back")!.click(); });
    expect(tour.querySelector("h1")!.textContent).toBe("Add features with plugins");
    const link = tour.querySelector<HTMLAnchorElement>(".guided-tour-url a")!;
    expect(link.getAttribute("href")).toBe(PLUGIN_AUTHORING_GUIDE_URL);
    const location = window.location.href;
    host.sent = [];
    await act(async () => { link.click(); });
    // Enter on a focused link: the browser fires click unless keydown was cancelled (jsdom does not).
    await act(async () => {
      link.focus();
      if (link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) link.click();
    });
    // A middle-click arrives as auxclick and goes the same way.
    await act(async () => { link.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })); });
    await settle();
    // Each passed the real protocol check in sendDialogMessage and reached the host's dialog_send.
    expect(host.sent.map(message => [message.dialogKind, message.type, message.data])).toEqual([
      ["guidedTour", "action", { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL }],
      ["guidedTour", "action", { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL }],
      ["guidedTour", "action", { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL }]
    ]);
    const isOpenGuide = (data: DialogMessage["data"]) =>
      typeof data === "object" && data !== null && "action" in data && data.action === "openGuide";
    expect(host.invoke.mock.calls.filter(([command, args]) => command === "dialog_send" &&
      isOpenGuide((args as { message: DialogMessage }).message.data))).toHaveLength(3);
    expect(new Set(host.sent.map(message => message.requestId)).size).toBe(3);
    expect(window.location.href).toBe(location);
    expect(invokeCommand).not.toHaveBeenCalled();
    // Opening the guide is not a pending tour action: nothing is busy and the tour carries on.
    expect(tour.querySelector("[role=alert]")).toBeNull();
    expect(button("Skip tour")!.disabled).toBe(false);
    await act(async () => { button("Next")!.click(); });
    expect(tour.querySelector(".guided-tour-counter")!.textContent).toBe("Step 6 of 9");
  });

  it("names the plugin as optional, with no Try it, when the menus do not offer it", async () => {
    const { tour, button } = await openToNameStep(false);
    expect(host.opened[0]).toMatchObject({ dialogKind: "guidedTour", data: { plugins: [] } });
    expect(tour.querySelector("h1")!.textContent).toBe("Structure search");
    expect(tour.textContent).toContain("Use Tools to search PubChem or Reaxys by the selected structure. Optional plugin: add Name to Structure from " +
      "Plugins > Add or Remove Plugins… to draw a structure from a chemical name.");
    expect(tour.textContent).not.toContain("The Name to Structure plugin draws");
    expect(button("Try it")).toBeUndefined();
    for (let step = 6; step < 9; step++) await act(async () => { button("Next")!.click(); });
    expect(tour.textContent).toContain(platform === "macos" ? "Choose ChemDraft > Settings… (⌘,)" : "Choose File > Preferences… (Ctrl+,)");
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});

describe("the guidedTour snapshot's plugin list", () => {
  const snapshot = (data: Record<string, unknown>) => ({
    protocolVersion: 1, ownerWindowId: "main", documentTabId: "guidedTour", dialogKind: "guidedTour", sessionId: "s",
    requestId: "r", snapshotRevision: 1, type: "snapshot", data: { title: "Take the Tour", scheme: "chemdraft", automatic: true, ...data }
  });

  it("is optional and holds only known tour plugin commands, each once", () => {
    expect(parseDialogMessage(snapshot({}))).toBeDefined();
    expect(parseDialogMessage(snapshot({ plugins: [] }))).toBeDefined();
    expect(parseDialogMessage(snapshot({ plugins: [TOUR_NAME_COMMAND] }))).toBeDefined();
    for (const plugins of [["plugin.unknown.command"], [TOUR_NAME_COMMAND, "document.save"], [TOUR_NAME_COMMAND, TOUR_NAME_COMMAND],
      TOUR_NAME_COMMAND, [1], {}, null]) {
      expect(parseDialogMessage(snapshot({ plugins })), JSON.stringify(plugins)).toBeUndefined();
    }
  });
});
