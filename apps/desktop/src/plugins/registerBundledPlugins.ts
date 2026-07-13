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
import type { PluginCommandHandler, PluginManifest, PluginPanelReport } from "@chemdraft/plugin-api";
import type { RegisterPluginOptions } from "@chemdraft/plugin-host";

import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { getNmrWorkerClient } from "./nmrWorkerClient";
import { loadDisabledPluginIds } from "./pluginPreferences";

export interface BundledPluginDescriptor {
  manifest: PluginManifest;
  options: RegisterPluginOptions;
}

/**
 * Build the ordered catalog of plugins statically bundled with the desktop. This is a factory, not a
 * module singleton, because the NMR registration owns mutable cancellation state that must belong to
 * one desktop runtime.
 */
export function createBundledPluginDescriptors(): readonly BundledPluginDescriptor[] {
  // Register the NMR predictor plugin. Its command handlers drive the deterministic fixture provider
  // through the worker client (the worker spawns lazily on the first prediction) and write records to
  // the generic analysis store. Where Worker is unavailable (exotic webviews, tests), fall back to
  // running the deterministic fixture provider in-thread so the feature still works.
  const workerClient = getNmrWorkerClient();
  const predictor: NmrPredictor = workerClient ? createWorkerBackedPredictor(workerClient) : createLazyOclPredictor();
  const nmr = createNmrRegistration({ predictor });
  return [
    {
      manifest: molscribeOcsrManifest,
      options: {
        commandHandlers: {
          [molscribeOcsrCommandId]: createMolscribeCanaryHandler()
        }
      }
    },
    {
      manifest: nmrPredictorManifest,
      options: {
        commandHandlers: nmr.commandHandlers,
        onPanelClosed: nmr.onPanelClosed
      }
    },
    // Second, unrelated analyzer (mass spectrometry) on the very same host/analysis/panel APIs — no
    // worker, no reference database, zero NMR concepts. That it registers identically is the proof
    // that the plugin infrastructure is domain-agnostic, not NMR-shaped.
    {
      manifest: massFragmentManifest,
      options: {
        commandHandlers: createMassRegistration().commandHandlers
      }
    }
  ];
}

/** Apply the user's enabled set live. Disabled bundled plugins are unregistered; enabled bundled
 * plugins are registered with their original handlers. Reapplying the same set is a no-op. */
export function applyEnabledPlugins(
  runtime: DesktopPluginRuntime,
  disabledIds: ReadonlySet<string>,
  descriptors: readonly BundledPluginDescriptor[] = createBundledPluginDescriptors()
): void {
  for (const descriptor of descriptors) {
    const pluginId = descriptor.manifest.id;
    const registered = runtime.host.getPlugin(pluginId) !== undefined;

    if (disabledIds.has(pluginId)) {
      if (registered) {
        // Closing first invokes the plugin's panel-close hook while it is still registered. For NMR
        // this aborts in-flight prediction and prevents a late result from reviving a disabled panel.
        if (runtime.panels.getOpenPanel()?.pluginId === pluginId) {
          runtime.panels.closePanel();
        }
        runtime.host.unregisterPlugin(pluginId);
      }
      continue;
    }

    if (!registered) {
      runtime.host.registerPlugin(descriptor.manifest, descriptor.options);
    }
  }
}

/** Register the enabled subset at startup and return the runtime-owned descriptor catalog so later
 * manager toggles reuse the same per-runtime handler state. */
export function registerBundledPlugins(
  runtime: DesktopPluginRuntime,
  disabledIds: ReadonlySet<string> = loadDisabledPluginIds()
): readonly BundledPluginDescriptor[] {
  const descriptors = createBundledPluginDescriptors();
  applyEnabledPlugins(runtime, disabledIds, descriptors);
  return descriptors;
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
