import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { perfProbeRequestedFromWindow } from "./perf/gate";
import { perfHook } from "./perf/runtime";
import { installContextMenuGuard } from "./contextMenuGuard";
import { installNativeAppHandoffReceiver } from "./appHandoff/nativeMenu";
import "./App.css";

const listenForAppHandoff = "__TAURI_INTERNALS__" in window && window === window.top &&
  !new URLSearchParams(window.location.search).has("window")
  ? installNativeAppHandoffReceiver(window) : undefined;

// The document window owns its canvas context menu; all other app windows share this guard.
if (new URLSearchParams(window.location.search).has("window")) installContextMenuGuard();

function mount() {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App listenForAppHandoff={listenForAppHandoff} />
    </StrictMode>
  );
}
// Probe calibration is background work: even a never-settling IPC must not delay React mount.
if (perfHook(() => perfProbeRequestedFromWindow())) perfHook(() => {
  return (new URLSearchParams(window.location.search).has("window")
    ? import("./perf/runtime").then(module => perfHook(() => module.startPerfProbe()))
    : import("./MainWindow").then(module => perfHook(() => module.startMainWindowPerfProbe())));
});
mount();
