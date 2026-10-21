import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PhaseInfo } from "./structureRecognitionInstallProgress";
import type { StructureNamingInstallProgress } from "./structureNamingEngine";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import type { EngineInstallSnapshot } from "../dialogs/dialogProtocol";
import type { StructureNamingController, OpenStructureNamingInstall } from "./StructureNamingController";

export const NAMING_ENGINE_DISCLOSURE = "About 100 MB to download and about 0.3 GB on disk. It runs only on this computer. Downloaded parts: Orthonym (MIT); centres jar (BSD-2-Clause, with LGPL-2.1+ and GPL-2.0-with-Classpath-Exception parts).";
export const NAMING_INSTALL_PROFILE = {
  phases: {
    checkingDisk: { step: 1, name: "Checking free disk space", weightBytes: 0, typicalSeconds: 2 },
    downloadingUv: { step: 1, name: "Downloading the installer", weightBytes: 20e6, typicalSeconds: 15 },
    installingPython: { step: 2, name: "Installing Python", weightBytes: 40e6, typicalSeconds: 45 },
    installingPackages: { step: 3, name: "Installing Orthonym and dependencies", weightBytes: 40e6, typicalSeconds: 90 },
    downloadingModel: { step: 4, name: "Downloading centres", weightBytes: 2.3e6, typicalSeconds: 10 },
    verifying: { step: 5, name: "Checking the installation", weightBytes: 1e6, typicalSeconds: 30 }
  } satisfies Record<Exclude<StructureNamingInstallProgress["phase"], "done">, PhaseInfo>,
  installedText: "The naming engine is installed."
};

/** Bound by JSON-escaped UTF-8 bytes, including unusual native error text. */
function bounded(text: string, budget: number): string {
  let result = "";
  for (const char of text.replaceAll("\0", "")) {
    if (new TextEncoder().encode(JSON.stringify(result + char)).length > budget - 3) return result + "…";
    result += char;
  }
  return result;
}
const diskBytes = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
export function namingInstallSnapshot(controller: StructureNamingController, request: OpenStructureNamingInstall): EngineInstallSnapshot {
  const run = controller.getInstallRun();
  const progress = run?.progress ?? request.status.progress;
  const phase = NAMING_INSTALL_PROFILE.phases[progress?.phase === "done" ? "verifying" : progress?.phase ?? "checkingDisk"];
  const state: EngineInstallSnapshot["state"] = run?.error ? { status: "failed", message: bounded(run.error.message, 1000) }
    : controller.getStatus()?.state === "installed" ? { status: "installed" }
    : request.installing ? { status: "installing", phase: phase.name, step: phase.step, steps: 5,
      bytesDone: diskBytes(progress?.bytesDone), bytesTotal: diskBytes(progress?.bytesTotal), estimated: progress?.estimated ?? false }
    : request.status.state === "broken" ? { status: "broken", detail: bounded(request.status.detail ?? "The engine installation is damaged.", 1000) }
    : request.status.state === "installed" ? { status: "installed" } : { status: "notInstalled" };
  return {
    engineName: "Naming engine", title: "Naming needs a local engine",
    pluginName: bounded(request.pluginName, 128), pluginId: bounded(request.pluginId, 256),
    disclosure: NAMING_ENGINE_DISCLOSURE, requiredDiskBytes: diskBytes(request.status.requiredDiskBytes),
    freeDiskBytes: diskBytes(request.status.freeDiskBytes), state,
    buttons: state.status === "installing" ? ["cancelInstall", "close"] : state.status === "installed" || state.status === "failed" ? ["close"] : ["install", "close"]
  };
}

export interface NamingDialogContext {
  coordinator(): DialogCoordinator | undefined;
  documentTabId(): string | undefined;
}

