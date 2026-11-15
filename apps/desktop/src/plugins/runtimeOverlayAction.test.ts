import { createEmptyDocument } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { expect, it } from "vitest";
import type { RegisteredCanvasOverlay } from "./types";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { readRuntimeOverlayDeclaration } from "./runtimeOverlayAction";

const entry: RegisteredCanvasOverlay = { pluginId: "org.test", overlay: {
  id: "overlay.test", title: "Test", icon: "data:image/png;base64,AA==", commandId: "plugin.test.run",
  defaultCorner: "bottom-right", requiredPermissions: [],
  prompt: { kind: "prompt", id: "input", label: "Input", rows: 2,
    commandId: "plugin.test.run", maxLength: 4000, disabled: false, submitLabel: "Send" }
} };
function setup() {
  const state = { tab: "a", key: "drawing-a", document: createEmptyDocument(), closed: false };
  const port: RuntimeDocumentPort = {
    windowId: "main", commandRegistry: new CommandRegistry(), activeTabId: () => state.tab,
    read: () => state.closed ? undefined : { documentKey: state.key, document: state.document },
    selection: () => ({ objectIds: [], molecules: [] }), runWrite: async (_tab, commit) => commit(),
    commit: () => { throw new Error("No invocation/write is opened during authorization."); }
  };
  let resolve!: (entries: RegisteredCanvasOverlay[]) => void;
  const read = new Promise<RegisteredCanvasOverlay[]>(done => { resolve = done; });
  return { state, port, resolve, runtime: { readCanvasOverlays: () => read } };
}
it("returns the live owner declaration rather than an earlier rendering copy", async () => {
  const f = setup();
  const pending = readRuntimeOverlayDeclaration(f.port, f.runtime, "org.test", "overlay.test");
  f.resolve([{ ...entry, overlay: { ...entry.overlay, commandId: "plugin.foreign.run" } }]);
  expect((await pending)?.overlay.commandId).toBe("plugin.foreign.run");
});
it.each(["activation", "replacement", "close", "selection"])("refuses %s during the live authorization read before any command can start", async change => {
  const f = setup();
  const pending = readRuntimeOverlayDeclaration(f.port, f.runtime, "org.test", "overlay.test");
  if (change === "activation") f.state.tab = "b";
  if (change === "replacement") f.state.key = "replacement";
  if (change === "close") f.state.closed = true;
  if (change === "selection") f.state.document = { ...f.state.document, selection: { ...f.state.document.selection, objectIds: ["new-grant"] } };
  f.resolve([entry]);
  await expect(pending).rejects.toThrow("source drawing or selection changed");
});
it("keeps ordinary edits with the same incarnation and selection valid", async () => {
  const f = setup();
  const pending = readRuntimeOverlayDeclaration(f.port, f.runtime, "org.test", "overlay.test");
  f.state.document = { ...f.state.document, title: "Renamed" };
  f.resolve([entry]);
  expect(await pending).toEqual(entry);
});
