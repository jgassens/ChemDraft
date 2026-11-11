import { computePropertiesForPlugin } from "./pluginProperties";
import { PluginStructureToNameRequestSchema } from "@chemdraft/plugin-api";
import { inspectStructureOffThread } from "../depiction2d/identityClient";
import type { AssistantToolContext } from "../assistant/AssistantToolContext";
import { AssistantToolsController, type AssistantToolsControllerOptions } from "../assistant/AssistantToolsController";
import { TauriAssistantMcpEngine, UnsupportedAssistantMcpEngine, type AssistantMcpEngine } from "../assistant/assistantMcpEngine";
import { getAssistantHistoryPort } from "../assistant/historyPort";
import { buildPluginTablePatch } from "./buildPluginTablePatch";
import { rasterizeSvgNative } from "../nativeRasterExport";
import { nameStructureForPlugin } from "./pluginStructureNaming";
import { StructureNamingController } from "./StructureNamingController";
import { TauriStructureNamingEngine, type StructureNamingEngine } from "./structureNamingEngine";
import { scopedNamingMolecule, type NamingCanonicalizer } from "./pluginStructureNaming";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type {
  AppliedPatchReceipt,
  PluginIsotopeEnvelopeRequest,
  PluginIsotopeEnvelopeResult,
  PluginNameToStructureRequest,
  PluginCommandContext,
  PluginCommandInput,
  PluginOverlayTranscriptEntry,
  PluginNameToStructureResult,
  PluginStructureFromSmilesRequest,
  PluginStructureFromSmilesResult,
  PluginManifest,
  PluginPermission,
  PluginSelectionSnapshot,
  PluginStorage,
  PluginToolsetContribution
} from "@chemdraft/plugin-api";
import {
  PluginHost,
  validateTrustedPluginManifest,
  type CommandRegistry,
  type PluginPatchApplicationRequest,
  type PluginInvocationDocumentProvider,
  type RegisterPluginOptions
} from "@chemdraft/plugin-host";

import type { RegisteredCanvasOverlay } from "./types";
import type { CanvasOverlayContentSection, CanvasOverlayDraftRestore } from "./pluginCanvasOverlayControls";

import type { DesktopToolsetDefinition } from "../toolsets";
import { PluginPanelController } from "./PluginPanelController";
import { PluginPromptTextController } from "./PluginPromptTextController";
import { createDefaultImageSourceRegistry, type ImageSourceRegistry } from "./ImageSourceProvider";
import { PluginImageRequestController } from "./PluginImageRequestController";
import { StructureRecognitionController } from "./StructureRecognitionController";
import {
  TauriStructureRecognitionEngine,
  UnsupportedStructureRecognitionEngine,
  type StructureRecognitionEngine
} from "./structureRecognitionEngine";
import { preparePluginStructureRecognition, type RecognitionStructureValidator } from "./pluginStructureRecognition";
import { isTauriHost } from "./pluginStagingFs";
import { ExternalToolsController } from "../externalTools/ExternalToolsController";
import { TauriExternalToolsEngine, UnsupportedExternalToolsEngine, type ExternalToolsEngine } from "../externalTools/externalToolsEngine";
import {
  computeIsotopeEnvelopeForPlugin,
  nameToStructureForPlugin,
  createChemistry3dProviders,
  structureFromSmilesForPlugin
} from "./pluginChemistry";
import { chemistry3dReplyLogRequestedFromWindow } from "../chemistry3d/client";
import { configureChemistry3dReplyLogger } from "./PluginWorkerBridge";

/** Serves an isotope envelope to a plugin holding `chemistry.compute`. */
export type DesktopIsotopeEnvelopeProvider = (
  request: PluginIsotopeEnvelopeRequest
) => Promise<PluginIsotopeEnvelopeResult>;

/** Serves name → structure to a plugin holding `chemistry.compute`. */
export type DesktopNameToStructureProvider = (
  request: PluginNameToStructureRequest
) => Promise<PluginNameToStructureResult>;

/** Lays a SMILES out as a document object for a plugin holding `chemistry.compute`. */
export type DesktopStructureFromSmilesProvider = (
  request: PluginStructureFromSmilesRequest
) => Promise<PluginStructureFromSmilesResult>;

