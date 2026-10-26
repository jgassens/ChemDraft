import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { perfProbeRequestedFromWindow } from "./perf/gate";
import { perfHook } from "./perf/runtime";
import "./App.css";

function mount() {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
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
