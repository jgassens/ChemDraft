import type { DialogCoordinator, EngineInstallPresenter, ToolInstallPresenter } from "../dialogs/DialogCoordinator";
import type { EngineInstallSnapshot, ToolInstallSnapshot } from "../dialogs/dialogProtocol";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import type { RuntimeDialogTarget } from "./runtimeDialogProtocol";
import { RuntimeBroker } from "./runtimeBroker";

/** Presenter-facing port. Implemented by a data client in the owner and by the coordinator only
 * in the document; a DialogCoordinator never leaves its requesting window. */
export type RuntimeDialogPort = Pick<DialogCoordinator, "openEngineInstall" | "updateEngineInstall" | "closeEngineInstall" |
  "openToolInstall" | "updateToolInstall" | "closeToolInstall" | "reportError">;

export function createRuntimeDialogClient(broker: RuntimeBroker) {
  const sessions = new Map<string, { target: RuntimeDialogTarget; kind: "engineInstall" | "toolInstall"; presenter: EngineInstallPresenter | ToolInstallPresenter }>();
  const stop = broker.handle("runtimeDialogAction", async ({ target, id, action, message }, sender) => {
    const session = sessions.get(id);
    if (!session || sender !== target.windowId || JSON.stringify(target) !== JSON.stringify(session.target)) {
      throw new Error("The dialog reply does not belong to its requesting document window.");
    }
    if (action === "closed") { sessions.delete(id); session.presenter.closed(); }
    else if (action === "failed") {
      sessions.delete(id);
      if ("failed" in session.presenter) session.presenter.failed?.(new Error(message));
      else session.presenter.closed();
    } else {
      if (action === "allow" && session.kind !== "toolInstall") throw new Error("This action is unavailable in the naming dialog.");
      await (session.presenter as ToolInstallPresenter).action(action);
    }
    return null;
  });
  return {
    dispose: () => { stop(); sessions.clear(); },
    forTarget(target: RuntimeDialogTarget): RuntimeDialogPort {
      const ids = new Map<string, string>();
      const send = (kind: "engineInstall" | "toolInstall", operation: "open" | "update" | "close" | "error", snapshot?: unknown, message?: string) => {
        const id = ids.get(kind) ?? crypto.randomUUID();
        ids.set(kind, id);
        return broker.call(target.windowId, "runtimeDialogRequest", { target, id, kind, operation, snapshot, message }).then(() => {});
      };
      const open = async (kind: "engineInstall" | "toolInstall", snapshot: unknown,
        presenter: EngineInstallPresenter | ToolInstallPresenter, afterClose?: Promise<void>) => {
        await afterClose;
        const id = ids.get(kind) ?? crypto.randomUUID();
        ids.set(kind, id); sessions.set(id, { target, kind, presenter });
        try { await send(kind, "open", snapshot); }
        catch (error) { sessions.delete(id); throw error; }
      };
      return {
        openEngineInstall: (_tab, data, presenter, after) => open("engineInstall", data, presenter, after),
        updateEngineInstall: (_tab, data) => send("engineInstall", "update", data),
        closeEngineInstall: () => send("engineInstall", "close"),
        openToolInstall: (_tab, data, presenter, after) => open("toolInstall", data, presenter, after),
        updateToolInstall: (_tab, data) => send("toolInstall", "update", data),
        closeToolInstall: () => send("toolInstall", "close"),
        reportError: message => { void send("engineInstall", "error", undefined, message).catch(() => undefined); }
      };
    }
  };
}

export function bindRuntimeDialogs(broker: RuntimeBroker, port: RuntimeDocumentPort, coordinator: () => DialogCoordinator | undefined): () => void {
  const sessions = new Map<string, { target: RuntimeDialogTarget; kind: "engineInstall" | "toolInstall" }>();
  const stop = broker.handle("runtimeDialogRequest", async request => {
    const { target, id, kind, operation, snapshot, message } = request;
    const state = port.read(target.tabId);
    if (target.windowId !== port.windowId || !state || state.documentKey !== target.documentKey) {
      throw new Error("The dialog's requesting document is closed or replaced.");
    }
    const local = coordinator();
    if (!local) throw new Error("The document window's dialog coordinator is unavailable.");
    const existing = sessions.get(id);
    if (existing && (existing.kind !== kind || JSON.stringify(existing.target) !== JSON.stringify(target))) {
      throw new Error("The dialog request belongs to another document target.");
    }
    const reply = (action: "install" | "allow" | "cancelInstall" | "close" | "closed" | "failed", error?: unknown) =>
      broker.call("runtime", "runtimeDialogAction", { target, id, action,
        ...(error ? { message: String(error).slice(0, 4000) } : {}) }).then(() => {});
    if (operation === "error") local.reportError(message ?? "Dialog could not open.");
    else if (operation === "open") {
      sessions.set(id, { target, kind });
      const closed = (afterClose?: Promise<void>) => {
        // External-tool queue ownership lasts until native closure, including pending open IPC.
        void Promise.resolve(afterClose).then(() => { sessions.delete(id); return reply("closed"); }).catch(() => undefined);
      };
      if (kind === "engineInstall") await local.openEngineInstall(target.tabId, snapshot as EngineInstallSnapshot,
        { action: action => reply(action), closed: () => closed() });
      else await local.openToolInstall(target.tabId, snapshot as ToolInstallSnapshot,
        { action: action => reply(action), closed, failed: error => { void reply("failed", error).catch(() => undefined); } });
    } else {
      if (!existing) throw new Error("The dialog session is no longer available.");
      if (kind === "engineInstall") {
        if (operation === "update") await local.updateEngineInstall(target.tabId, snapshot as EngineInstallSnapshot);
        else await local.closeEngineInstall(target.tabId);
      } else if (operation === "update") await local.updateToolInstall(target.tabId, snapshot as ToolInstallSnapshot);
      else await local.closeToolInstall(target.tabId);
    }
    return null;
  });
  return () => { stop(); sessions.clear(); };
}
