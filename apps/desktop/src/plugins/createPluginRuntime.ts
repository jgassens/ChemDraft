import { PluginStructureToNameRequestSchema } from "@chemdraft/plugin-api";
import type { AssistantToolContext } from "../assistant/AssistantToolContext";
import { AssistantToolsController, type AssistantToolsControllerOptions } from "../assistant/AssistantToolsController";
import { TauriAssistantMcpEngine, UnsupportedAssistantMcpEngine, type AssistantMcpEngine } from "../assistant/assistantMcpEngine";
import { getAssistantHistoryPort } from "../assistant/historyPort";
import { rasterizeSvgNative } from "../nativeRasterExport";
import { loadRdkitWithAppLoader } from "./rdkitAppLoader";
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
  PluginOverlayContentSection,
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
  type RegisterPluginOptions
} from "@chemdraft/plugin-host";

import type { RegisteredCanvasOverlay } from "./types";

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
  structureFromSmilesForPlugin
} from "./pluginChemistry";

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

function freezeOverlayContent(sections: PluginOverlayContentSection[]): readonly PluginOverlayContentSection[] {
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
  proposalDocumentTab(proposalId: string): ProposalDocumentTab | undefined;
  /** Retain the final title while pending proposals or running commands reference a closed tab. */
  closeProposalDocumentTab(tabId: string, title: string): void;
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
  invokeCommand(commandId: string, options?: { selectionWarnings?: string[]; input?: PluginCommandInput }): Promise<unknown>;
  listCanvasOverlays(): RegisteredCanvasOverlay[];
  getCanvasOverlayStatuses(): ReadonlyMap<string, string>;
  /** Subscribe to status-only overlay updates without invalidating plugin contributions/toolsets. */
  subscribeCanvasOverlayStatus(listener: () => void): () => void;
  getCanvasOverlayTranscripts(): ReadonlyMap<string, readonly PluginOverlayTranscriptEntry[]>;
  subscribeCanvasOverlayTranscript(listener: () => void): () => void;
  getCanvasOverlayContents(): ReadonlyMap<string, readonly PluginOverlayContentSection[]>;
  subscribeCanvasOverlayContent(listener: () => void): () => void;
  getCanvasOverlayOpenRequests(): ReadonlyMap<string, { readonly focus: boolean }>;
  subscribeCanvasOverlayOpen(listener: () => void): () => void;
  listPluginToolsets(): DesktopToolsetDefinition[];
  pluginIdForToolset(toolsetId: string): string | undefined;
  /** Notified when plugin contributions change. Returns unsubscribe. */
  onDidChange(listener: () => void): () => void;
}

export interface ProposalDocumentTab {
  id: string;
  title: string;
}

