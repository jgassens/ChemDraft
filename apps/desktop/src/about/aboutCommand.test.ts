import { CommandRegistry } from "@chemdraft/plugin-host";
import { expect, it, vi } from "vitest";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, parseDialogMessage, type DialogMessage } from "../dialogs/dialogProtocol";
import { aboutCommand, openAbout } from "./aboutCommand";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.2" }));

it("opens a single app-wide native About session from the registered command", async () => {
  const transport = {
    subscribe: vi.fn(async () => () => {}),
    open: vi.fn(async (_snapshot: DialogMessage) => ({ hostId: "opaque", windowLabel: "dialog-main-about-0" })),
    close: vi.fn(async () => {}),
    publish: vi.fn(async () => {})
  };
  const coordinator = new DialogCoordinator(transport, { onError: vi.fn(), applyPageSize: vi.fn() });
  const registry = new CommandRegistry();
  registry.register(aboutCommand, () => openAbout(coordinator, "11.19.18.03-codex", true));
  try {
    await registry.invoke("help.about");
    const first = transport.open.mock.calls.at(0)?.[0];
    expect(first).toMatchObject({
      dialogKind: "about", documentTabId: "about", type: "snapshot",
      data: { title: "About ChemDraft", version: "1.2.2", buildStamp: "11.19.18.03-codex" }
    });
    await registry.invoke("help.about");
    expect(transport.open).toHaveBeenNthCalledWith(2, first);
    await coordinator.closeTab("drawing-tab");
    expect(transport.close).not.toHaveBeenCalled();
    const message = parseDialogMessage(first)!;
    const copy = { ...dialogEnvelope(message), type: "action", data: { action: "copyVersion" } };
    expect(parseDialogMessage(copy)).toBeDefined();
    expect(parseDialogMessage({ ...copy, data: { ...copy.data, text: "untrusted" } })).toBeUndefined();
  } finally {
    await coordinator.dispose();
  }
  expect(transport.close).toHaveBeenCalledOnce();
});
