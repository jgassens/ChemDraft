import { createPluginRuntimeOwner } from "./pluginRuntimeOwner";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { RuntimeCoreCommandRegistry } from "./runtimeCoreCommands";
import { createRuntimeAssistantClient } from "./runtimeAssistantClient";
import { createRuntimeDialogClient } from "./runtimeDialogs";
import { bindRuntimeViewOwner } from "./runtimeViewOwner";
import { encodeRuntimeView } from "./runtimeViewProtocol";
import { createPersistentPluginStorage } from "./pluginStorage";
import { ImageSourceRegistry, fileImageSourceWithPicker, screenRegionImageSourceProvider } from "./ImageSourceProvider";
import { pickPluginPackage } from "./pickPluginPackage";

/** Called only by the hidden host route. The first authenticated document supplies core definitions
 * before the sole owner registers plugins. A5b will extend document-specific presentation binding. */
export function bindRuntimeHostSession(broker: RuntimeBroker, createOwner = createPluginRuntimeOwner) {
  if (broker.label !== "runtime") throw new Error("Only the hidden runtime host may construct the owner.");
  let initialization: Promise<null> | undefined;
  let documentWindow: string | undefined;
  let disposed = false;
  const stops: Array<() => void> = [];
  const stop = broker.handle("initializeRuntime", (_request, sender) => {
    if (documentWindow && documentWindow !== sender) throw new Error("Runtime presentation is already bound to another document window.");
    documentWindow = sender;
    initialization ??= (async () => {
      const registry = new RuntimeCoreCommandRegistry(broker, sender, true);
      stops.push(registry.dispose);
      await registry.ready;
      if (disposed) throw new Error("The runtime host closed during startup.");
      const clients = () => [sender];
      const publish = (topic: string, value: unknown) => {
        void broker.broadcastView(clients(), topic, encodeRuntimeView(value)).catch(() => undefined);
      };
      const assistant = createRuntimeAssistantClient(broker);
      const dialogs = createRuntimeDialogClient(broker);
      stops.push(assistant.dispose, dialogs.dispose);
      const chooseFile = (kind: "pluginPackage" | "image") => broker.call(sender, "chooseRuntimeFile", { kind });
      const owner = createOwner({
        dataOnly: true, commandRegistry: registry, createStorage: createPersistentPluginStorage,
        getActiveDocument: () => undefined, getSelection: () => ({ objectIds: [], molecules: [] }),
        captureAssistantRequest: assistant.begin,
        dialogPort: target => target ? dialogs.forTarget(target) : undefined,
        pickPackage: () => pickPluginPackage({ chooseFile: () => chooseFile("pluginPackage") }),
        imageSourceRegistry: new ImageSourceRegistry([
          fileImageSourceWithPicker(() => chooseFile("image")), screenRegionImageSourceProvider
        ]),
        forwardUnboundCommand: async (commandId, options) => {
          const captured = await broker.call(sender, "captureDocumentTarget", { windowId: sender });
          const reply = await broker.call(sender, "invokeDocumentPlugin", { ...captured, commandId,
            input: options?.input, collectWarnings: !!options?.selectionWarnings }) as { result?: unknown; error?: string; warnings: string[] };
          options?.selectionWarnings?.push(...reply.warnings);
          if (reply.error) throw new Error(reply.error);
          return reply.result;
        },
        onNameResolutionStatus: text => publish("nameResolutionStatus", text),
        onPluginUpdateStatus: text => publish("pluginUpdateStatus", text),
        onProposedPatchesChanged: () => publish("proposalsChanged", null)
      });
      stops.push(() => owner.dispose());
      const host = new RuntimeBrokerHost(broker, () => owner.runtime, clients);
      const view = bindRuntimeViewOwner(owner, broker, clients);
      stops.push(() => host.dispose(), view);
      owner.start();
      return null;
    })().catch(error => {
      for (const dispose of stops.splice(0).reverse()) dispose();
      throw error;
    });
    return initialization;
  });
  return () => { disposed = true; stop(); for (const dispose of stops.splice(0).reverse()) dispose(); };
}
