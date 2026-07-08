import {
  mockSourceImageRef,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId,
  runMolScribeOcsrMockRecognition
} from "@chemdraft/molscribe-ocsr-plugin";
import type { PluginCommandHandler, PluginPanelReport } from "@chemdraft/plugin-api";

import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { getNmrWorkerClient } from "./nmrWorkerClient";

/**
 * Register every plugin the desktop ships. Adding a plugin is one import plus one `registerPlugin`
 * call here — no changes to the host, renderer, or menu adapter — which is the extensibility this
 * milestone is meant to prove.
 */
export function registerBundledPlugins(runtime: DesktopPluginRuntime): void {
  runtime.host.registerPlugin(molscribeOcsrManifest, {
    commandHandlers: {
      [molscribeOcsrCommandId]: createMolscribeCanaryHandler()
    }
  });

  // Create the NMR worker client now (lazy: the worker spawns on first prediction, wired in M8).
  // This also anchors the NMR plugin's Web Worker in the desktop's Vite build graph — see
  // nmrWorkerClient.ts and the M7 bundling spike.
  getNmrWorkerClient();
}

/**
 * Runtime canary handler for MolScribe OCSR. It exercises the plugin's pure fixture recognition and
 * renders the outcome as a declarative panel report, proving the path
 * manifest → host → menu → command → report. It intentionally does not propose a document patch:
 * this milestone verifies the runtime, not OCR insertion, and a canary must not mutate the document.
 */
function createMolscribeCanaryHandler(): PluginCommandHandler {
  return async (context) => {
    const result = runMolScribeOcsrMockRecognition({ sourceImageRef: mockSourceImageRef });

    const report: PluginPanelReport = {
      title: "MolScribe OCSR (runtime canary)",
      sections: [
        {
          kind: "keyValue",
          title: "Bundled plugin runtime",
          rows: [
            { label: "Plugin", value: context.plugin.name },
            { label: "Version", value: context.plugin.version },
            { label: "Command", value: molscribeOcsrCommandId },
            { label: "Runtime path", value: "Active (manifest → host → menu → command → report)" },
            { label: "OCR inference", value: "Not run (canary)" }
          ]
        },
        {
          kind: "keyValue",
          title: "Fixture recognition output",
          rows: [
            { label: "Source image", value: result.sourceImageRef },
            { label: "Proposed SMILES", value: result.proposedSmiles ?? "—" },
            { label: "Confidence", value: `${Math.round(result.confidence * 100)}%` }
          ]
        },
        {
          kind: "text",
          body:
            "This panel was rendered by invoking a bundled plugin command through PluginHost and " +
            "displaying its declarative report. No document changes were made."
        }
      ]
    };

    await context.panels?.showReport(molscribeOcsrPanelId, report);
    return result;
  };
}
