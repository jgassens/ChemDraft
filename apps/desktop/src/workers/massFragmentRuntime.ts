/** Both platform entries statically import this runtime and start message handling synchronously. */
import { runPluginWorker } from "@chemdraft/plugin-api";
import { createMassRegistration, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";

export function startMassFragmentWorker(): void {
  runPluginWorker({
    manifest: massFragmentManifest,
    commandHandlers: createMassRegistration().commandHandlers
  });
}
