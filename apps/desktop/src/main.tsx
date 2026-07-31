import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./App.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// TEMPORARY DIAGNOSTIC (see ghostProbe.ts): inert unless ?ghostProbe=1 is in the URL.
if (new URLSearchParams(window.location.search).get("ghostProbe") === "1") {
  void import("./ghostProbe").then((probe) => probe.installGhostProbe());
}
