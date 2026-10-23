import type { ToolInstallAction, ToolInstallSnapshot } from "../dialogs/dialogProtocol";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { ExternalToolsController, type ExternalToolsPresenter } from "./ExternalToolsController";
import type { ExternalToolStatus } from "./externalToolsEngine";
import { toolInstallSnapshot } from "./toolInstallSnapshot";

export interface ExternalToolsDialogContext { coordinator: () => DialogCoordinator | undefined; documentTabId: () => string | undefined }
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "Installation failed.";

/** Connects the policy controller to the native dialog coordinator; there is never an in-page fallback. */
export function presentExternalToolInstall(controller: ExternalToolsController, context: ExternalToolsDialogContext): () => void {
  // A result may settle before its window closes (e.g. installation succeeded). Keep the
  // tab reserved until native closure, including a still-pending open IPC, has completed.
  const queues = new Map<string, Promise<void>>();
  function enqueue<T>(signal: AbortSignal, show: (coordinator: DialogCoordinator, id: string, closed: () => void) => Promise<T>): Promise<T> {
    const id = context.documentTabId() ?? "main";
    const previous = queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => closed);
    queues.set(id, tail);
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void previous.then(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { release(); abort(); return; }
        const coordinator = context.coordinator();
        if (!coordinator) { release(); reject(new Error("External-tool installation UI is unavailable.")); return; }
        show(coordinator, id, release).then(resolve, reject);
      }).catch(error => { release(); reject(error); });
    });
  }
  const presenter: ExternalToolsPresenter = {
    consent(plugin, status, signal) {
      return enqueue(signal, (coordinator, id, closed) => showDialog<"granted" | "declined">(coordinator, id, toolInstallSnapshot(status, plugin, { status: "consent" }), signal, closed, dialog => ({
        action: action => { if (action === "allow") dialog.close(undefined, "granted"); },
        closeError: () => new Error("declined")
      })));
    },
    install(plugin, status, signal) {
      return enqueue(signal, (coordinator, id, closed) => showDialog<ExternalToolStatus>(coordinator, id, toolInstallSnapshot(status, plugin), signal, closed, dialog => {
        let installing = false;
        let failed: unknown;
        return {
          closeError: () => failed ?? new Error(installing ? "cancelled" : "declined"),
          onClose: () => { if (installing) void controller.cancelNativeInstall(status.tool).catch(() => undefined); },
          action: async action => {
            if (action === "cancelInstall") {
              try { await controller.cancelNativeInstall(status.tool); } catch (error) { dialog.close(error); }
              return;
            }
            if (action !== "install" || installing || dialog.closed()) return;
            installing = true; failed = undefined;
            try {
              if (!await dialog.update(toolInstallSnapshot(status, plugin, { status: "installing", phase: "Starting", bytesDone: 0, bytesTotal: 0 }))) return;
              if (dialog.closed()) return;
              await controller.installNative(status.tool, progress => {
                if (!dialog.closed()) void dialog.update(toolInstallSnapshot(status, plugin, { status: "installing", phase: progress.message, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal }));
              });
              if (dialog.closed()) return;
              const result = await controller.statusNative(status.tool, plugin.id);
              if (!dialog.closed() && await dialog.update(toolInstallSnapshot(result, plugin, { status: "installed" }))) dialog.resolve(result);
            } catch (error) {
              failed = error;
              if (!dialog.closed()) await dialog.update(toolInstallSnapshot(status, plugin, { status: "failed", message: errorText(error) }));
            } finally { installing = false; }
          }
        };
      }));
    }
  };
  return controller.attachPresenter(presenter);
}

interface ToolDialog<T> {
  closed(): boolean;
  close(error?: unknown, value?: T): void;
  resolve(value: T): void;
  update(snapshot: ToolInstallSnapshot): Promise<boolean>;
}

function showDialog<T>(coordinator: DialogCoordinator, id: string, snapshot: ToolInstallSnapshot, signal: AbortSignal, release: () => void,
  handlers: (dialog: ToolDialog<T>) => { action(action: ToolInstallAction): void | Promise<void>; closeError(): unknown; onClose?(): void }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let closed = false;
    let opening: Promise<void> = Promise.resolve();
    let nativeClose: Promise<void> | undefined;
    const close = (error?: unknown, value?: T) => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", abort);
      actions.onClose?.();
      if (error !== undefined) reject(error); else resolve(value as T);
      const closing = coordinator.closeToolInstall(id);
      // Defer reading opening/nativeClose until callbacks from open/settle have returned.
      void Promise.resolve().then(() => Promise.all([opening.catch(() => undefined), closing, nativeClose])).then(release, release);
    };
    const abort = () => close(signal.reason ?? new Error("cancelled"));
    const actions = handlers({
      closed: () => closed, close, resolve,
      update: async data => {
        if (closed) return false;
        try { await coordinator.updateToolInstall(id, data); return !closed; }
        catch (error) { close(error); return false; }
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    opening = coordinator.openToolInstall(id, snapshot, {
      action: action => action === "close" ? close(actions.closeError()) : actions.action(action),
      closed: afterClose => { nativeClose = afterClose; close(actions.closeError()); },
      failed: error => close(error)
    });
    void opening.catch(error => close(error));
  });
}
