import {
  mockSourceImageRef,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId,
  runMolScribeOcsrMockRecognition
} from "@chemdraft/molscribe-ocsr-plugin";
import { createMassRegistration, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import {
  createNmrRegistration,
  createWorkerBackedPredictor,
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
  const predictor: NmrPredictor = workerClient ? createWorkerBackedPredictor(workerClient) : createLazyOclPredictor();
  const nmr = createNmrRegistration({ predictor });
  runtime.host.registerPlugin(nmrPredictorManifest, {
    commandHandlers: nmr.commandHandlers,
    onPanelClosed: nmr.onPanelClosed
  });

  // Second, unrelated analyzer (mass spectrometry) on the very same host/analysis/panel APIs — no
  // worker, no reference database, zero NMR concepts. That it registers identically is the proof that
  // the plugin infrastructure is domain-agnostic, not NMR-shaped.
  runtime.host.registerPlugin(massFragmentManifest, {
    commandHandlers: createMassRegistration().commandHandlers
  });
}

/**
 * In-thread OCL predictor for environments without a `Worker` (jsdom, exotic webviews). Loaded via
 * dynamic import so the ~800 KB reference database is a code-split chunk fetched on first prediction,
 * rather than statically pulled into the desktop's main bundle. The normal desktop uses the worker,
 * where the database is bundled eagerly and this path is never taken.
 */
function createLazyOclPredictor(): NmrPredictor {
  let loaded: Promise<NmrPredictor> | undefined;
  const load = (): Promise<NmrPredictor> =>
    (loaded ??= import("@chemdraft/plugin-nmr-predictor").then((module) => new module.OclHosePredictor()));
  return {
    getCapabilities: async () => (await load()).getCapabilities(),
    predict: async (request, signal) => (await load()).predict(request, signal)
  };
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
