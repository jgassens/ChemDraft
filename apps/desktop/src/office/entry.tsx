import { createRoot } from "react-dom/client";
import type { OfficeApi } from "./host";
import type { PowerPointApi } from "./powerpoint";
import type { WordApi } from "./word";
import "../App.css";
import "./pane.css";

const officeWindow = window as Window & { Office?: OfficeApi; Word?: WordApi; PowerPoint?: PowerPointApi };
const element = document.getElementById("root")!;

function showStatus(message: string) {
  const status = document.createElement("p");
  status.className = "office-message";
  status.setAttribute("role", "status");
  status.textContent = message;
  element.replaceChildren(status);
}

async function connect() {
  // Check for either Tauri marker before loading the desktop editor module. Office's pane uses
  // the browser runtime and has no native bridge.
  if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) {
    showStatus("Open Edit Structure from Word or PowerPoint.");
    return;
  }
  const timer = window.setTimeout(() => {
    showStatus("Office.js did not start within 10 seconds. Open this pane from Word or PowerPoint and check that Office can reach appsforoffice.microsoft.com.");
  }, 10_000);
  try {
    // The async script lets this timer run even while the CDN request is stalled.
    if (!officeWindow.Office?.onReady) {
      await new Promise<void>(resolve => document.getElementById("office-js")?.addEventListener("load", () => resolve(), { once: true }));
    }
    const office = officeWindow.Office;
    if (!office?.onReady) return;
    const { host } = await office.onReady();
    window.clearTimeout(timer);
    if (host !== "Word" && host !== "PowerPoint") {
      showStatus("Open Edit Structure from Word or PowerPoint.");
      return;
    }
    const [{ OfficePane }, adapter] = await Promise.all([
      import("./Pane"),
      host === "Word" ? import("./word").then(module => module.wordAdapter(office.context, officeWindow.Word))
        : import("./powerpoint").then(module => module.powerpointAdapter(office.context, officeWindow.PowerPoint)),
    ]);
    createRoot(element).render(<OfficePane adapter={adapter} document={office.context.document} />);
  } catch (error) {
    window.clearTimeout(timer);
    showStatus("The ChemDraft task pane could not start. " + (error instanceof Error ? error.message : String(error)));
  }
}

void connect();