/** Native coordinator presenter. Captures the originating tab before status awaits. */
export function presentStructureNamingInstall(controller: StructureNamingController, context: NamingDialogContext): () => void {
  let active: { id: number; tabId: string; coordinator: DialogCoordinator; request: OpenStructureNamingInstall; terminal?: boolean } | undefined;
  let updates = Promise.resolve();
  const reportError = (coordinator: DialogCoordinator, error: unknown) => coordinator.reportError("Naming engine installation could not open: " + String(error));
  const update = () => {
    const request = controller.getOpenInstall();
    if (!request) {
      const previous = active;
      if (previous && !previous.terminal) {
        previous.terminal = true;
        const data = namingInstallSnapshot(controller, previous.request);
        // Failed installs remain readable until Close.
        if (data.state.status === "failed") {
          updates = updates.then(() => active?.id === previous.id ? previous.coordinator.updateEngineInstall(previous.tabId, data) : undefined).catch(error => reportError(previous.coordinator, error));
        } else {
          updates = updates.then(() => active?.id === previous.id ? previous.coordinator.closeEngineInstall(previous.tabId) : undefined).catch(error => reportError(previous.coordinator, error));
        }
      }
      return;
    }
    if (active?.id === request.id) {
      active.request = request;
      const current = active;
      const data = namingInstallSnapshot(controller, request);
      updates = updates.then(() => active?.id === current.id ? current.coordinator.updateEngineInstall(current.tabId, data) : undefined).catch(error => {
        reportError(current.coordinator, error); controller.decline(request.id);
      });
      return;
    }
    const coordinator = context.coordinator();
    const tabId = controller.getInstallDocumentTabId();
    if (!coordinator || !tabId) {
      coordinator?.reportError("Naming engine installation could not open: the originating drawing is unavailable.");
      controller.decline(request.id);
      return;
    }
    const previous = active;
    active = { id: request.id, tabId, coordinator, request };
    const closing = previous ? previous.coordinator.closeEngineInstall(previous.tabId) : undefined;
    void coordinator.openEngineInstall(tabId, namingInstallSnapshot(controller, request), {
      action: action => {
        if (action === "install") return controller.install(request.id);
        if (action === "cancelInstall") return controller.cancelEngineInstall();
        controller.decline(request.id);
      },
      closed: () => { if (active?.id === request.id) active = undefined; controller.decline(request.id); }
    }, closing)
      .catch(error => { reportError(coordinator, error); controller.decline(request.id); });
  };
  const detach = controller.attachInstallPresenter(() => context.documentTabId(), () => {
    const current = active;
    if (current) void current.coordinator.openEngineInstall(current.tabId, namingInstallSnapshot(controller, current.request), {
      action: () => {}, closed: () => {}
    }).catch(error => reportError(current.coordinator, error));
  });
  const unsubscribe = controller.subscribe(update);
  update();
  return () => {
    unsubscribe(); detach();
    const current = active;
    active = undefined;
    if (current) void current.coordinator.closeEngineInstall(current.tabId);
  };
}

function StructureNamingHostView({ controller }: { controller: StructureNamingController }) {
  const [, setVersion] = useState(0);
  useEffect(() => controller.subscribe(() => setVersion(version => version + 1)), [controller]);
  const activity = controller.getActivity();
  return <>
    {activity ? <section className="recognition-progress" aria-label="Naming activity">
      <p role="status">Naming the structure…</p><p>{activity.pluginName}</p>
      <progress aria-label="Naming the structure" />
      <button type="button" onClick={() => controller.cancelNaming(activity.id)}>Cancel</button>
    </section> : null}
  </>;
}

/** Only the activity indicator is mounted in the document DOM. */
export function mountStructureNamingHost(controller: StructureNamingController, context?: NamingDialogContext): () => void {
  const container = document.createElement("div");
  container.className = "structure-naming-host";
  document.body.append(container);
  const root = createRoot(container);
  root.render(<StructureNamingHostView controller={controller} />);
  const detach = context ? presentStructureNamingInstall(controller, context) : () => {};
  return () => { detach(); queueMicrotask(() => { root.unmount(); container.remove(); }); };
}
