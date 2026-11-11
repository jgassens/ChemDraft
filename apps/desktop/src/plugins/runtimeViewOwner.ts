import type { PluginCommandInput, PluginImageSource } from "@chemdraft/plugin-api";
import type { PluginRuntimeOwner } from "./pluginRuntimeOwner";
import { RuntimeBroker } from "./runtimeBroker";
import { encodeRuntimeView, decodeRuntimeView, isRuntimeViewAction, type RuntimeViewAction, type RuntimeViewState } from "./runtimeViewProtocol";
import type { PluginPackageInspection } from "./installPluginPackage";
import type { PreparedPluginUpdate, PluginUpdateOffer } from "./pluginUpdates";
import { PluginReleaseMetadataUnavailableError } from "./pluginUpdates";
import { PluginInstallError } from "./installPluginPackage";
import { createFixturePluginOptions, fixturePluginManifest, FIXTURE_PLUGIN_ID } from "./fixturePlugin";
import type { PickedPluginPackage } from "./pickPluginPackage";
import type { CanvasOverlayDraftRestore } from "./pluginCanvasOverlayControls";
import type { RuntimeRequest } from "./runtimeBrokerProtocol";

/** Only this owner-side adapter knows the real host/controllers. It never transmits them. */
export function bindRuntimeViewOwner(owner: PluginRuntimeOwner, broker: RuntimeBroker, clients: () => readonly string[], presentation?: { pickPackage(windowId: string): Promise<PickedPluginPackage | undefined> }): (() => void) & { publish(): void } {
  const runtime = owner.runtime;
  type UncertainAcceptance = { request: RuntimeRequest<"acceptPreparedProposal">; sender: string; token: string;
    reconciliation?: Promise<boolean> };
  const uncertainAcceptances = new Map<string, UncertainAcceptance>();
  const reconcileAcceptance = (attempt: UncertainAcceptance): Promise<boolean> => {
    if (!attempt.reconciliation) {
      const pending = broker.call(attempt.sender, "commitProposal", { ...attempt.request, reconcile: true }).then(committed => {
        if (uncertainAcceptances.get(attempt.request.proposalId) === attempt) {
          runtime.host.settleProposedPatchAcceptance(attempt.request.proposalId, attempt.token, committed);
          uncertainAcceptances.delete(attempt.request.proposalId);
        }
        return committed;
      });
      attempt.reconciliation = pending;
      void pending.catch(() => { if (attempt.reconciliation === pending) attempt.reconciliation = undefined; });
    }
    return attempt.reconciliation;
  };
  const documentNames = new Map<string, string>();
  // Archive bytes and worker descriptors stay with their owner. The manager reviews metadata and
  // returns an opaque receipt, so an otherwise valid large package never exceeds a broker message.
  const packages = new Map<string, { inspection: PluginPackageInspection; windowId: string }>();
  const previewSources = new Map<string, { token: string; source: string; windowId: string }>();
  const proposalWindow = (id: string) => runtime.proposalWindowId(id) ?? "main";
  const assertProposalOwner = (id: string, windowId: string) => {
    if (proposalWindow(id) !== windowId) throw new Error("This proposal belongs to another document window.");
  };
  const retainPackage = (inspection: PluginPackageInspection, windowId: string) => {
    const runtimePackageHandle = crypto.randomUUID();
    packages.set(runtimePackageHandle, { inspection, windowId });
    return { ...inspection, entries: [], runtimePackageHandle };
  };
  const packageFor = (raw: unknown, windowId: string) => {
    const handle = (raw as { runtimePackageHandle?: string })?.runtimePackageHandle;
    const retained = handle && packages.get(handle);
    if (!retained) throw new Error("This plugin package review has expired. Choose or download the package again.");
    if (retained.windowId !== windowId) throw new Error("This plugin package review belongs to another document window.");
    return retained.inspection;
  };
  const restoreTokens = new WeakMap<CanvasOverlayDraftRestore, number>();
  let nextRestoreToken = 0;
  const restore = (id: string, windowId: string) => {
    const value = runtime.getCanvasOverlayDraftRestore(id, windowId);
    if (!value) return undefined;
    if (!restoreTokens.has(value)) restoreTokens.set(value, ++nextRestoreToken);
    return { ...value, token: restoreTokens.get(value)! };
  };
  const activityForWindow = (windowId: string) => {
    const activity = runtime.recognition.getActiveRecognition();
    return activity && (activity.windowId ?? "main") === windowId ? activity : undefined;
  };
  const topics = (windowId: string) => ({
    naming: { status: runtime.naming.getStatus(), run: runtime.naming.getInstallRun(), activity: runtime.naming.getActivity() },
    overlayStatus: [...runtime.getCanvasOverlayStatuses(windowId)],
    overlayTranscript: [...runtime.getCanvasOverlayTranscripts(windowId)],
    overlayContent: { contents: [...runtime.getCanvasOverlayContents(windowId)], restores: runtime.listCanvasOverlays().map(({ overlay }) => [overlay.id, restore(overlay.id, windowId)]) },
    overlayOpen: [...runtime.getCanvasOverlayOpenRequests(windowId)],
    activity: activityForWindow(windowId),
    progress: runtime.recognition.getInstallRun()
  });
  const snapshot = (windowId: string): RuntimeViewState => {
    const view = owner.read();
    const { runtime: _runtime, bundledPlugins, installedPlugins, isPluginCommand: _is, ...rest } = view;
    const state: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) if (typeof value !== "function") state[key] = value;
    const prompt = view.openTextPrompt && (view.openTextPrompt.windowId ?? "main") === windowId ? view.openTextPrompt : undefined;
    state.openTextPrompt = undefined;
    if (prompt) state.openTextPrompt = { id: prompt.id, pluginId: prompt.pluginId, pluginName: prompt.pluginName, request: prompt.request };
    const pending = runtime.host.listProposedPatches("pending");
    const liveIds = new Set(pending.map(proposal => proposal.id));
    for (const id of previewSources.keys()) if (!liveIds.has(id)) previewSources.delete(id);
    const proposals = pending.filter(proposal => proposalWindow(proposal.id) === windowId);
    // Keep large data URIs out of any one bounded message. The view reconstructs the exact URI
    // through bounded data reads, so native review windows receive the same image as before.
    const reviewProposals = proposals.map(proposal => {
      const recognition = proposal.proposal.recognition;
      const source = recognition?.sourceImageRef;
      if (!recognition || !source || source.length < 512_000) return proposal;
      let retained = previewSources.get(proposal.id);
      if (!retained || retained.source !== source) {
        retained = { token: crypto.randomUUID(), source, windowId };
        previewSources.set(proposal.id, retained);
      }
      return { ...proposal, proposal: { ...proposal.proposal, recognition: { ...recognition,
        sourceImageRef: `runtime-preview:${retained.token}:${source.length}` } } };
    });
    return {
      ...state as Omit<RuntimeViewState, "bundledPlugins" | "installedPlugins" | "availableActions" | "proposals" | "proposalTabs" | "toolsets" | "commands">,
      openPanel: runtime.panels.getOpenPanel(windowId),
      detachedPanels: runtime.panels.getDetachedPanels(windowId).map(panel => clients().length > 1
        ? { ...panel, documentName: documentNames.get(windowId) } : panel),
      openImageRequest: view.openImageRequest && (view.openImageRequest.windowId ?? "main") === windowId ? view.openImageRequest : undefined,
      openRecognitionInstall: view.openRecognitionInstall && (view.openRecognitionInstall.windowId ?? "main") === windowId ? view.openRecognitionInstall : undefined,
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
  const publishForWindow = (topic: string, read: (windowId: string) => unknown) => {
    for (const windowId of clients()) void broker.broadcastView([windowId], topic, encodeRuntimeView(read(windowId))).catch(() => undefined);
  };
  const publishState = () => publishForWindow("state", snapshot);
  const describeError = (cause: unknown) => ({
    message: cause instanceof Error ? cause.message : String(cause),
    installCode: cause instanceof PluginInstallError ? cause.code : undefined,
    metadataKind: cause instanceof PluginReleaseMetadataUnavailableError ? cause.kind : undefined
  });
  const action = ({ action, args: encoded }: RuntimeViewAction, windowId: string): unknown => {
    const args = decodeRuntimeView<unknown[]>(encoded);
    const view = owner.read();
    const request = action === "submitTextPrompt" || action === "cancelTextPrompt" ? runtime.prompts.getOpenPrompt()
      : ["acquireImage", "openImagePermissionSettings", "refreshImagePermission", "relaunchForImagePermission", "cancelImageRequest"].includes(action)
        ? runtime.images.getOpenRequest()
        : ["installRecognitionEngine", "cancelRecognitionEngineInstall", "declineRecognitionEngineInstall"].includes(action) ? runtime.recognition.getOpenInstall() : undefined;
    if (request && (request.windowId ?? "main") !== windowId) throw new Error("This presentation belongs to another document window.");
    switch (action) {
      case "invokePluginCommand": {
        const warnings: string[] = [];
        const commandId = args[0] as string;
        if (!runtime.host.commands.get(commandId)?.pluginId) return broker.call(windowId, "invokeCoreCommand",
          { commandId, input: args[1] as PluginCommandInput | undefined, permissions: [] }).then(result => ({ result, warnings }));
        return broker.call(windowId, "captureDocumentTarget", { windowId }).then(captured =>
          broker.call(windowId, "invokeDocumentPlugin", { ...captured, commandId,
            input: args[1] as PluginCommandInput | undefined, collectWarnings: !!args[2] })).then(
          result => {
            const reply = result as { result?: unknown; error?: string; warnings: string[] };
            return { ...reply, error: reply.error ? describeError(reply.error) : undefined };
          }, cause => ({ error: describeError(cause), warnings }));
      }
      case "pickPackage": return (presentation ? presentation.pickPackage(windowId) : view.pickPackage?.())?.then(picked => picked && ({ ...picked, inspection: retainPackage(picked.inspection, windowId) }));
      case "installPackage": return view.installPackage?.(packageFor(args[0], windowId));
      case "prepareOfficialPluginInstall": return view.prepareOfficialPluginInstall?.(args[0] as string).then(prepared => ({ ...prepared, inspection: retainPackage(prepared.inspection, windowId) }));
      case "uninstallInstalledPlugin": return view.uninstallInstalledPlugin?.(args[0] as string);
      case "checkInstalledPluginUpdates": return view.checkInstalledPluginUpdates?.();
      case "prepareInstalledPluginUpdate": return view.prepareInstalledPluginUpdate?.(args[0] as PluginUpdateOffer).then(prepared => ({ ...prepared, inspection: retainPackage(prepared.inspection, windowId) }));
      case "updateInstalledPlugin": return view.updateInstalledPlugin?.({ ...args[0] as PreparedPluginUpdate, inspection: packageFor((args[0] as PreparedPluginUpdate).inspection, windowId) });
      case "discardPreparedPackages": {
        for (const [handle, retained] of packages) if (retained.windowId === windowId) packages.delete(handle);
        return;
      }
      case "closePanel": return runtime.panels.closePanel(windowId);
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
      case "closeDetachedPanel": return runtime.panels.closeDetachedPanel(args[0] as string, args[1] as string, windowId);
      case "detachPanel": return runtime.panels.detachPanel(args[0] as string, args[1] as string, windowId);
      case "reattachPanel": return runtime.panels.reattachPanel(args[0] as string, args[1] as string, windowId);
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
        const current = runtime.getCanvasOverlayDraftRestore(args[0] as string, windowId);
        if (args[1] !== undefined && (!current || restoreTokens.get(current) !== args[1])) return false;
        return runtime.clearCanvasOverlayDraftRestore(args[0] as string, current, windowId);
      }
      case "closeProposalDocumentTab": return runtime.closeProposalDocumentTab(args[0] as string, args[1] as string, windowId);
      case "proposalDocumentTab": return proposalWindow(args[0] as string) === windowId ? runtime.proposalDocumentTab(args[0] as string) : undefined;
      case "listCanvasOverlays": return runtime.listCanvasOverlays();
      case "screenCaptureOf": {
        assertProposalOwner(args[0] as string, windowId);
        return !!runtime.host.recognitionScreenCaptureOf(args[0] as string);
      }
      case "previewImageChunk": {
        const retained = [...previewSources.values()].find(source => source.token === args[0]);
        if (!retained) throw new Error("This recognition preview is no longer pending.");
        if (retained.windowId !== windowId) throw new Error("This recognition preview belongs to another document window.");
        const offset = args[1] as number;
        return retained.source.slice(offset, offset + 256 * 1024);
      }
      case "acceptProposal": {
        assertProposalOwner(args[0] as string, windowId);
        if (!broker.supportsImmediate) throw new Error("Use the captured asynchronous proposal commit.");
        return owner.acknowledgePreparedProposal(args[0] as string);
      }
      case "rejectProposal": {
        assertProposalOwner(args[0] as string, windowId);
        return runtime.host.rejectProposedPatch(args[0] as string);
      }
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
      const title = request.titles.find(tab => tab.id === request.target.tabId)?.title;
      if (title) documentNames.set(sender, title);
      publishState();
      return null;
    }),
    broker.handle("acceptPreparedProposal", async (request, sender) => {
      const target = runtime.proposalDocumentTab(request.proposalId);
      if (sender !== request.target.windowId || target?.id !== request.target.tabId || proposalWindow(request.proposalId) !== sender) {
        throw new Error("The proposal does not belong to this document target.");
      }
      const uncertain = uncertainAcceptances.get(request.proposalId);
      if (uncertain) {
        if (uncertain.sender !== sender) throw new Error("The proposal acceptance belongs to another document window.");
        // A retry first resolves the old reservation, never authorizes a second insertion while
        // the first outcome is unknown. Failed reconciliation leaves that reservation held.
        if (await reconcileAcceptance(uncertain)) return null;
      }
      const token = runtime.host.reserveProposedPatchAcceptance(request.proposalId);
      try {
        const committed = await broker.call(sender, "commitProposal", request);
        if (!committed) throw new Error("The proposal's prepared document commit was cancelled.");
      } catch (cause) {
        const attempt = { request, sender, token };
        uncertainAcceptances.set(request.proposalId, attempt);
        // A missing reply does not mean the synchronous document mutation failed. Reconcile its
        // retained receipt before freeing the reservation; a negative reply also revokes late work.
        if (!await reconcileAcceptance(attempt)) throw cause;
        return null;
      }
      runtime.host.settleProposedPatchAcceptance(request.proposalId, token, true);
      return null;
    }),
    broker.handle("getRuntimeView", (_request, sender) => encodeRuntimeView({ state: snapshot(sender), topics: topics(sender) })),
    broker.handle("runtimeViewAction", (request, sender) => {
      try {
        const result = action(request, sender);
        return result instanceof Promise ? result.then(success, failure) : success(result);
      } catch (cause) { return failure(cause); }
    }),
    owner.subscribe(publishState),
    runtime.naming.subscribe(() => publish("naming", { status: runtime.naming.getStatus(), run: runtime.naming.getInstallRun(), activity: runtime.naming.getActivity() })),
    runtime.subscribeCanvasOverlayStatus(() => publishForWindow("overlayStatus", windowId => topics(windowId).overlayStatus)),
    runtime.subscribeCanvasOverlayTranscript(() => publishForWindow("overlayTranscript", windowId => topics(windowId).overlayTranscript)),
    runtime.subscribeCanvasOverlayContent(() => publishForWindow("overlayContent", windowId => topics(windowId).overlayContent)),
    runtime.subscribeCanvasOverlayOpen(() => publishForWindow("overlayOpen", windowId => topics(windowId).overlayOpen)),
    runtime.recognition.subscribeActivity(() => publishForWindow("activity", activityForWindow)),
    runtime.recognition.subscribe(() => publish("progress", runtime.recognition.getInstallRun()))
  ];
  // Proposal notifications are a separate callback from PluginHost.subscribe.
  return Object.assign(() => {
    for (const stop of stops) stop();
    packages.clear();
    previewSources.clear();
    uncertainAcceptances.clear();
  }, { publish: () => {
    publishState();
    for (const windowId of clients()) for (const [topic, value] of Object.entries(topics(windowId))) {
      void broker.broadcastView([windowId], topic, encodeRuntimeView(value)).catch(() => undefined);
    }
  } });

}
