import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { perfProbeRequestedFromWindow } from "./perf/gate";
import "./App.css";

function mount() {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
// Gate checking is synchronous and performs no native calls when disabled. Enabled runs align
// each webview's performance clock before mounting; logging failures must never prevent launch.
if (perfProbeRequestedFromWindow()) {
  void import("./perf/runtime").then(module => module.startPerfProbe())
    .catch(error => console.warn("Perf probe could not start", error)).then(mount);
} else {
  mount();
}
