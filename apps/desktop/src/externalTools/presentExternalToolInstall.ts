import type { ToolInstallAction } from "../dialogs/dialogProtocol";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { ExternalToolsController, type ExternalToolsPresenter } from "./ExternalToolsController";
import type { ExternalToolStatus } from "./externalToolsEngine";
import { toolInstallSnapshot, type ExternalToolPlugin } from "./toolInstallSnapshot";

export interface ExternalToolsDialogContext { coordinator: () => DialogCoordinator | undefined; documentTabId: () => string | undefined }
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "Installation failed.";

/** Connects the policy controller to the native dialog coordinator; there is never an in-page fallback. */
export function presentExternalToolInstall(controller: ExternalToolsController, context: ExternalToolsDialogContext): () => void {
  const presenter: ExternalToolsPresenter = {
    consent(plugin, status) { return showConsent(context, plugin, status); },
    install(plugin, status, signal) { return showInstall(context, controller, plugin, status, signal); }
  };
  return controller.attachPresenter(presenter);
}
function tab(context: ExternalToolsDialogContext): string { return context.documentTabId() ?? "main"; }
function showConsent(context: ExternalToolsDialogContext, plugin: ExternalToolPlugin, status: ExternalToolStatus): Promise<"granted" | "declined"> {
  const coordinator = context.coordinator(); if (!coordinator) return Promise.resolve("declined"); const id = tab(context);
  return new Promise(resolve => {
    let done = false; const settle = (value: "granted" | "declined") => { if (done) return; done = true; void coordinator.closeToolInstall(id); resolve(value); };
    void coordinator.openToolInstall(id, toolInstallSnapshot(status, plugin, { status: "consent" }), {
      action: async (action: ToolInstallAction) => { if (action === "allow") settle("granted"); else if (action === "close") settle("declined"); },
      closed: () => settle("declined")
    });
  });
}
function showInstall(context: ExternalToolsDialogContext, controller: ExternalToolsController, plugin: ExternalToolPlugin, status: ExternalToolStatus, signal: AbortSignal): Promise<ExternalToolStatus> {
  const coordinator = context.coordinator(); if (!coordinator) return Promise.reject(new Error("declined")); const id = tab(context);
  return new Promise((resolve, reject) => {
    let closed = false; let installing = false; let failed: unknown;
    const close = () => { if (closed) return; closed = true; void coordinator.closeToolInstall(id); if (failed) reject(failed); else reject(new Error(installing ? "cancelled" : "declined")); };
    const action = async (value: ToolInstallAction) => {
      if (value === "close") { close(); return; }
      if (value === "cancelInstall") { await controller.cancelNativeInstall(status.tool); return; }
      if (value !== "install" || installing) return;
      installing = true;
      await coordinator.updateToolInstall(id, toolInstallSnapshot(status, plugin, { status: "installing", phase: "Starting", bytesDone: 0, bytesTotal: 0 }));
      try {
        await controller.installNative(status.tool, progress => void coordinator.updateToolInstall(id, toolInstallSnapshot(status, plugin, { status: "installing", phase: progress.message, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal })));
        const result = await controller.statusNative(status.tool, plugin.id);
        if (!closed) { await coordinator.updateToolInstall(id, toolInstallSnapshot(result, plugin, { status: "installed" })); resolve(result); }
      } catch (error) { failed = error; if (!closed) await coordinator.updateToolInstall(id, toolInstallSnapshot(status, plugin, { status: "failed", message: errorText(error) })); }
    };
    signal.addEventListener("abort", close, { once: true });
    void coordinator.openToolInstall(id, toolInstallSnapshot(status, plugin), { action, closed: close });
  });
}
