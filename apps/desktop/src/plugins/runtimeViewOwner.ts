import type { PluginCommandInput, PluginImageSource } from "@chemdraft/plugin-api";
import type { PluginRuntimeOwner } from "./pluginRuntimeOwner";
import { RuntimeBroker } from "./runtimeBroker";
import { encodeRuntimeView, decodeRuntimeView, isRuntimeViewAction, type RuntimeViewAction, type RuntimeViewState } from "./runtimeViewProtocol";
import type { PluginPackageInspection } from "./installPluginPackage";
import type { PreparedPluginUpdate, PluginUpdateOffer } from "./pluginUpdates";
import { PluginReleaseMetadataUnavailableError } from "./pluginUpdates";
import { PluginInstallError } from "./installPluginPackage";
import { createFixturePluginOptions, fixturePluginManifest, FIXTURE_PLUGIN_ID } from "./fixturePlugin";
import type { CanvasOverlayDraftRestore } from "./pluginCanvasOverlayControls";

/** Only this owner-side adapter knows the real host/controllers. It never transmits them. */
export function bindRuntimeViewOwner(owner: PluginRuntimeOwner, broker: RuntimeBroker, clients: () => readonly string[]): (() => void) & { publish(): void } {
  const runtime = owner.runtime;
  // Archive bytes and worker descriptors stay with their owner. The manager reviews metadata and
  // returns an opaque receipt, so an otherwise valid large package never exceeds a broker message.
  const packages = new Map<string, PluginPackageInspection>();
  const previewSources = new Map<string, { token: string; source: string }>();
  const retainPackage = (inspection: PluginPackageInspection) => {
    const runtimePackageHandle = crypto.randomUUID();
    packages.set(runtimePackageHandle, inspection);
    return { ...inspection, entries: [], runtimePackageHandle };
  };
  const packageFor = (raw: unknown) => {
    const handle = (raw as { runtimePackageHandle?: string })?.runtimePackageHandle;
    if (!handle || !packages.has(handle)) throw new Error("This plugin package review has expired. Choose or download the package again.");
    return packages.get(handle)!;
  };
  const restoreTokens = new WeakMap<CanvasOverlayDraftRestore, number>();
  let nextRestoreToken = 0;
  const restore = (id: string) => {
    const value = runtime.getCanvasOverlayDraftRestore(id);
    if (!value) return undefined;
    if (!restoreTokens.has(value)) restoreTokens.set(value, ++nextRestoreToken);
    return { ...value, token: restoreTokens.get(value)! };
  };
  const topics = () => ({
    naming: { status: runtime.naming.getStatus(), run: runtime.naming.getInstallRun(), activity: runtime.naming.getActivity() },
    overlayStatus: [...runtime.getCanvasOverlayStatuses()],
    overlayTranscript: [...runtime.getCanvasOverlayTranscripts()],
    overlayContent: { contents: [...runtime.getCanvasOverlayContents()], restores: runtime.listCanvasOverlays().map(({ overlay }) => [overlay.id, restore(overlay.id)]) },
    overlayOpen: [...runtime.getCanvasOverlayOpenRequests()],
    activity: runtime.recognition.getActiveRecognition(),
    progress: runtime.recognition.getInstallRun()
  });
  const snapshot = (): RuntimeViewState => {
    const view = owner.read();
    const { runtime: _runtime, bundledPlugins, installedPlugins, isPluginCommand: _is, ...rest } = view;
    const state: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) if (typeof value !== "function") state[key] = value;
    const prompt = view.openTextPrompt;
    if (prompt) state.openTextPrompt = { id: prompt.id, pluginId: prompt.pluginId, pluginName: prompt.pluginName, request: prompt.request };
    const proposals = runtime.host.listProposedPatches("pending");
    const liveIds = new Set(proposals.map(proposal => proposal.id));
    for (const id of previewSources.keys()) if (!liveIds.has(id)) previewSources.delete(id);
    // Keep large data URIs out of any one bounded message. The view reconstructs the exact URI
    // through bounded data reads, so native review windows receive the same image as before.
    const reviewProposals = proposals.map(proposal => {
      const recognition = proposal.proposal.recognition;
      const source = recognition?.sourceImageRef;
      if (!recognition || !source || source.length < 512_000) return proposal;
      let retained = previewSources.get(proposal.id);
      if (!retained || retained.source !== source) {
        retained = { token: crypto.randomUUID(), source };
        previewSources.set(proposal.id, retained);
      }
      return { ...proposal, proposal: { ...proposal.proposal, recognition: { ...recognition,
        sourceImageRef: `runtime-preview:${retained.token}:${source.length}` } } };
    });
    return {
      ...state as Omit<RuntimeViewState, "bundledPlugins" | "installedPlugins" | "availableActions" | "proposals" | "proposalTabs" | "toolsets" | "commands">,
      bundledPlugins: bundledPlugins.map(({ manifest }) => ({ manifest })),
      installedPlugins: installedPlugins.map(({ record, manifest }) => ({ record, manifest })),
      availableActions: Object.entries(view).flatMap(([key, value]) => typeof value === "function" && isRuntimeViewAction(key) ? [key] : []),
      proposals: reviewProposals,
      proposalTabs: proposals.map(proposal => [proposal.id, runtime.proposalDocumentTab(proposal.id)]),
      toolsets: runtime.listPluginToolsets(),
      commands: runtime.host.commands.list().filter(command => command.pluginId).map(({ id, pluginId, enabled, source }) => ({ id, pluginId, enabled: enabled !== false, source }))
    };
  };
  const publish = (topic: string, value: unknown) => { void broker.broadcastView(clients(), topic, encodeRuntimeView(value)).catch(() => undefined); };
  const publishState = () => publish("state", snapshot());
  const describeError = (cause: unknown) => ({
    message: cause instanceof Error ? cause.message : String(cause),
    installCode: cause instanceof PluginInstallError ? cause.code : undefined,
    metadataKind: cause instanceof PluginReleaseMetadataUnavailableError ? cause.kind : undefined
  });
  const action = ({ action, args: encoded }: RuntimeViewAction): unknown => {
    const args = decodeRuntimeView<unknown[]>(encoded);
    const view = owner.read();
    switch (action) {
      case "invokePluginCommand": {
        const warnings: string[] = [];
        return view.invokePluginCommand(args[0] as string, { input: args[1] as PluginCommandInput | undefined,
          selectionWarnings: args[2] ? warnings : undefined }).then(
          result => ({ result, warnings }), cause => ({ error: describeError(cause), warnings }));
      }
      case "pickPackage": return view.pickPackage?.().then(picked => picked && ({ ...picked, inspection: retainPackage(picked.inspection) }));
      case "installPackage": return view.installPackage?.(packageFor(args[0]));
      case "prepareOfficialPluginInstall": return view.prepareOfficialPluginInstall?.(args[0] as string).then(prepared => ({ ...prepared, inspection: retainPackage(prepared.inspection) }));
      case "uninstallInstalledPlugin": return view.uninstallInstalledPlugin?.(args[0] as string);
      case "checkInstalledPluginUpdates": return view.checkInstalledPluginUpdates?.();
      case "prepareInstalledPluginUpdate": return view.prepareInstalledPluginUpdate?.(args[0] as PluginUpdateOffer).then(prepared => ({ ...prepared, inspection: retainPackage(prepared.inspection) }));
      case "updateInstalledPlugin": return view.updateInstalledPlugin?.({ ...args[0] as PreparedPluginUpdate, inspection: packageFor((args[0] as PreparedPluginUpdate).inspection) });
      case "discardPreparedPackages": return packages.clear();
      case "closePanel": return runtime.panels.closePanel();
      case "submitTextPrompt": return runtime.prompts.submit(args[0] as number, args[1] as string);
      case "cancelTextPrompt": return runtime.prompts.cancel(args[0] as number);
      case "acquireImage": return runtime.images.acquire(args[0] as number, args[1] as PluginImageSource);
      case "openImagePermissionSettings": return runtime.images.openPermissionSettings(args[0] as number);
      case "refreshImagePermission": return runtime.images.refreshPermission(args[0] as number);
      case "relaunchForImagePermission": return runtime.images.relaunch(args[0] as number);
      case "cancelImageRequest": return runtime.images.cancel(args[0] as number);
      case "installRecognitionEngine": return runtime.recognition.install(args[0] as number);
      case "cancelRecognitionEngineInstall": return runtime.recognition.cancel(args[0] as number);
      case "declineRecognitionEngineInstall": return runtime.recognition.decline(args[0] as number);
      case "refreshRecognitionEngineStatus": return view.refreshRecognitionEngineStatus();
      case "startRecognitionEngineInstall": return view.startRecognitionEngineInstall();
      case "cancelRunningRecognitionEngineInstall": return view.cancelRunningRecognitionEngineInstall();
      case "uninstallRecognitionEngine": return view.uninstallRecognitionEngine();
      case "cancelRecognition": return view.cancelRecognition(args[0] as number);
      case "closeDetachedPanel": return runtime.panels.closeDetachedPanel(args[0] as string, args[1] as string);
      case "detachPanel": return runtime.panels.detachPanel(args[0] as string, args[1] as string);
      case "reattachPanel": return runtime.panels.reattachPanel(args[0] as string, args[1] as string);
      case "reportDiagnostic": return runtime.panels.reportDiagnostic(args[0] as string, args[1] as string);
      case "applyEnabled": return owner.applyEnabled(args[0] as string[]);
      case "namingCancelActivity": return runtime.naming.cancelNaming(args[0] as number);
      case "namingRefresh": return runtime.naming.refreshStatus();
      case "namingInstall": return runtime.naming.installEngine();
      case "namingCancel": return runtime.naming.cancelEngineInstall();
      case "namingUninstall": return runtime.naming.uninstall();
      case "consentList": return runtime.externalTools.consentList();
      case "consentRevoke": return runtime.externalTools.consentRevoke(args[0] as Parameters<typeof runtime.externalTools.consentRevoke>[0], args[1] as string);
      case "clearDraftRestore": {
        const current = runtime.getCanvasOverlayDraftRestore(args[0] as string);
        if (args[1] !== undefined && (!current || restoreTokens.get(current) !== args[1])) return false;
        return runtime.clearCanvasOverlayDraftRestore(args[0] as string, current);
      }
      case "closeProposalDocumentTab": return runtime.closeProposalDocumentTab(args[0] as string, args[1] as string);
      case "proposalDocumentTab": return runtime.proposalDocumentTab(args[0] as string);
      case "listCanvasOverlays": return runtime.listCanvasOverlays();
      case "screenCaptureOf": return !!runtime.host.recognitionScreenCaptureOf(args[0] as string);
      case "previewImageChunk": {
        const retained = [...previewSources.values()].find(source => source.token === args[0]);
        if (!retained) throw new Error("This recognition preview is no longer pending.");
        const offset = args[1] as number;
        return retained.source.slice(offset, offset + 256 * 1024);
      }
      case "acceptProposal": {
        if (!broker.supportsImmediate) throw new Error("Use the captured asynchronous proposal commit.");
        return owner.acknowledgePreparedProposal(args[0] as string);
      }
      case "rejectProposal": return runtime.host.rejectProposedPatch(args[0] as string);
      case "registerFixture": if (import.meta.env.DEV) return runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions()); return;
      case "unregisterFixture": if (import.meta.env.DEV) return runtime.unregisterPlugin(FIXTURE_PLUGIN_ID); return;
    }
  };
  const success = (value: unknown) => ({ ok: true, value: encodeRuntimeView(value) });
  const failure = (cause: unknown) => ({ ok: false, error: describeError(cause) });
  const stops = [
    broker.handle("setDocumentMetadata", (request, sender) => {
      if (request.target.windowId !== sender) throw new Error("Document metadata belongs to another window.");
      runtime.updateDocumentTabTitles(request.titles, sender);
      publishState();
      return null;
    }),
    broker.handle("acceptPreparedProposal", async (request, sender) => {
      const target = runtime.proposalDocumentTab(request.proposalId);
      if (sender !== request.target.windowId || target?.id !== request.target.tabId || (target.windowId && target.windowId !== sender)) {
        throw new Error("The proposal does not belong to this document target.");
      }
      const token = runtime.host.reserveProposedPatchAcceptance(request.proposalId);
      let committed = false;
      try {
        await broker.call(sender, "commitProposal", request);
        committed = true;
      } finally { runtime.host.settleProposedPatchAcceptance(request.proposalId, token, committed); }
      return null;
    }),
    broker.handle("getRuntimeView", () => encodeRuntimeView({ state: snapshot(), topics: topics() })),
    broker.handle("runtimeViewAction", request => {
      try {
        const result = action(request);
        return result instanceof Promise ? result.then(success, failure) : success(result);
      } catch (cause) { return failure(cause); }
    }),
    owner.subscribe(publishState),
    runtime.naming.subscribe(() => publish("naming", { status: runtime.naming.getStatus(), run: runtime.naming.getInstallRun(), activity: runtime.naming.getActivity() })),
    runtime.subscribeCanvasOverlayStatus(() => publish("overlayStatus", [...runtime.getCanvasOverlayStatuses()])),
    runtime.subscribeCanvasOverlayTranscript(() => publish("overlayTranscript", [...runtime.getCanvasOverlayTranscripts()])),
    runtime.subscribeCanvasOverlayContent(() => publish("overlayContent", {
      contents: [...runtime.getCanvasOverlayContents()],
      restores: runtime.listCanvasOverlays().map(({ overlay }) => [overlay.id, restore(overlay.id)])
    })),
    runtime.subscribeCanvasOverlayOpen(() => publish("overlayOpen", [...runtime.getCanvasOverlayOpenRequests()])),
    runtime.recognition.subscribeActivity(() => publish("activity", runtime.recognition.getActiveRecognition())),
    runtime.recognition.subscribe(() => publish("progress", runtime.recognition.getInstallRun()))
  ];
  // Proposal notifications are a separate callback from PluginHost.subscribe.
  return Object.assign(() => {
    for (const stop of stops) stop();
    packages.clear();
    previewSources.clear();
  }, { publish: () => {
    publishState();
    for (const [topic, value] of Object.entries(topics())) publish(topic, value);
  } });

}
