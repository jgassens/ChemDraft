import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useNativePrompt } from "../nativePrompt";
import { RecognitionInstallProgress } from "./RecognitionInstallProgress";
import { formatGigabytes, type PhaseInfo } from "./structureRecognitionInstallProgress";
import type { StructureNamingController, OpenStructureNamingInstall } from "./StructureNamingController";
import type { StructureNamingInstallProgress } from "./structureNamingEngine";

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

export function StructureNamingInstallDialog({ controller, request }: {
  controller: StructureNamingController; request: OpenStructureNamingInstall
}) {
  const run = controller.getInstallRun();
  const prompt = useNativePrompt({
    title: "Naming needs a local engine",
    message: [`Requested by ${request.pluginName} (${request.pluginId})`, NAMING_ENGINE_DISCLOSURE,
      `Space needed for installation: ${formatGigabytes(request.status.requiredDiskBytes)}. Free space: ${formatGigabytes(request.status.freeDiskBytes)}.`,
      request.status.detail].filter(Boolean).join("\n\n"),
    kind: request.status.state === "broken" ? "warning" : "info",
    choices: [{ id: "install", label: request.status.state === "broken" ? "Install engine again" : "Install" },
      { id: "close", label: "Cancel", cancel: true }]
  }, choice => {
    if (choice === "install") { void controller.install(request.id); return false; }
    controller.decline(request.id);
  }, request.installing ? undefined : request.id);
  if (!request.installing && !prompt.visible) return null;
  return <section className="plugin-prompt-dialog naming-install-dialog" role="dialog" aria-label="Naming needs a local engine">
    <h2>Naming needs a local engine</h2>
    <p>{NAMING_ENGINE_DISCLOSURE}</p>
    <p>Free space: {formatGigabytes(request.status.freeDiskBytes)}. Installation needs {formatGigabytes(request.status.requiredDiskBytes)}.</p>
    {request.status.detail ? <p>{request.status.detail}</p> : null}
    {request.installing ? <RecognitionInstallProgress progress={run?.progress} startedAt={run?.startedAt} phaseStartedAt={run?.phaseStartedAt} profile={NAMING_INSTALL_PROFILE} /> : null}
    <button type="button" onClick={() => request.installing ? controller.decline(request.id) : prompt.choose("close")}>Close</button>
    {!request.installing ? <button type="button" onClick={() => prompt.choose("install")}>{request.status.state === "broken" ? "Install engine again" : "Install"}</button> : null}
  </section>;
}

function StructureNamingHostView({ controller }: { controller: StructureNamingController }) {
  const [, setVersion] = useState(0);
  useEffect(() => controller.subscribe(() => setVersion(version => version + 1)), [controller]);
  const request = controller.getOpenInstall();
  const activity = controller.getActivity();
  return <>
    {request ? <StructureNamingInstallDialog key={request.id} controller={controller} request={request} /> : null}
    {activity ? <section className="recognition-progress" aria-label="Naming activity">
      <p role="status">Naming the structure…</p><p>{activity.pluginName}</p>
      <progress aria-label="Naming the structure" />
      <button type="button" onClick={() => controller.cancelNaming(activity.id)}>Cancel</button>
    </section> : null}
  </>;
}

/** Host-owned view lifecycle, independent of the document and selection render loop.
 * TODO(dialog-host): route the install view through a native naming dialog once the Rust
 * dialog-kind allowlist and snapshot contract support it. Currently this mirrors recognition's
 * native-prompt/install-progress presentation; it is not a modeless native dialog.
 */
export function mountStructureNamingHost(controller: StructureNamingController): () => void {
  const container = document.createElement("div");
  container.className = "structure-naming-host";
  document.body.append(container);
  const root = createRoot(container);
  root.render(<StructureNamingHostView controller={controller} />);
  const detach = controller.attachInstallPresenter();
  return () => { detach(); queueMicrotask(() => { root.unmount(); container.remove(); }); };
}