function freezeOverlayContent(sections: CanvasOverlayContentSection[]): readonly CanvasOverlayContentSection[] {
  const snapshot = structuredClone(sections);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

export interface DesktopPluginRuntimeOptions {
  /** Optional injection seam; default providers use the existing in-process conformer worker. */
  chemistry3d?: import("../chemistry3d/client").Chemistry3dProviders;
  /** Reads the current active document. Called on demand; must reflect the latest state. */
  getActiveDocument: () => ChemDraftDocument | undefined;
  /**
   * Identifies the working document so a plugin's `documents.applyPatch` lands only in the document its
   * command was invoked on (see `PluginHostOptions.getActiveDocumentKey`). It must stay the same across
   * edits and undo and change on File > New/Open or a switch to another document. The embedding window
   * knows that best — e.g. a counter it bumps whenever it replaces the document history rather than
   * pushing onto it. Without one, the runtime falls back to {@link documentIdentityKey}.
   */
  getActiveDocumentKey?: () => string | undefined;
  /** Desktop tab ownership, captured when a command starts even if its proposal arrives later. */
  getActiveDocumentTab?: () => Pick<ProposalDocumentTab, "id">;
  /** Reads the latest title of an open tab at display time. */
  getDocumentTabTitle?: (tabId: string) => string | undefined;
  /**
   * Builds an immutable selection snapshot from current desktop state. `warnings` is the collector of
   * the command invocation that asked (see {@link DesktopPluginRuntime.invokeCommand}); it is
   * undefined for a read made outside one, which should stay silent.
   */
  getSelection?: (warnings?: string[]) => PluginSelectionSnapshot | undefined;
  /**
   * The app's stable CommandRegistry (see commands/coreCommandRegistrar). When supplied, plugin
   * commands register into the SAME registry core commands live in, so one `host.invokeCommand`
   * dispatches both — with the plugin's permission context when the command is plugin-owned.
   * Defaults to a host-private registry (tests, headless use).
   */
  commandRegistry?: CommandRegistry;
  /** Storage backend factory (the desktop passes the disk-backed one); defaults to in-memory. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Fired whenever the proposed-patch queue changes (new, accepted, rejected). */
  onProposedPatchesChanged?: () => void;
  /** Commits a command-scoped `document.write` patch through the desktop document/history path. */
  applyDocumentPatch?: (
    request: PluginPatchApplicationRequest
  ) => AppliedPatchReceipt | Promise<AppliedPatchReceipt>;
  /** Desktop routes every report straight to its native window; web keeps the in-app fallback. */
  defaultPanelSurface?: "inApp" | "window";
  /**
   * Serves `chemistry.compute`. Defaults to the real engine-backed implementation; injectable so tests
   * can drive the capability without standing up an analysis worker. Passing `null` withholds it, which
   * is how a host with no engines is modelled — the plugin then sees no `chemistry` API at all.
   */
  computeIsotopeEnvelope?: DesktopIsotopeEnvelopeProvider | null;
  /** Serves name → structure under the same permission and the same null-withholds rule. */
  convertNameToStructure?: DesktopNameToStructureProvider | null;
  /** Serves 2D layout under the same permission and the same null-withholds rule. */
  buildStructureFromSmiles?: DesktopStructureFromSmilesProvider | null;
  /** Image-provider registry; injectable for tests and future platform/provider additions. */
  imageSourceRegistry?: ImageSourceRegistry;
  /** Local OCSR engine port; injectable for tests and future platform engines. */
  structureRecognitionEngine?: StructureRecognitionEngine;
  structureNamingEngine?: StructureNamingEngine;
  /** Native external-tools boundary; injectable so runtime tests do not require Tauri IPC. */
  externalToolsEngine?: ExternalToolsEngine;
  assistantMcpEngine?: AssistantMcpEngine;
  forwardUnboundCommand?: DesktopPluginRuntime["invokeCommand"];
  captureAssistantRequest?: AssistantToolsControllerOptions["captureRequest"];
  assistantContext?: AssistantToolsControllerOptions["createContext"];
  assistantTransactions?: AssistantToolsControllerOptions["transactions"];
  runAssistantWrite?: AssistantToolsControllerOptions["runWrite"];
  getAssistantViewportRect?: AssistantToolContext["getViewportRect"];
  getAssistantDocument?: AssistantToolsControllerOptions["readDocument"];
  namingCanonicalizer?: NamingCanonicalizer;
  /** Chemistry validation seam used after recognition and before a proposal is built. */
  recognitionStructureValidator?: RecognitionStructureValidator;
  /** Injectable clock (tests pass a fixed value); defaults to wall-clock. */
  now?: () => Date | string;
}

/**
 * Manifest permissions that exist in the SDK but do not yet have a safe desktop capability broker.
 *
 * In particular, installed workers run under a CSP that blocks arbitrary external egress. Claiming
 * `network.fetch` in a manifest therefore cannot truthfully make that capability available yet. Keep
 * the permission name reserved for the future broker, but fail closed instead of reporting a grant the
 * worker cannot use.
 */
export const unavailableDesktopPluginPermissions = ["network.fetch"] as const satisfies readonly PluginPermission[];

export function getUnavailableDesktopPluginPermissions(
  manifest: Pick<PluginManifest, "permissions">
): PluginPermission[] {
  const unavailable = new Set<PluginPermission>(unavailableDesktopPluginPermissions);
  return manifest.permissions.filter((permission) => unavailable.has(permission));
}

function assertDesktopPluginPermissionsAvailable(manifest: PluginManifest): void {
  const unavailable = getUnavailableDesktopPluginPermissions(manifest);
  if (unavailable.length > 0) {
    throw new Error(
      `Plugin "${manifest.id}" declares ${unavailable.join(", ")}, but ${
        unavailable.length === 1 ? "that permission is" : "those permissions are"
      } reserved and unavailable in this ChemDraft build.`
    );
  }
}

/**
 * The persistent desktop plugin runtime: one {@link PluginHost}, the panel controller that renders
 * its reports, and the toolset-contribution stage that turns `contributes.toolsets` into desktop
 * toolbar definitions. Create it once (see `usePluginRuntime`) and feed current document/selection
 * through the provider callbacks — never rebuild it when the document, selection, page, viewport, or
 * undo history changes.
 *
 * All desktop registration paths (bundled, installed, fixture) go through {@link registerPlugin} /
 * {@link unregisterPlugin} rather than the host directly, so toolset provenance stays accurate and
 * a bad contribution rolls the whole plugin back no matter how it arrived.
 */
export interface DesktopPluginRuntime {
  host: PluginHost;
  panels: PluginPanelController;
  prompts: PluginPromptTextController;
  images: PluginImageRequestController;
  recognition: StructureRecognitionController;
  naming: StructureNamingController;
  externalTools: ExternalToolsController;
  assistant: AssistantToolsController;
  updateDocumentTabTitles(titles: readonly { id: string; title: string }[], windowId?: string): void;
  proposalDocumentTab(proposalId: string): ProposalDocumentTab | undefined;
  /** Retain the final title while pending proposals or running commands reference a closed tab. */
  closeProposalDocumentTab(tabId: string, title: string, windowId?: string): void;
  /**
   * Register a plugin and stage its toolset contributions: `ui.toolbar` is enforced before any
   * toolbar surface exists, duplicate toolset ids across plugins are rejected, and any failure
   * unregisters the whole plugin so half-registered state can never leak into the catalog.
   * Provenance is tracked by explicit maps, never by sniffing id prefixes.
   */
  registerPlugin(candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  /** Replace one registration transactionally; if the new contribution fails, restore the prior one. */
  replacePlugin(pluginId: string, candidate: unknown, options?: RegisterPluginOptions): PluginManifest;
  unregisterPlugin(pluginId: string): void;
  /**
   * Invoke a command through the host. `selectionWarnings` collects what the snapshot could not carry
   * faithfully for the selection reads THIS invocation makes, and only those: another plugin reading
   * the selection meanwhile, or this one reading it after its own patch changed the document, can
   * neither add to it nor take from it.
   */
  invokeCommand(commandId: string, options?: { selectionWarnings?: string[]; input?: PluginCommandInput;
    documentProvider?: PluginInvocationDocumentProvider; writeSelection?: PluginSelectionSnapshot }): Promise<unknown>;
  openDocumentWindow(windowId: string): void;
  closeDocumentWindow(windowId: string): void;
  listCanvasOverlays(): RegisteredCanvasOverlay[];
  getCanvasOverlayStatuses(windowId?: string): ReadonlyMap<string, string>;
  /** Subscribe to status-only overlay updates without invalidating plugin contributions/toolsets. */
  subscribeCanvasOverlayStatus(listener: () => void): () => void;
  getCanvasOverlayTranscripts(windowId?: string): ReadonlyMap<string, readonly PluginOverlayTranscriptEntry[]>;
  subscribeCanvasOverlayTranscript(listener: () => void): () => void;
  getCanvasOverlayContents(windowId?: string): ReadonlyMap<string, readonly CanvasOverlayContentSection[]>;
  getCanvasOverlayDraftRestore(overlayId: string, windowId?: string): CanvasOverlayDraftRestore | undefined;
  /** Consume a specific restore, or drop any pending restore on user input. */
  clearCanvasOverlayDraftRestore(overlayId: string, expected?: CanvasOverlayDraftRestore, windowId?: string): boolean;
  subscribeCanvasOverlayContent(listener: () => void): () => void;
  getCanvasOverlayOpenRequests(windowId?: string): ReadonlyMap<string, { readonly focus: boolean }>;
  subscribeCanvasOverlayOpen(listener: () => void): () => void;
  listPluginToolsets(): DesktopToolsetDefinition[];
  pluginIdForToolset(toolsetId: string): string | undefined;
  /** Notified when plugin contributions change. Returns unsubscribe. */
  onDidChange(listener: () => void): () => void;
}

export interface ProposalDocumentTab {
  id: string;
  title: string;
  windowId?: string;
}

export function createPluginRuntime(options: DesktopPluginRuntimeOptions): DesktopPluginRuntime {
  configureChemistry3dReplyLogger(
    chemistry3dReplyLogRequestedFromWindow() ? reply => console.info("[chemistry3d reply]", reply) : undefined
  );
  const chemistry3d = options.chemistry3d ?? createChemistry3dProviders();
  const now = options.now ?? (() => new Date());
  const envelopeProvider =
    options.computeIsotopeEnvelope === undefined ? computeIsotopeEnvelopeForPlugin : options.computeIsotopeEnvelope;
  const nameProvider =
    options.convertNameToStructure === undefined ? nameToStructureForPlugin : options.convertNameToStructure;
  // Bound to the runtime's own document getter: layout needs the page it is being placed on, and a
  // plugin must not be able to name a different document than the one the host is showing.
  let structureSignal: AbortSignal | undefined;
  const structureProvider =
    options.buildStructureFromSmiles === undefined
      ? async (request: PluginStructureFromSmilesRequest, provider?: PluginInvocationDocumentProvider) => {
          const signal = structureSignal;
          // Read through the captured invocation. Engine work receives only detached document data.
          const document = provider ? await provider.getDocument() : options.getActiveDocument();
          signal?.throwIfAborted();
          return structureFromSmilesForPlugin(request, () => document, signal);
        }
      : options.buildStructureFromSmiles;
  const nowIso = (): string => {
    const value = now();
    return typeof value === "string" ? value : value.toISOString();
  };

  // The host and controller reference each other: the host forwards validated reports to the
  // controller, and the controller reads manifests back off the host. Close the loop with a
  // late-bound reference so neither construction depends on the other existing first.
  let controller: PluginPanelController | undefined;
  const prompts = new PluginPromptTextController();
  const images = new PluginImageRequestController(
    options.imageSourceRegistry ?? createDefaultImageSourceRegistry()
  );
  const recognitionEngine =
    options.structureRecognitionEngine ??
    (isTauriHost() ? new TauriStructureRecognitionEngine() : new UnsupportedStructureRecognitionEngine());
  // The prepared result carries `hostReview` (the agreement-capped tier). The controller returns that
  // same object to `recognizeStructure` below, and the plugin host keeps the review with the
  // recognition and strips it before the plugin sees the result.
  const recognition = new StructureRecognitionController(recognitionEngine, (outcome, image) =>
    options.recognitionStructureValidator
      ? preparePluginStructureRecognition(
          outcome,
          image,
          options.getActiveDocument(),
          options.recognitionStructureValidator
        )
      : preparePluginStructureRecognition(outcome, image, options.getActiveDocument())
  );
  // Selection warnings are scoped to the invocation, not guessed from which snapshot or document a
  // read touched. The host builds an invocation's context synchronously inside `invokeCommand`
  // (registry → handler wrapper → `createCommandContext`, no await between), so a collector armed
  // around that call is claimed by exactly that invocation's context. Its selection API then hands the
  // collector to the snapshot builder for the synchronous span of each read, and nothing else can.
  const naming = new StructureNamingController(options.structureNamingEngine ?? new TauriStructureNamingEngine(), options.namingCanonicalizer);
  const externalTools = new ExternalToolsController(options.externalToolsEngine ?? (isTauriHost() ? new TauriExternalToolsEngine() : new UnsupportedExternalToolsEngine()));
  const assistant = new AssistantToolsController({
    captureRequest: options.captureAssistantRequest,
    host: (): PluginHost => host,
    engine: options.assistantMcpEngine ?? (isTauriHost() ? new TauriAssistantMcpEngine() : new UnsupportedAssistantMcpEngine()),
    getActiveTabId: () => options.getActiveDocumentTab?.().id,
    getSelectionIds: () => options.getActiveDocument()?.selection.objectIds ?? [],
    runWrite: options.runAssistantWrite ?? (apply => {
      const port = getAssistantHistoryPort();
      if (!port.runWrite) throw new Error("The document window provides no assistant write gate.");
      return port.runWrite(apply);
    }),
    readDocument: options.getAssistantDocument ?? (tabId => getAssistantHistoryPort().read(tabId)),
    transactions: options.assistantTransactions,
    createContext: options.assistantContext ?? (({ getDocument }) => {
      // These services live for the assistant request, beyond the command that begins it. The
      // controller owns tool cancellation but exposes no signal here; never capture a command's.
      return ({
      getViewportRect: options.getAssistantViewportRect ?? (tabId => getAssistantHistoryPort().getViewportRect?.(tabId)),
      now: options.now ?? (() => new Date()),
      render: (svg, settings) => rasterizeSvgNative(svg, "png", settings),
      chemistry: {
        nameToStructure: request => nameProvider ? nameProvider(request) : Promise.resolve({ available: false, reason: "Name-to-structure engine unavailable." }),
        structureFromSmiles: request => options.buildStructureFromSmiles === null ?
          Promise.resolve({ available: false, reason: "Structure layout engine unavailable." }) :
          options.buildStructureFromSmiles ? options.buildStructureFromSmiles(request) : structureFromSmilesForPlugin(request, getDocument),
        inspectStructure: inspectStructureOffThread,
        structureToName: async request => {
          const engine = options.structureNamingEngine ?? new TauriStructureNamingEngine();
          const status = await engine.status();
          if (status.state === "unsupported") return { status: "unsupported", reason: status.detail ?? "This computer cannot run the naming engine." };
          if (status.state !== "installed") return { status: "engineNotInstalled" };
          const molecule = getDocument()?.pages.flatMap(page => page.objects).find(object => object.id === request.objectId);
          if (!molecule || molecule.type !== "molecule") throw new Error("The requested molecule is unavailable.");
          return nameStructureForPlugin(molecule, engine, status, options.namingCanonicalizer);
        }
      }
    }); })
  });
  const commandInvocations = new Map<symbol, { pluginId: string; stop: AbortController }>();
  let commandFrame: symbol[] | undefined;
  let armedSelectionWarnings: string[] | undefined;
  let readingSelectionWarnings: string[] | undefined;
  const documentTitles = new Map<string, Map<string, string>>();
  const proposalTabs = new Map<string, string>();
  const proposalWindows = new Map<string, string>();
  const closedTabTitles = new Map<string, string>();
  const runningTabCommands = new Map<string, number>();
  const pruneClosedTabTitles = () => {
    const pendingTabs = new Set([...proposalTabs].map(([proposalId, tabId]) => JSON.stringify([proposalWindows.get(proposalId) ?? "", tabId])));
    for (const id of closedTabTitles.keys()) {
      if (!pendingTabs.has(id) && !runningTabCommands.has(id)) closedTabTitles.delete(id);
    }
  };
  let proposingTabId: string | undefined;
  let proposingWindowId: string | undefined;
  class DesktopPluginHost extends PluginHost {
    override async invokeCommand<Result = unknown>(commandId: string, invokeOptions?: Parameters<PluginHost["invokeCommand"]>[1]): Promise<Result> {
      if (!invokeOptions?.documentProvider && options.forwardUnboundCommand && this.commands.get(commandId)?.pluginId) {
        return await options.forwardUnboundCommand(commandId, invokeOptions) as Result;
      }
      return this.withInvocationFrame(() => super.invokeCommand<Result>(commandId, invokeOptions), undefined, invokeOptions?.documentProvider?.target);
    }

    override async invokeAssistantTool(...args: Parameters<PluginHost["invokeAssistantTool"]>) {
      return this.withInvocationFrame(() => super.invokeAssistantTool(...args), args[2]);
    }

    private async withInvocationFrame<Result>(run: () => Promise<Result>, signal?: AbortSignal, target?: PluginInvocationDocumentProvider["target"]): Promise<Result> {
      const tabId = target?.tabId ?? options.getActiveDocumentTab?.().id;
      const tabKey = tabId ? JSON.stringify([target?.windowId ?? "", tabId]) : undefined;
      if (tabKey) runningTabCommands.set(tabKey, (runningTabCommands.get(tabKey) ?? 0) + 1);
      const tokens: symbol[] = [];
      const previousFrame = commandFrame;
      commandFrame = tokens;
      const cancel = () => { for (const token of tokens) commandInvocations.get(token)?.stop.abort(); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        let call: Promise<Result>;
        try { call = run(); } finally { commandFrame = previousFrame; }
        return await call;
      } finally {
        signal?.removeEventListener("abort", cancel);
        for (const token of tokens) { commandInvocations.get(token)?.stop.abort(); commandInvocations.delete(token); }
        if (tabKey) {
          const remaining = (runningTabCommands.get(tabKey) ?? 1) - 1;
          if (remaining > 0) runningTabCommands.set(tabKey, remaining);
          else runningTabCommands.delete(tabKey);
        }
        pruneClosedTabTitles();
      }
    }

    override unregisterPlugin(pluginId: string): void {
      for (const [token, invocation] of commandInvocations) {
        if (invocation.pluginId === pluginId) { invocation.stop.abort(); commandInvocations.delete(token); }
      }
      super.unregisterPlugin(pluginId);
    }

    override createCommandContext(pluginId: string, invocationToken?: symbol, input?: PluginCommandInput): PluginCommandContext {
      const context = super.createCommandContext(pluginId, invocationToken, input);
      const provider = this.invocationDocumentProvider(invocationToken);
      if (invocationToken && commandFrame) {
        commandFrame.push(invocationToken);
        commandInvocations.set(invocationToken, { pluginId, stop: new AbortController() });
      }
      const commandSignal = invocationToken ? commandInvocations.get(invocationToken)?.stop.signal : undefined;
      // The host validates permissions and parses synchronously before calling the provider.
      // Arm only that synchronous span, so concurrent commands retain independent signals.
      const withStructureSignal = <T,>(call: () => T): T => {
        const previous = structureSignal;
        structureSignal = commandSignal;
        try { return call(); } finally { structureSignal = previous; }
      };
      if (context.chemistry?.structureFromSmiles) {
        const build = context.chemistry.structureFromSmiles;
        context.chemistry.structureFromSmiles = request => withStructureSignal(() => build(request));
      }
      const permissions = ["chemistry.compute", "native.execute", "selection.read"] as const;
      if (context.chemistry && (isTauriHost() || options.structureNamingEngine) && permissions.every(permission => this.hasPermission(pluginId, permission))) {
        const getKey = provider?.getDocumentKey ?? options.getActiveDocumentKey ?? (() => documentIdentityKey(options.getActiveDocument()));
        const documentKey = getKey();
        context.chemistry.structureToName = async request => {
          for (const permission of permissions) this.requirePermission(pluginId, permission);
          const invocation = invocationToken ? commandInvocations.get(invocationToken) : undefined;
          if (!invocation || invocation.pluginId !== pluginId || invocation.stop.signal.aborted) throw new Error("Structure naming is available only during this plugin command invocation.");
          const parsed = PluginStructureToNameRequestSchema.parse(request);
          if (documentKey !== getKey()) throw new Error("The active document changed during the naming command.");
          const [document, selection] = provider
            ? await Promise.all([provider.getDocument(), provider.getSelection({ collectWarnings: false })])
            : [options.getActiveDocument(), options.getSelection?.()];
          invocation.stop.signal.throwIfAborted();
          const molecule = scopedNamingMolecule(document, selection, parsed.objectId);
          const manifest = this.listPlugins().find(plugin => plugin.id === pluginId)!;
          return naming.name(manifest, molecule, invocation.stop.signal, provider?.target && documentKey ? { ...provider.target, documentKey } : undefined);
        };
      }
      const tabId = provider?.target?.tabId ?? options.getActiveDocumentTab?.().id;
      const proposePatch = context.documents.proposePatch;
      context.documents.proposePatch = (proposal) => {
        // The host enqueues synchronously before returning its promise. Scope the queue notification
        // to this context, so concurrent commands and late results retain their own source tab.
        const previous = proposingTabId;
        const previousWindow = proposingWindowId;
        proposingTabId = tabId;
        proposingWindowId = provider?.target?.windowId;
        try {
          return proposePatch(proposal);
        } finally {
          proposingTabId = previous;
          proposingWindowId = previousWindow;
        }
      };
      const collector = armedSelectionWarnings;
      armedSelectionWarnings = undefined;
      const selection = context.selection;
      if (!selection || !collector) return context;
      return {
        ...context,
        selection: {
          getSelection: () => {
            readingSelectionWarnings = collector;
            try {
              return selection.getSelection();
            } finally {
              readingSelectionWarnings = undefined;
            }
          }
        }
      };
    }
  }
  const closedWindows = new Set<string>();
  const overlayStates = new Map<string, ReturnType<typeof newOverlayState>>();
  function newOverlayState() {
    return {
      canvasOverlayStatuses: new Map<string, string>(),
      canvasOverlayTranscripts: new Map<string, readonly PluginOverlayTranscriptEntry[]>(),
      canvasOverlayContents: new Map<string, readonly CanvasOverlayContentSection[]>(),
      canvasOverlayDraftRestores: new Map<string, CanvasOverlayDraftRestore>(),
      canvasOverlayOpenRequests: new Map<string, { readonly focus: boolean }>()
    };
  }
  const overlayState = (windowId = "main") => {
    let state = overlayStates.get(windowId);
    if (!state) { state = newOverlayState(); overlayStates.set(windowId, state); }
    return state;
  };
  const canvasOverlayContentListeners = new Set<() => void>();
  const notifyCanvasOverlayContent = () => canvasOverlayContentListeners.forEach(listener => listener());
  const canvasOverlayOpenListeners = new Set<() => void>();
  const notifyCanvasOverlayOpen = () => canvasOverlayOpenListeners.forEach(listener => listener());
  const canvasOverlayTranscriptListeners = new Set<() => void>();
  const notifyCanvasOverlayTranscript = () => canvasOverlayTranscriptListeners.forEach(listener => listener());
  const listeners = new Set<() => void>();
  const canvasOverlayStatusListeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const notifyCanvasOverlayStatus = () => canvasOverlayStatusListeners.forEach((listener) => listener());
  const readSelection = options.getSelection;
  const host = new DesktopPluginHost({
    ...chemistry3d,
    commandRegistry: options.commandRegistry,
    overlays: {
      setContent: (pluginId, overlayId, sections, prompt, provider) => {
        const windowId = provider?.target?.windowId ?? "main";
        if (closedWindows.has(windowId)) return;
        const { canvasOverlayContents, canvasOverlayDraftRestores } = overlayState(windowId);
        const declared = host.getPlugin(pluginId)!.manifest.contributes.canvasOverlays!.find(overlay => overlay.id === overlayId)!.prompt;
        const disabled = prompt?.disabled ?? false;
        // The internal prompt section feeds the existing composer and command-dispatch guard.
        // Content is replaceable; a restore survives updates until consumed or user input drops it.
        if (prompt?.restoreDraft !== undefined) {
          canvasOverlayDraftRestores.set(overlayId, Object.freeze({ text: prompt.restoreDraft }));
        }
        const content: CanvasOverlayContentSection[] = disabled || declared.disabled
          ? [...sections, { ...declared, disabled }] : sections;
        if (content.length === 0) {
          const deleted = canvasOverlayContents.delete(overlayId);
          if (!deleted && prompt?.restoreDraft === undefined) return;
        } else {
          canvasOverlayContents.set(overlayId, freezeOverlayContent(content));
        }
        notifyCanvasOverlayContent();
      },
      open: (_pluginId, overlayId, focus, provider) => {
        const windowId = provider?.target?.windowId ?? "main";
        if (closedWindows.has(windowId)) return;
        const { canvasOverlayOpenRequests } = overlayState(windowId);
        // A new identity for each request also makes repeated focus:true observable.
        canvasOverlayOpenRequests.set(overlayId, Object.freeze({ focus }));
        notifyCanvasOverlayOpen();
      },
      setTranscript: (_pluginId, overlayId, entries, provider) => {
        const windowId = provider?.target?.windowId ?? "main";
        if (closedWindows.has(windowId)) return;
        const { canvasOverlayTranscripts } = overlayState(windowId);
        if (entries.length === 0) {
          if (!canvasOverlayTranscripts.delete(overlayId)) return;
        } else {
          canvasOverlayTranscripts.set(overlayId, Object.freeze(entries.map(entry => Object.freeze({ ...entry }))));
        }
        notifyCanvasOverlayTranscript();
      },
      setStatus: (_pluginId, overlayId, text, provider) => {
        const windowId = provider?.target?.windowId ?? "main";
        if (closedWindows.has(windowId)) return;
        const { canvasOverlayStatuses } = overlayState(windowId);
        if (text === "") {
          if (!canvasOverlayStatuses.delete(overlayId)) return;
        } else {
          if (canvasOverlayStatuses.get(overlayId) === text) return;
          canvasOverlayStatuses.set(overlayId, text);
        }
        notifyCanvasOverlayStatus();
      }
    },
    getActiveDocument: options.getActiveDocument,
    getActiveDocumentKey:
      options.getActiveDocumentKey ?? (() => documentIdentityKey(options.getActiveDocument())),
    getSelection: readSelection ? () => readSelection(readingSelectionWarnings) : undefined,
    createStorage: options.createStorage,
    onProposedPatchesChanged: () => {
      const pending = host.listProposedPatches("pending");
      const pendingIds = new Set(pending.map((proposal) => proposal.id));
      for (const id of proposalTabs.keys()) {
        if (!pendingIds.has(id)) { proposalTabs.delete(id); proposalWindows.delete(id); }
      }
      for (const proposal of pending) {
        if (proposalTabs.has(proposal.id)) continue;
        // Trusted desktop callers of host.proposePatch have no invocation context.
        const tabId = proposingTabId ?? options.getActiveDocumentTab?.().id;
        if (tabId) {
          proposalTabs.set(proposal.id, tabId);
          if (proposingWindowId) proposalWindows.set(proposal.id, proposingWindowId);
        }
      }
      pruneClosedTabTitles();
      options.onProposedPatchesChanged?.();
    },
    applyDocumentPatch: options.applyDocumentPatch,
    buildTablePatch: async (spec, document, selection, _viewport, provider) => {
      if (provider) return buildPluginTablePatch(spec, document, selection, await provider.getViewportRect?.());
      const tabId = options.getActiveDocumentTab?.().id;
      const viewport = tabId ? (options.getAssistantViewportRect ?? (id => getAssistantHistoryPort().getViewportRect?.(id)))(tabId) : undefined;
      return buildPluginTablePatch(spec, document, selection, viewport);
    },
    showPanelReport: (pluginId, panelId, report, provider) => {
      controller?.showReport(pluginId, panelId, report, provider?.target?.windowId);
    },
    promptText: (plugin, request, signal, provider) => prompts.promptText(plugin, request, signal, provider?.target?.windowId),
    requestImage: (plugin, request, signal, provider) => images.requestImage(plugin, request, signal, provider?.target?.windowId),
    recognizeStructure: (plugin, image, signal, provider) => recognition.recognize(plugin, image, signal, provider
      ? async (outcome, source) => {
          const document = await provider.getDocument();
          signal.throwIfAborted();
          return preparePluginStructureRecognition(outcome, source, document, options.recognitionStructureValidator);
        } : undefined, provider?.target?.windowId),
    externalTools,
    assistant,
    computeProperties: computePropertiesForPlugin,
    ...(envelopeProvider ? { computeIsotopeEnvelope: envelopeProvider } : {}),
    ...(nameProvider ? { convertNameToStructure: nameProvider } : {}),
    ...(structureProvider ? { buildStructureFromSmiles: structureProvider } : {}),
    now
  });
  controller = new PluginPanelController(host, nowIso, options.defaultPanelSurface);

  const toolsetsByPluginId = new Map<string, DesktopToolsetDefinition[]>();
  const pluginIdByToolsetId = new Map<string, string>();
  const registrations = new Map<string, { manifest: PluginManifest; options: RegisterPluginOptions }>();

  const runtime: DesktopPluginRuntime = {
    host,
    panels: controller,
    prompts,
    images,
    recognition,
    naming,
    externalTools,
    assistant,
    updateDocumentTabTitles(titles, windowId = "") { documentTitles.set(windowId, new Map(titles.map(({ id, title }) => [id, title]))); },
    proposalDocumentTab(proposalId) {
      const id = proposalTabs.get(proposalId);
      if (id === undefined) return undefined;
      const windowId = proposalWindows.get(proposalId);
      const title = documentTitles.get(windowId ?? "")?.get(id) ?? options.getDocumentTabTitle?.(id) ?? closedTabTitles.get(JSON.stringify([windowId ?? "", id]));
      return title === undefined ? undefined : { id, title, ...(windowId ? { windowId } : {}) };
    },
    closeProposalDocumentTab(tabId, title, windowId = "") {
      assistant.closeAllForTab(tabId, windowId || "main");
      closedTabTitles.set(JSON.stringify([windowId, tabId]), title);
      pruneClosedTabTitles();
    },
    registerPlugin(candidate, registerOptions = {}) {
      // Validate before touching the shared command registry, then apply the desktop capability policy.
      // This keeps `hasPermission()` honest: an unavailable permission can never reach a registered
      // plugin and momentarily appear granted.
      const validated = validateTrustedPluginManifest(candidate);
      assertDesktopPluginPermissionsAvailable(validated);
      const { manifest } = host.registerPlugin(validated, registerOptions);
      try {
        const contributed = manifest.contributes.toolsets;
        if (contributed.length > 0) {
          host.requirePermission(manifest.id, "ui.toolbar");
          for (const toolset of contributed) {
            if (pluginIdByToolsetId.has(toolset.id)) {
              throw new Error(`Plugin toolset "${toolset.id}" is already contributed by another plugin.`);
            }
          }
          const mapped = contributed.map(pluginToolsetToDefinition);
          toolsetsByPluginId.set(manifest.id, mapped);
          mapped.forEach((toolset) => pluginIdByToolsetId.set(toolset.id, manifest.id));
        }
      } catch (error) {
        // A bad toolset contribution rolls the WHOLE plugin back (commands included), so the
        // catalog can never observe a plugin that half-registered.
        host.unregisterPlugin(manifest.id);
        throw error;
      }
      registrations.set(manifest.id, { manifest, options: registerOptions });
      notify();
      return manifest;
    },
    replacePlugin(pluginId, candidate, registerOptions = {}) {
      const previous = registrations.get(pluginId);
      if (!host.getPlugin(pluginId)) {
        return runtime.registerPlugin(candidate, registerOptions);
      }
      runtime.unregisterPlugin(pluginId);
      try {
        return runtime.registerPlugin(candidate, registerOptions);
      } catch (error) {
        if (previous) {
          runtime.registerPlugin(previous.manifest, previous.options);
        }
        throw error;
      }
    },
    unregisterPlugin(pluginId) {
      host.unregisterPlugin(pluginId);
      (toolsetsByPluginId.get(pluginId) ?? []).forEach((toolset) => pluginIdByToolsetId.delete(toolset.id));
      toolsetsByPluginId.delete(pluginId);
      registrations.delete(pluginId);
      const owned = new Set(host.listCanvasOverlays().map(entry => entry.overlay.id));
      for (const state of overlayStates.values()) {
        for (const values of Object.values(state)) for (const id of values.keys()) if (!owned.has(id)) values.delete(id);
      }
      notifyCanvasOverlayStatus();
      notifyCanvasOverlayTranscript();
      notifyCanvasOverlayContent();
      notifyCanvasOverlayOpen();
      notify();
    },
    invokeCommand(commandId, invokeOptions = {}) {
      if (!invokeOptions.documentProvider && options.forwardUnboundCommand && host.commands.get(commandId)?.pluginId) return options.forwardUnboundCommand(commandId, invokeOptions);
      armedSelectionWarnings = invokeOptions.selectionWarnings;
      try {
        if (invokeOptions.documentProvider) return host.invokeCommand(commandId, { input: invokeOptions.input,
          documentProvider: invokeOptions.documentProvider, writeSelection: invokeOptions.writeSelection });
        return invokeOptions.input === undefined
          ? host.invokeCommand(commandId)
          : host.invokeCommand(commandId, { input: invokeOptions.input });
      } finally {
        // Unclaimed when the command is not a plugin's or failed before its context was built.
        armedSelectionWarnings = undefined;
      }
    },
    openDocumentWindow(windowId) { closedWindows.delete(windowId); controller?.openWindow(windowId); },
    closeDocumentWindow(windowId) {
      closedWindows.add(windowId);
      controller?.closeWindow(windowId);
      assistant.closeAllForWindow(windowId);
      prompts.closeWindow(windowId); images.closeWindow(windowId);
      overlayStates.delete(windowId);
      notifyCanvasOverlayStatus(); notifyCanvasOverlayTranscript(); notifyCanvasOverlayContent(); notifyCanvasOverlayOpen();
    },
    listCanvasOverlays: () => host.listCanvasOverlays(),
    getCanvasOverlayStatuses: windowId => new Map(overlayState(windowId).canvasOverlayStatuses),
    getCanvasOverlayTranscripts: windowId => new Map(overlayState(windowId).canvasOverlayTranscripts),
    getCanvasOverlayContents: windowId => new Map(overlayState(windowId).canvasOverlayContents),
    getCanvasOverlayDraftRestore: (overlayId, windowId) => overlayState(windowId).canvasOverlayDraftRestores.get(overlayId),
    clearCanvasOverlayDraftRestore(overlayId, expected, windowId) {
      const { canvasOverlayDraftRestores } = overlayState(windowId);
      if (expected && canvasOverlayDraftRestores.get(overlayId) !== expected) return false;
      if (!canvasOverlayDraftRestores.delete(overlayId)) return false;
      notifyCanvasOverlayContent();
      return true;
    },
    getCanvasOverlayOpenRequests: windowId => new Map(overlayState(windowId).canvasOverlayOpenRequests),
    subscribeCanvasOverlayContent(listener) {
      canvasOverlayContentListeners.add(listener);
      return () => { canvasOverlayContentListeners.delete(listener); };
    },
    subscribeCanvasOverlayOpen(listener) {
      canvasOverlayOpenListeners.add(listener);
      return () => { canvasOverlayOpenListeners.delete(listener); };
    },
    subscribeCanvasOverlayTranscript(listener) {
      canvasOverlayTranscriptListeners.add(listener);
      return () => { canvasOverlayTranscriptListeners.delete(listener); };
    },
    subscribeCanvasOverlayStatus(listener) {
      canvasOverlayStatusListeners.add(listener);
      return () => {
        canvasOverlayStatusListeners.delete(listener);
      };
    },
    listPluginToolsets: () => [...toolsetsByPluginId.values()].flat(),
    pluginIdForToolset: (toolsetId) => pluginIdByToolsetId.get(toolsetId),
    onDidChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return runtime;
}

/**
 * Fallback document identity: the document's own id and creation time, both of which edits and undo
 * leave alone. It tells an opened file from the document it replaced, but NOT two documents created by
 * File > New in one session — those share `doc_001` and a fixed creation stamp — which is why an
 * embedder that can tell documents apart should pass `getActiveDocumentKey` instead.
 */
export function documentIdentityKey(document: ChemDraftDocument | undefined): string | undefined {
  return document === undefined ? undefined : `${document.id}\u0000${document.createdAt}`;
}

function pluginToolsetToDefinition(contribution: PluginToolsetContribution): DesktopToolsetDefinition {
  return {
    id: contribution.id,
    title: contribution.title,
    source: "plugin",
    defaultVisible: contribution.defaultVisible,
    defaultMode: "floating",
    groups: contribution.groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => ({
        commandId: item.commandId,
        title: item.title,
        // Named fallback keeps the type honest; the real icon rides on iconDataUri.
        icon: "palette",
        iconDataUri: item.iconDataUri,
        shortcutDisplay: item.shortcutDisplay,
        category: "plugin"
      }))
    })),
    preferredWindowSize: contribution.preferredWindowSize
  };
}
