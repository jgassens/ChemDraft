import {
  mockSourceImageRef,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId,
  runMolScribeOcsrMockRecognition
} from "@chemdraft/molscribe-ocsr-plugin";
import {
  createNmrRegistration,
  createWorkerBackedPredictor,
  FixtureHosePredictor,
  nmrPredictorManifest,
  type NmrPredictor
} from "@chemdraft/plugin-nmr-predictor";
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

  // Register the NMR predictor plugin. Its command handlers drive the deterministic fixture provider
  // through the worker client (the worker spawns lazily on the first prediction) and write records to
  // the generic analysis store. Where Worker is unavailable (exotic webviews, tests), fall back to
  // running the deterministic fixture provider in-thread so the feature still works.
  const workerClient = getNmrWorkerClient();
  const predictor: NmrPredictor = workerClient
    ? createWorkerBackedPredictor(workerClient)
    : new FixtureHosePredictor();
  const nmr = createNmrRegistration({ predictor });
  runtime.host.registerPlugin(nmrPredictorManifest, {
    commandHandlers: nmr.commandHandlers,
    onPanelClosed: nmr.onPanelClosed
  });
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
