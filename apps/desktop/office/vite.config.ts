import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, normalizePath, type Plugin } from "vite";
import desktopConfig from "../vite.config";
import app from "../package.json";

const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
// Vite compares and returns module IDs with forward slashes; fileURLToPath gives backslashes on Windows.
const moduleId = (name: string) => normalizePath(path(name));

function officeAssets(): Plugin {
  return {
    name: "chemdraft-office",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || normalizePath(importer) !== moduleId("../src/MainWindow.tsx")) return;
      // MainWindow exposes its typed Office editor port and command invoker through these
      // modules. Only the add-in build supplies the Office.js implementations.
      if (source === "./officeObject") return moduleId("../src/office/editorHost.tsx");
      if (source === "./MenuBar") return moduleId("../src/office/controls.tsx");
    },
    generateBundle: { order: "post", handler(_options, bundle) {
      const pane = bundle["office.html"];
      if (!pane || pane.type !== "asset") throw new Error("Missing Office pane HTML.");
      delete bundle["office.html"];
      pane.fileName = "taskpane.html";
      bundle[pane.fileName] = pane;
      const version = /^\d+\.\d+\.\d+/.exec(app.version)?.[0];
      if (!version) throw new Error("Invalid ChemDraft app version.");
      const source = readFileSync(path("./manifest.xml"), "utf8")
        .replaceAll("{{AppVersion}}", app.version)
        .replaceAll("{{ManifestVersion}}", version + ".0");
      this.emitFile({ type: "asset", fileName: "manifest.xml", source });
      for (const size of [16, 32, 80]) {
        const fileName = "icon-" + size + ".png";
        // The feasibility manifest already uses versions of the original ChemDraft artwork.
        this.emitFile({ type: "asset", fileName, source: readFileSync(path("../../../scripts/office-spike/addin/" + fileName)) });
      }
    } },
  };
}

export default defineConfig(mergeConfig(desktopConfig, {
  base: "./",
  plugins: [officeAssets()],
  build: {
    outDir: "dist/office",
    emptyOutDir: true,
    rollupOptions: { input: path("../office.html") },
  },
}));
