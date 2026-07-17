import {
  mockSourceImageRef,
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId,
  runMolScribeOcsrMockRecognition
} from "@chemdraft/molscribe-ocsr-plugin";
import { createMassRegistration, massFragmentManifest, massFragmentPluginId } from "@chemdraft/plugin-mass-fragment";
import {
  PluginApiVersion,
  type PluginCommandHandler,
  type PluginManifest,
  type PluginPanelReport,
  type PluginWorkerHandle
} from "@chemdraft/plugin-api";
import type { RegisterPluginOptions } from "@chemdraft/plugin-host";

import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { PluginWorkerBridge } from "./PluginWorkerBridge";
import { loadDisabledPluginIds } from "./pluginPreferences";

export interface BundledPluginDescriptor {
  manifest: PluginManifest;
  options: RegisterPluginOptions;
  /** Present when the plugin's *execution* runs in a per-plugin Web Worker (ADR-0029, M34). The
   *  command handlers in `options` delegate to this bridge; `bridge.terminate()` is the full teardown
   *  M36's uninstall will call. Absent when the plugin runs in-process (no Worker, e.g. tests). */
  bridge?: PluginWorkerBridge;
}

/** Lazily creates a plugin's isolation worker, or `undefined` to force the in-process path. Injectable
 *  so tests can drive the worker route with a linked fake, or omit it entirely for the in-process path. */
export type PluginWorkerFactory = () => PluginWorkerHandle;

export interface BundledPluginRuntimeOptions {
  /** Per-plugin worker factories keyed by plugin id. Defaults to real module workers in the webview and
   *  an empty map in environments without `Worker` (node/jsdom tests), which then run in-process. */
  pluginWorkerFactories?: ReadonlyMap<string, PluginWorkerFactory>;
}

/** The desktop's real module-worker factories for the worker-isolated bundled plugins. Empty where
 *  `Worker` is unavailable, so tests and unrelated environments transparently take the in-process path. */
export function defaultPluginWorkerFactories(): ReadonlyMap<string, PluginWorkerFactory> {
  const factories = new Map<string, PluginWorkerFactory>();
  if (typeof Worker === "undefined") {
    return factories;
  }
  factories.set(
    massFragmentPluginId,
    () =>
      new Worker(new URL("./workers/massFragmentPluginWorker.ts", import.meta.url), {
        type: "module"
      }) as unknown as PluginWorkerHandle
  );
  return factories;
}

/**
 * Build the ordered catalog of plugins statically bundled with the desktop. A factory, not a module
 * singleton, because the worker bridges (and any in-process registration state) must belong to one
 * desktop runtime.
 *
 * The mass analyzer runs in a per-plugin Web Worker when a factory is available (ADR-0029, M34); its
 * manifest command handlers delegate to a {@link PluginWorkerBridge} that services its capability
 * calls against the real host context. Where no factory is available (node/jsdom), it runs in-process
 * exactly as before, so existing behavior and tests are unaffected. The MolScribe canary deliberately
 * stays in-process — proof that unrelated plugins are untouched.
 */
export function createBundledPluginDescriptors(
  options: BundledPluginRuntimeOptions = {}
): readonly BundledPluginDescriptor[] {
  const factories = options.pluginWorkerFactories ?? defaultPluginWorkerFactories();
  return [
    {
      manifest: molscribeOcsrManifest,
      options: {
        commandHandlers: {
          [molscribeOcsrCommandId]: createMolscribeCanaryHandler()
        }
      }
    },
    buildMassDescriptor(factories.get(massFragmentPluginId))
  ];
}

/** Delegating command handlers + panel-close forwarding for a worker-routed plugin: each contributed
 *  command runs in the worker via the bridge, and the host's real per-invocation context services its
 *  capability calls (which is also where declared-only enforcement happens).
 *
 *  Exported because a plugin loaded from a built package (M35, `loadPackagedPlugin`) must reach the host
 *  through exactly this path — that identity is what makes a packaged plugin behave the same as a
 *  bundled one, rather than merely similarly. */
export function createWorkerRoutedOptions(manifest: PluginManifest, bridge: PluginWorkerBridge): RegisterPluginOptions {
  const commandHandlers: Record<string, PluginCommandHandler> = {};
  for (const command of manifest.contributes.commands) {
    commandHandlers[command.id] = (context) => bridge.invokeCommand(command.id, context);
  }
  return {
    commandHandlers,
    onPanelClosed: (panelId) => bridge.notifyPanelClosed(panelId)
  };
}

/**
 * The mass analyzer: worker-routed when a factory exists, else in-process. Pure computation with no
 * nested worker of its own — proof that an analyzer crosses the isolation boundary on nothing but the
 * generic bridge machinery.
 */
function buildMassDescriptor(factory: PluginWorkerFactory | undefined): BundledPluginDescriptor {
  if (factory) {
    const bridge = new PluginWorkerBridge({
      pluginId: massFragmentManifest.id,
      createWorker: factory,
      hostApiVersion: PluginApiVersion
    });
    return { manifest: massFragmentManifest, options: createWorkerRoutedOptions(massFragmentManifest, bridge), bridge };
  }
  return { manifest: massFragmentManifest, options: { commandHandlers: createMassRegistration().commandHandlers } };
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
        // Closing first invokes the plugin's panel-close hook while it is still registered, so an
        // analyzer can abort in-flight work and a late result cannot revive a disabled panel.
        // Detached (windowed) panels are real closes too (ADR-0012).
        if (runtime.panels.getOpenPanel()?.pluginId === pluginId) {
          runtime.panels.closePanel();
        }
        for (const detached of runtime.panels.getDetachedPanels()) {
          if (detached.pluginId === pluginId) {
            runtime.panels.closeDetachedPanel(detached.panelId);
          }
        }
        runtime.unregisterPlugin(pluginId);
      }
      continue;
    }

    if (!registered) {
      // Through the runtime (not the bare host), so toolset contributions are staged with their
      // ui.toolbar gate and whole-plugin rollback no matter how a plugin arrives.
      runtime.registerPlugin(descriptor.manifest, descriptor.options);
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