export function createPluginRuntime(options: DesktopPluginRuntimeOptions): DesktopPluginRuntime {
  const now = options.now ?? (() => new Date());
  const envelopeProvider =
    options.computeIsotopeEnvelope === undefined ? computeIsotopeEnvelopeForPlugin : options.computeIsotopeEnvelope;
  const nameProvider =
    options.convertNameToStructure === undefined ? nameToStructureForPlugin : options.convertNameToStructure;
  // Bound to the runtime's own document getter: layout needs the page it is being placed on, and a
  // plugin must not be able to name a different document than the one the host is showing.
  const structureProvider =
    options.buildStructureFromSmiles === undefined
      ? (request: PluginStructureFromSmilesRequest) =>
          structureFromSmilesForPlugin(request, options.getActiveDocument)
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
    createContext: options.assistantContext ?? (({ getDocument }) => ({
      getViewportRect: options.getAssistantViewportRect ?? (tabId => getAssistantHistoryPort().getViewportRect?.(tabId)),
      now: options.now ?? (() => new Date()),
      render: (svg, settings) => rasterizeSvgNative(svg, "png", settings),
      chemistry: {
        nameToStructure: request => nameProvider ? nameProvider(request) : Promise.resolve({ available: false, reason: "Name-to-structure engine unavailable." }),
        structureFromSmiles: request => options.buildStructureFromSmiles === null ?
          Promise.resolve({ available: false, reason: "Structure layout engine unavailable." }) :
          options.buildStructureFromSmiles ? options.buildStructureFromSmiles(request) : structureFromSmilesForPlugin(request, getDocument),
        inspectStructure: async (_format, value) => {
          const rdkit = await loadRdkitWithAppLoader(() => import("@chemdraft/rdkit-adapter"));
          const module = await rdkit.ensureRdkit();
          const molecule = module.get_mol(value, JSON.stringify({ removeHs: false }));
          if (!molecule) return { valid: false, reason: "RDKit could not parse the structure." };
          try {
            const jsonMol = molecule as typeof molecule & { get_json?(): string };
            const canonicalSmiles = molecule.get_smiles?.();
            if (!jsonMol.get_json || !canonicalSmiles) throw new Error("RDKit structure inspection is unavailable.");
            const graph = JSON.parse(jsonMol.get_json()) as Parameters<typeof rdkit.compositionFromRdkitJson>[0];
            const composition = rdkit.compositionFromRdkitJson(graph);
            return { valid: true, canonicalSmiles, formula: composition.formula, warnings: [],
              heavyAtoms: graph.molecules.reduce((count, mol) => count + mol.atoms.filter(atom =>
                (atom.z ?? graph.defaults?.atom?.z ?? 6) !== 1).length, 0) };
          } finally { molecule.delete(); }
        },
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
    }))
  });
  const namingInvocations = new Map<symbol, { pluginId: string; stop: AbortController }>();
  let namingFrame: symbol[] | undefined;
  let armedSelectionWarnings: string[] | undefined;
  let readingSelectionWarnings: string[] | undefined;
  const proposalTabs = new Map<string, string>();
  const closedTabTitles = new Map<string, string>();
  const runningTabCommands = new Map<string, number>();
  const pruneClosedTabTitles = () => {
    const pendingTabs = new Set(proposalTabs.values());
    for (const id of closedTabTitles.keys()) {
      if (!pendingTabs.has(id) && !runningTabCommands.has(id)) closedTabTitles.delete(id);
    }
  };
  let proposingTabId: string | undefined;
  class DesktopPluginHost extends PluginHost {
    override async invokeCommand<Result = unknown>(commandId: string, invokeOptions?: Parameters<PluginHost["invokeCommand"]>[1]): Promise<Result> {
      const tabId = options.getActiveDocumentTab?.().id;
      if (tabId) runningTabCommands.set(tabId, (runningTabCommands.get(tabId) ?? 0) + 1);
      const tokens: symbol[] = [];
      const previousFrame = namingFrame;
      namingFrame = tokens;
      try {
        const call = super.invokeCommand<Result>(commandId, invokeOptions);
        namingFrame = previousFrame;
        return await call;
      } finally {
        for (const token of tokens) { namingInvocations.get(token)?.stop.abort(); namingInvocations.delete(token); }
        if (tabId) {
          const remaining = (runningTabCommands.get(tabId) ?? 1) - 1;
          if (remaining > 0) runningTabCommands.set(tabId, remaining);
          else runningTabCommands.delete(tabId);
        }
        pruneClosedTabTitles();
      }
    }

    override unregisterPlugin(pluginId: string): void {
      for (const [token, invocation] of namingInvocations) {
        if (invocation.pluginId === pluginId) { invocation.stop.abort(); namingInvocations.delete(token); }
      }
      super.unregisterPlugin(pluginId);
    }

    override createCommandContext(pluginId: string, invocationToken?: symbol, input?: PluginCommandInput): PluginCommandContext {
      const context = super.createCommandContext(pluginId, invocationToken, input);
      const permissions = ["chemistry.compute", "native.execute", "selection.read"] as const;
      if (context.chemistry && (isTauriHost() || options.structureNamingEngine) && permissions.every(permission => this.hasPermission(pluginId, permission))) {
        if (invocationToken && namingFrame) {
          namingFrame.push(invocationToken);
          namingInvocations.set(invocationToken, { pluginId, stop: new AbortController() });
        }
        const documentKey = options.getActiveDocumentKey?.() ?? documentIdentityKey(options.getActiveDocument());
        context.chemistry.structureToName = async request => {
          for (const permission of permissions) this.requirePermission(pluginId, permission);
          const invocation = invocationToken ? namingInvocations.get(invocationToken) : undefined;
          if (!invocation || invocation.pluginId !== pluginId || invocation.stop.signal.aborted) throw new Error("Structure naming is available only during this plugin command invocation.");
          const parsed = PluginStructureToNameRequestSchema.parse(request);
          if (documentKey !== (options.getActiveDocumentKey?.() ?? documentIdentityKey(options.getActiveDocument()))) throw new Error("The active document changed during the naming command.");
          const molecule = scopedNamingMolecule(options.getActiveDocument(), options.getSelection?.(), parsed.objectId);
          const manifest = this.listPlugins().find(plugin => plugin.id === pluginId)!;
          return naming.name(manifest, molecule, invocation.stop.signal);
        };
      }
      const tabId = options.getActiveDocumentTab?.().id;
      const proposePatch = context.documents.proposePatch;
      context.documents.proposePatch = (proposal) => {
        // The host enqueues synchronously before returning its promise. Scope the queue notification
        // to this context, so concurrent commands and late results retain their own source tab.
        const previous = proposingTabId;
        proposingTabId = tabId;
        try {
          return proposePatch(proposal);
        } finally {
          proposingTabId = previous;
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
  const canvasOverlayStatuses = new Map<string, string>();
  const canvasOverlayTranscripts = new Map<string, readonly PluginOverlayTranscriptEntry[]>();
  const canvasOverlayContents = new Map<string, readonly PluginOverlayContentSection[]>();
  const canvasOverlayContentListeners = new Set<() => void>();
  const notifyCanvasOverlayContent = () => canvasOverlayContentListeners.forEach(listener => listener());
  const canvasOverlayOpenRequests = new Map<string, { readonly focus: boolean }>();
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
    commandRegistry: options.commandRegistry,
    overlays: {
      setContent: (_pluginId, overlayId, sections) => {
        if (sections.length === 0) {
          if (!canvasOverlayContents.delete(overlayId)) return;
        } else {
          canvasOverlayContents.set(overlayId, freezeOverlayContent(sections));
        }
        notifyCanvasOverlayContent();
      },
      open: (_pluginId, overlayId, focus) => {
        // A new identity for each request also makes repeated focus:true observable.
        canvasOverlayOpenRequests.set(overlayId, Object.freeze({ focus }));
        notifyCanvasOverlayOpen();
      },
      setTranscript: (_pluginId, overlayId, entries) => {
        if (entries.length === 0) {
          if (!canvasOverlayTranscripts.delete(overlayId)) return;
        } else {
          canvasOverlayTranscripts.set(overlayId, Object.freeze(entries.map(entry => Object.freeze({ ...entry }))));
        }
        notifyCanvasOverlayTranscript();
      },
      setStatus: (_pluginId, overlayId, text) => {
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
        if (!pendingIds.has(id)) proposalTabs.delete(id);
      }
      for (const proposal of pending) {
        if (proposalTabs.has(proposal.id)) continue;
        // Trusted desktop callers of host.proposePatch have no invocation context.
        const tabId = proposingTabId ?? options.getActiveDocumentTab?.().id;
        if (tabId) proposalTabs.set(proposal.id, tabId);
      }
      pruneClosedTabTitles();
      options.onProposedPatchesChanged?.();
    },
    applyDocumentPatch: options.applyDocumentPatch,
    showPanelReport: (pluginId, panelId, report) => {
      controller?.showReport(pluginId, panelId, report);
    },
    promptText: (plugin, request, signal) => prompts.promptText(plugin, request, signal),
    requestImage: (plugin, request, signal) => images.requestImage(plugin, request, signal),
    recognizeStructure: (plugin, image, signal) => recognition.recognize(plugin, image, signal),
    externalTools,
    assistant,
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
    proposalDocumentTab(proposalId) {
      const id = proposalTabs.get(proposalId);
      if (id === undefined) return undefined;
      const title = options.getDocumentTabTitle?.(id) ?? closedTabTitles.get(id);
      return title === undefined ? undefined : { id, title };
    },
    closeProposalDocumentTab(tabId, title) {
      assistant.closeAllForTab(tabId);
      closedTabTitles.set(tabId, title);
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
      let overlayStatusesChanged = false;
      for (const overlayId of canvasOverlayStatuses.keys()) {
        const overlayStillRegistered = host.listCanvasOverlays().some(entry => entry.overlay.id === overlayId);
        if (!overlayStillRegistered) {
          overlayStatusesChanged = true;
          canvasOverlayStatuses.delete(overlayId);
        }
      }
      if (overlayStatusesChanged) notifyCanvasOverlayStatus();
      let transcriptsChanged = false;
      for (const overlayId of canvasOverlayTranscripts.keys()) {
        if (!host.listCanvasOverlays().some(entry => entry.overlay.id === overlayId)) {
          canvasOverlayTranscripts.delete(overlayId);
          transcriptsChanged = true;
        }
      }
      if (transcriptsChanged) notifyCanvasOverlayTranscript();
      const owned = new Set(host.listCanvasOverlays().map(entry => entry.overlay.id));
      let contentChanged = false;
      let openChanged = false;
      for (const id of canvasOverlayContents.keys()) if (!owned.has(id)) {
        canvasOverlayContents.delete(id); contentChanged = true;
      }
      for (const id of canvasOverlayOpenRequests.keys()) if (!owned.has(id)) {
        canvasOverlayOpenRequests.delete(id); openChanged = true;
      }
      if (contentChanged) notifyCanvasOverlayContent();
      if (openChanged) notifyCanvasOverlayOpen();
      notify();
    },
    invokeCommand(commandId, invokeOptions = {}) {
      armedSelectionWarnings = invokeOptions.selectionWarnings;
      try {
        return invokeOptions.input === undefined
          ? host.invokeCommand(commandId)
          : host.invokeCommand(commandId, { input: invokeOptions.input });
      } finally {
        // Unclaimed when the command is not a plugin's or failed before its context was built.
        armedSelectionWarnings = undefined;
      }
    },
    listCanvasOverlays: () => host.listCanvasOverlays(),
    getCanvasOverlayStatuses: () => new Map(canvasOverlayStatuses),
    getCanvasOverlayTranscripts: () => new Map(canvasOverlayTranscripts),
    getCanvasOverlayContents: () => new Map(canvasOverlayContents),
    getCanvasOverlayOpenRequests: () => new Map(canvasOverlayOpenRequests),
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
