// `applyPatch` (and its `ApplyPatchOptions`) are the chem-core RUNTIME the host calls; tsup bundles them
// into this package's dist so no `@chemdraft/chem-core` dependency ships (ADR-0031). `ChemDraftDocument`,
// however, is taken from `@chemdraft/plugin-api` so a consumer using both SDK packages sees ONE canonical
// document type — not a second, structurally-identical copy inlined here.
import type { ApplyPatchOptions } from "@chemdraft/chem-core";
import { applyPatch } from "@chemdraft/chem-core";
import type { ChemDraftDocument } from "@chemdraft/plugin-api";
import type {
  AppliedPatchReceipt,
  PluginAnalysisAPI,
  PluginAnalysisQuery,
  PluginAnalysisRecord,
  PluginAnalyzerContribution,
  PluginChemistryAPI,
  PluginCommandContext,
  PluginCommandContribution,
  PluginCommandHandler,
  PluginDialogsAPI,
  PluginImageRequest,
  PluginImageRequestResult,
  PluginImagesAPI,
  PluginRecognitionAPI,
  PluginRecognitionResult,
  PluginIsotopeEnvelopeRequest,
  PluginIsotopeEnvelopeResult,
  PluginNameToStructureRequest,
  PluginNameToStructureResult,
  PluginStructureFromSmilesRequest,
  PluginStructureFromSmilesResult,
  PluginMenuContribution,
  NormalizedProposedDocumentPatch,
  PluginManifest,
  PluginPanelAPI,
  PluginPanelContribution,
  PluginPanelReport,
  PluginPermission,
  NormalizedPluginPromptTextRequest,
  NormalizedPluginImageRequest,
  PluginPromptTextRequest,
  PluginPromptTextResult,
  PluginProvidedImage,
  PluginSelectionAPI,
  PluginSelectionSnapshot,
  PluginStorage,
  ProposedDocumentPatch,
  ProposedPatchReceipt,
  ProposedPatchStatus
} from "@chemdraft/plugin-api";
import { AnalysisStore } from "./analysisStore";

export { AnalysisStore } from "./analysisStore";
export type { AnalysisStoreOptions } from "./analysisStore";
import {
  AppliedPatchReceiptSchema,
  HostHeldRecognitionPatchOp,
  PluginImageMaxBytes,
  PluginImageMaxDimension,
  PluginImageRequestResultSchema,
  PluginImageRequestSchema,
  PluginProvidedImageSchema,
  PluginRecognitionResultSchema,
  PluginIsotopeEnvelopeRequestSchema,
  PluginNameToStructureRequestSchema,
  PluginPanelReportSchema,
  PluginPromptTextRequestSchema,
  PluginPromptTextResultSchema,
  PluginStructureFromSmilesRequestSchema,
  ProposedDocumentPatchSchema,
  parsePluginManifest
} from "@chemdraft/plugin-api";

export interface CommandDefinition {
  id: string;
  title: string;
  source?: "core" | "plugin";
  pluginId?: string;
  category?: string;
  description?: string;
  requiredPermissions?: PluginPermission[];
  defaultShortcut?: string;
  enabled?: boolean;
}

export interface CommandInvocationContext {
  pluginId?: string;
  permissions?: ReadonlySet<PluginPermission>;
}

export type CommandHandler<Result = unknown> = (
  context: CommandInvocationContext
) => Result | Promise<Result>;

export class CommandRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRegistryError";
  }
}

export class PluginPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPermissionError";
  }
}

export class PluginHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginHostError";
  }
}

export class CommandRegistry {
  private readonly commands = new Map<string, { definition: RequiredCommandDefinition; handler: CommandHandler }>();

  register(definition: CommandDefinition, handler: CommandHandler): void {
    if (this.commands.has(definition.id)) {
      throw new CommandRegistryError(`Command "${definition.id}" is already registered.`);
    }

    this.commands.set(definition.id, {
      definition: normalizeCommandDefinition(definition),
      handler
    });
  }

  unregister(commandId: string): void {
    this.commands.delete(commandId);
  }

  /** Remove a command only when it is still owned by the expected plugin. This prevents plugin
   *  rollback/uninstall from deleting a core command or a replacement registered under the same id. */
  unregisterOwnedByPlugin(commandId: string, pluginId: string): boolean {
    const entry = this.commands.get(commandId);
    if (entry?.definition.source !== "plugin" || entry.definition.pluginId !== pluginId) {
      return false;
    }
    return this.commands.delete(commandId);
  }

  has(commandId: string): boolean {
    return this.commands.has(commandId);
  }

  get(commandId: string): CommandDefinition | undefined {
    return this.commands.get(commandId)?.definition;
  }

  list(): CommandDefinition[] {
    return Array.from(this.commands.values(), (entry) => entry.definition);
  }

  async invoke<Result = unknown>(
    commandId: string,
    context: CommandInvocationContext = {}
  ): Promise<Result> {
    const entry = this.commands.get(commandId);
    if (!entry) {
      throw new CommandRegistryError(`Command "${commandId}" is not registered.`);
    }

    if (!entry.definition.enabled) {
      throw new CommandRegistryError(`Command "${commandId}" is disabled.`);
    }

    for (const permission of entry.definition.requiredPermissions) {
      if (!context.permissions?.has(permission)) {
        throw new PluginPermissionError(`Command "${commandId}" requires permission "${permission}".`);
      }
    }

    return (await entry.handler(context)) as Result;
  }
}

export interface RegisterPluginOptions {
  commandHandlers?: Record<string, PluginCommandHandler>;
  /** Called when the desktop closes one of the plugin's contributed panels, so the plugin can cancel
   *  in-flight work tied to it (ADR-0012). The panel is not reopened by a late report. */
  onPanelClosed?: (panelId: string) => void;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  permissions: ReadonlySet<PluginPermission>;
}

/** A single manifest contribution paired with the id of the plugin that declared it. The desktop
 *  uses these to build UI (menus, panels, diagnostics) without reaching into manifest internals. */
export interface RegisteredContribution<T> {
  pluginId: string;
  contribution: T;
}

export interface QueuedProposedPatch extends ProposedPatchReceipt {
  proposal: NormalizedProposedDocumentPatch;
}

/** Host-owned transaction metadata for one command-scoped direct document write. */
export interface PluginPatchApplicationRequest {
  plugin: { id: string; name: string; version: string };
  command: { id: string; title: string };
  patch: NormalizedProposedDocumentPatch;
  undoLabel: string;
}

export interface PluginHostOptions {
  commandRegistry?: CommandRegistry;
  getActiveDocument?: () => ChemDraftDocument | undefined | Promise<ChemDraftDocument | undefined>;
  /**
   * Identifies the document the user is working in — stable across edits and undo, different after
   * File > New/Open or switching to another document. Read once when a plugin command starts and again
   * before a `documents.applyPatch` commits: a mismatch refuses the write, so a plugin still running
   * after the user moved on can never insert into a document it was not invoked on. Absent, the host
   * cannot tell documents apart and performs no such check.
   */
  getActiveDocumentKey?: () => string | undefined;
  getSelection?: () => PluginSelectionSnapshot | undefined | Promise<PluginSelectionSnapshot | undefined>;
  /** Storage backend factory (defaults to per-plugin in-memory maps). The desktop app
   *  supplies a disk-backed implementation; the host stays platform-free. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Renders a validated panel report; absent hosts simply expose no panels API. */
  showPanelReport?: (pluginId: string, panelId: string, report: PluginPanelReport) => void | Promise<void>;
  /** Shows host-owned text-prompt UI. The signal aborts when the command ends or plugin unregisters. */
  promptText?: (
    plugin: { id: string; name: string },
    request: NormalizedPluginPromptTextRequest,
    signal: AbortSignal
  ) => PluginPromptTextResult | Promise<PluginPromptTextResult>;
  /** Acquires an image through host-owned UI. The signal aborts when the command ends/unregisters. */
  requestImage?: (
    plugin: { id: string; name: string },
    request: NormalizedPluginImageRequest,
    signal: AbortSignal
  ) => PluginImageRequestResult | Promise<PluginImageRequestResult>;
  /** Runs host-owned local recognition. The image has already been verified as one handed to this
   * invocation; installation and any user consent stay entirely on the embedding host side. */
  recognizeStructure?: (
    plugin: { id: string; name: string },
    image: PluginProvidedImage,
    signal: AbortSignal
  ) => PluginRecognitionResult | Promise<PluginRecognitionResult>;
  /** Commits a validated direct patch through the embedding application's normal document/history path. */
  applyDocumentPatch?: (
    request: PluginPatchApplicationRequest
  ) => AppliedPatchReceipt | Promise<AppliedPatchReceipt>;
  /**
   * Computes an isotope envelope on a plugin's behalf. Absent hosts expose no chemistry API — which is
   * why the capability is optional on the context rather than assumed. This package stays engine-free;
   * the application supplies the engine it already owns.
   */
  computeIsotopeEnvelope?: (request: PluginIsotopeEnvelopeRequest) => Promise<PluginIsotopeEnvelopeResult>;
  /** Converts a systematic name to a structure. Same rule: absent hosts answer `available: false`. */
  convertNameToStructure?: (request: PluginNameToStructureRequest) => Promise<PluginNameToStructureResult>;
  /** Lays a SMILES out as a document object. Same rule: absent hosts answer `available: false`. */
  buildStructureFromSmiles?: (
    request: PluginStructureFromSmilesRequest
  ) => Promise<PluginStructureFromSmilesResult>;
  /** Fired whenever the proposed-patch queue changes (new, accepted, rejected). */
  onProposedPatchesChanged?: () => void;
  now?: () => Date | string;
  /** Generates analysis-record ids; defaults to `crypto.randomUUID`. Injectable for deterministic tests. */
  createId?: () => string;
}

export class PluginHost {
  readonly commands: CommandRegistry;

  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly proposedPatches = new Map<string, QueuedProposedPatch>();
  private readonly storageScopes = new Map<string, Map<string, unknown>>();
  private readonly storageByPluginId = new Map<string, PluginStorage>();
  private readonly panelClosedHandlers = new Map<string, (panelId: string) => void>();
  private readonly getActiveDocument?: PluginHostOptions["getActiveDocument"];
  private readonly getActiveDocumentKey?: PluginHostOptions["getActiveDocumentKey"];
  private readonly getSelectionSnapshot?: PluginHostOptions["getSelection"];
  private readonly createStorage?: PluginHostOptions["createStorage"];
  private readonly showPanelReport?: PluginHostOptions["showPanelReport"];
  private readonly promptText?: PluginHostOptions["promptText"];
  private readonly requestImage?: PluginHostOptions["requestImage"];
  private readonly recognizeStructure?: PluginHostOptions["recognizeStructure"];
  private readonly applyDocumentPatch?: PluginHostOptions["applyDocumentPatch"];
  private readonly computeIsotopeEnvelope?: PluginHostOptions["computeIsotopeEnvelope"];
  private readonly convertNameToStructure?: PluginHostOptions["convertNameToStructure"];
  private readonly buildStructureFromSmiles?: PluginHostOptions["buildStructureFromSmiles"];
  private readonly onProposedPatchesChanged?: PluginHostOptions["onProposedPatchesChanged"];
  private readonly now: () => Date | string;
  private readonly createId: () => string;
  private readonly analysisStore: AnalysisStore;
  private nextProposalId = 1;
  private readonly subscribers = new Set<() => void>();
  private readonly activeCommandInvocations = new Map<symbol, ActiveCommandInvocation>();
  private readonly textPromptInvocations = new Set<symbol>();
  private readonly openTextPrompts = new Map<
    string,
    { invocationToken: symbol; abortController: AbortController }
  >();
  private readonly openImageRequests = new Map<symbol, Set<AbortController>>();
  private readonly providedImagesByInvocation = new Map<symbol, PluginProvidedImage[]>();
  private readonly openRecognitionRequests = new Map<symbol, Set<AbortController>>();
  /** Real recognition insertions withheld from plugins without `document.read`, per invocation, keyed
   *  by the opaque `ref` the plugin was handed instead (see `HostHeldRecognitionPatchOp`). */
  private readonly heldRecognitionPatches = new Map<symbol, Map<string, NormalizedProposedDocumentPatch>>();

  constructor(options: PluginHostOptions = {}) {
    this.commands = options.commandRegistry ?? new CommandRegistry();
    this.getActiveDocument = options.getActiveDocument;
    this.getActiveDocumentKey = options.getActiveDocumentKey;
    this.getSelectionSnapshot = options.getSelection;
    this.createStorage = options.createStorage;
    this.showPanelReport = options.showPanelReport;
    this.promptText = options.promptText;
    this.requestImage = options.requestImage;
    this.recognizeStructure = options.recognizeStructure;
    this.applyDocumentPatch = options.applyDocumentPatch;
    this.computeIsotopeEnvelope = options.computeIsotopeEnvelope;
    this.convertNameToStructure = options.convertNameToStructure;
    this.buildStructureFromSmiles = options.buildStructureFromSmiles;
    this.onProposedPatchesChanged = options.onProposedPatchesChanged;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.analysisStore = new AnalysisStore({
      now: () => this.timestamp(),
      createId: () => this.createId(),
      onChange: () => this.notifySubscribers()
    });
  }

  registerPlugin(candidate: unknown, options: RegisterPluginOptions = {}): RegisteredPlugin {
    const manifest = validateTrustedPluginManifest(candidate);
    if (this.plugins.has(manifest.id)) {
      throw new PluginHostError(`Plugin "${manifest.id}" is already registered.`);
    }

    this.assertContributionPermissions(manifest);
    this.assertContributionCommands(manifest);
    this.assertCommandIdsAvailable(manifest);

    const registered: RegisteredPlugin = {
      manifest,
      permissions: new Set(manifest.permissions)
    };
    this.registerManifestCommands(manifest, options.commandHandlers ?? {});
    // Commit host-visible plugin state only after every shared-registry mutation succeeds. Command
    // handlers cannot be invoked synchronously during registration, so they will always observe the
    // committed plugin once registerPlugin returns.
    this.plugins.set(manifest.id, registered);
    if (options.onPanelClosed) {
      this.panelClosedHandlers.set(manifest.id, options.onPanelClosed);
    }
    this.notifySubscribers();
    return registered;
  }

  /** Invoke a plugin's `onPanelClosed` hook (ADR-0012). The desktop calls this when the user closes a
   *  contributed panel, giving the plugin its cancellation trigger. Unknown plugin/panel is a no-op. */
  notifyPanelClosed(pluginId: string, panelId: string): void {
    this.panelClosedHandlers.get(pluginId)?.(panelId);
  }

  /** Removes a plugin and its registered commands. Storage scopes and PENDING proposals survive on
   *  purpose: they are user-facing records, not runtime wiring — an update (`replacePlugin`) or a
   *  disable must not silently discard a proposal the user has not reviewed yet. Resolved proposals
   *  are already gone: accept/reject removes them from the queue. */
  unregisterPlugin(pluginId: string): void {
    const plugin = this.requireRegisteredPlugin(pluginId);
    this.cancelOpenTextPrompt(pluginId);
    this.cancelOpenImageRequests(pluginId);
    for (const command of plugin.manifest.contributes.commands) {
      this.commands.unregisterOwnedByPlugin(command.id, pluginId);
    }
    this.plugins.delete(pluginId);
    this.panelClosedHandlers.delete(pluginId);
    this.notifySubscribers();
  }

  async invokeCommand<Result = unknown>(commandId: string): Promise<Result> {
    const definition = this.commands.get(commandId);
    if (!definition) {
      throw new CommandRegistryError(`Command "${commandId}" is not registered.`);
    }

    if (!definition.pluginId) {
      return await this.commands.invoke<Result>(commandId);
    }

    const plugin = this.requireRegisteredPlugin(definition.pluginId);
    return await this.commands.invoke<Result>(commandId, {
      pluginId: definition.pluginId,
      permissions: plugin.permissions
    });
  }

  listPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values(), (plugin) => plugin.manifest);
  }

  getPlugin(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /** Notified when the registered-plugin set changes (register/unregister). The desktop uses this
   *  to keep menu, panel, and diagnostics UI in sync without polling. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  listCommandContributions(): RegisteredContribution<PluginCommandContribution>[] {
    return this.collectContributions((manifest) => manifest.contributes.commands);
  }

  listMenuContributions(
    location?: PluginMenuContribution["location"]
  ): RegisteredContribution<PluginMenuContribution>[] {
    return this.collectContributions((manifest) =>
      location
        ? manifest.contributes.menus.filter((menu) => menu.location === location)
        : manifest.contributes.menus
    );
  }

  listPanelContributions(): RegisteredContribution<PluginPanelContribution>[] {
    return this.collectContributions((manifest) => manifest.contributes.panels);
  }

  listAnalyzerContributions(): RegisteredContribution<PluginAnalyzerContribution>[] {
    return this.collectContributions((manifest) => manifest.contributes.analyzers);
  }

  private collectContributions<T>(
    select: (manifest: PluginManifest) => readonly T[]
  ): RegisteredContribution<T>[] {
    const out: RegisteredContribution<T>[] = [];
    for (const plugin of this.plugins.values()) {
      for (const contribution of select(plugin.manifest)) {
        out.push({ pluginId: plugin.manifest.id, contribution });
      }
    }
    return out;
  }

  hasPermission(pluginId: string, permission: PluginPermission): boolean {
    return this.plugins.get(pluginId)?.permissions.has(permission) ?? false;
  }

  requirePermission(pluginId: string, permission: PluginPermission): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new PluginHostError(`Plugin "${pluginId}" is not registered.`);
    }

    if (!plugin.permissions.has(permission)) {
      throw new PluginPermissionError(`Plugin "${pluginId}" requires permission "${permission}".`);
    }
  }

  createCommandContext(pluginId: string, invocationToken?: symbol): PluginCommandContext {
    const plugin = this.requireRegisteredPlugin(pluginId);
    const storage = this.hasPermission(pluginId, "plugin.storage") ? this.getStorage(pluginId) : undefined;
    const selection: PluginSelectionAPI | undefined = this.hasPermission(pluginId, "selection.read")
      ? {
          getSelection: async () => {
            this.requirePermission(pluginId, "selection.read");
            const snapshot = (await this.getSelectionSnapshot?.()) ?? { objectIds: [], molecules: [] };
            // Hand plugins an independent, immutable copy — never a live document reference, and
            // never an object a later caller could observe being mutated.
            return freezeSelectionSnapshot(snapshot);
          }
        }
      : undefined;
    const panels: PluginPanelAPI | undefined =
      this.hasPermission(pluginId, "ui.panel") && this.showPanelReport
        ? {
            showReport: async (panelId, report) => {
              this.requirePermission(pluginId, "ui.panel");
              const declared = plugin.manifest.contributes.panels.some((panel) => panel.id === panelId);
              if (!declared) {
                throw new PluginHostError(`Plugin "${pluginId}" does not declare panel "${panelId}".`);
              }
              const parsedReport = PluginPanelReportSchema.parse(report);
              await this.showPanelReport?.(pluginId, panelId, parsedReport);
            }
          }
        : undefined;
    // Presence tracks the permission alone, as `chemistry` below explains: the worker stub is built
    // from manifest permissions and cannot know whether this host wired a prompt UI, so gating on
    // `this.promptText` too made the two paths disagree. A host without one rejects the call instead.
    const dialogs: PluginDialogsAPI | undefined = this.hasPermission(pluginId, "ui.panel")
      ? {
          promptText: async (request: PluginPromptTextRequest) =>
            this.promptTextForPlugin(pluginId, invocationToken, request)
        }
      : undefined;
    const images: PluginImagesAPI | undefined = this.hasPermission(pluginId, "image.read")
      ? {
          requestImage: async (request: PluginImageRequest) =>
            this.requestImageForPlugin(pluginId, invocationToken, request)
        }
      : undefined;
    const recognition: PluginRecognitionAPI | undefined =
      this.hasPermission(pluginId, "image.read") &&
      this.hasPermission(pluginId, "ml.inference") &&
      this.hasPermission(pluginId, "model.load") &&
      this.hasPermission(pluginId, "native.execute")
        ? {
            recognizeStructure: async (image: PluginProvidedImage) =>
              this.recognizeStructureForPlugin(pluginId, invocationToken, image)
          }
        : undefined;
    const analysis: PluginAnalysisAPI | undefined = this.hasPermission(pluginId, "analysis.write")
      ? {
          write: async (input) => {
            this.requirePermission(pluginId, "analysis.write");
            return this.analysisStore.write(pluginId, input);
          },
          // Read policy (ADR-0005): a plugin reads only its own records. Force the plugin scope onto
          // every query so it cannot read another plugin's derived data.
          list: async (query) => this.analysisStore.list({ ...query, pluginId }),
          getLatest: async (query) => this.analysisStore.getLatest({ ...query, pluginId })
        }
      : undefined;

    // Presence tracks the PERMISSION alone; whether the host can actually serve the call is carried in
    // the answer. That split is deliberate: across the worker bridge the plugin's stub is built from
    // its manifest permissions, with no way to know what the host wired up, so gating presence on the
    // engine too would make the in-process and worker paths disagree for the same plugin on the same
    // host — one seeing no capability, the other a rejected call. One code path, one shape of answer.
    const chemistry: PluginChemistryAPI | undefined = this.hasPermission(pluginId, "chemistry.compute")
      ? {
          isotopeEnvelope: async (request) => {
            this.requirePermission(pluginId, "chemistry.compute");
            const parsed = PluginIsotopeEnvelopeRequestSchema.parse(request);
            if (!this.computeIsotopeEnvelope) {
              return { available: false, reason: "This host provides no isotope engine." };
            }
            return await this.computeIsotopeEnvelope(parsed);
          },
          // `native.execute` ON TOP OF `chemistry.compute`, and this is the one method that needs it.
          //
          // Name-to-structure is not computed in-process: the desktop's implementation invokes a Tauri
          // command that runs `Command::new(java).arg("-jar")` on the bundled OPSIN runtime. §7 lists
          // `native.execute` among the Dangerous permissions and `chemistry.compute` among the
          // ordinary ones, so gating a subprocess spawn on the ordinary one handed every plugin
          // holding it — including the bundled mass-fragment demo — the ability to start an OS
          // process, which §16 forbids ("Run native code unless granted"). It was unreachable only
          // because the worker allow-list had not been updated; completing that list is what made this
          // live, so the two land together.
          //
          // Presence tracks the permissions the method actually needs, which keeps the uniform rule
          // above intact rather than breaking it: a plugin sees the method exactly when it has
          // declared what the method costs. `workerRuntime` applies the identical condition, so the
          // in-process and worker paths still agree about what this host offers.
          //
          // The spawn itself stays narrow — fixed argv, the name over stdin, control characters
          // rejected, a 2,000-character cap and a 30-second kill — so this is a declaration
          // requirement, not a sandbox escape being papered over.
          ...(this.hasPermission(pluginId, "native.execute")
            ? {
                nameToStructure: async (request: PluginNameToStructureRequest) => {
                  this.requirePermission(pluginId, "chemistry.compute");
                  this.requirePermission(pluginId, "native.execute");
                  const parsed = PluginNameToStructureRequestSchema.parse(request);
                  if (!this.convertNameToStructure) {
                    return { available: false, reason: "This host provides no name-to-structure engine." };
                  }
                  return await this.convertNameToStructure(parsed);
                }
              }
            : {}),
          // `document.read` as well, and for the same reason `nameToStructure` needs `native.execute`:
          // the answer carries information the plugin has not been granted otherwise. The object this
          // returns is laid out against the ACTIVE DOCUMENT — its id encodes the document's object
          // count (`nextObjectId` is `existingIds.size + 1`) and its coordinates encode the page
          // dimensions (the insert point is the page centre). The desktop bound this to its ungated
          // document getter rather than the `document.read`-checked reader, so a plugin holding only
          // `chemistry.compute` could read both, past the gate that exists to stop it.
          ...(this.hasPermission(pluginId, "document.read")
            ? {
                structureFromSmiles: async (request: PluginStructureFromSmilesRequest) => {
                  this.requirePermission(pluginId, "chemistry.compute");
                  this.requirePermission(pluginId, "document.read");
                  const parsed = PluginStructureFromSmilesRequestSchema.parse(request);
                  if (!this.buildStructureFromSmiles) {
                    return { available: false, reason: "This host provides no 2D layout engine." };
                  }
                  return await this.buildStructureFromSmiles(parsed);
                }
              }
            : {})
        }
      : undefined;

    return {
      plugin: {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        permissions: plugin.manifest.permissions
      },
      ...(chemistry ? { chemistry } : {}),
      documents: {
        getActiveDocument: async () => {
          this.requirePermission(pluginId, "document.read");
          const document = await this.getActiveDocument?.();
          // Same boundary as the selection API above: an independent, immutable copy. In-process
          // plugins share the host's heap, so returning the provider's value handed them the live
          // document — edits would land without ever passing through propose/review.
          return document === undefined ? undefined : deepFreeze(structuredClone(document));
        },
        proposePatch: async (proposal) => {
          const { snapshot, hostHeld } = this.enqueueProposal(pluginId, proposal, invocationToken);
          // The substituted patch is the document-derived insertion this plugin was not allowed to
          // read; its receipt must not hand it back.
          return hostHeld ? proposalReceipt(snapshot) : snapshot;
        },
        ...(this.hasPermission(pluginId, "document.write")
          ? {
              applyPatch: async (patch: ProposedDocumentPatch) =>
                this.applyPatchForPlugin(pluginId, invocationToken, patch)
            }
          : {})
      },
      storage,
      selection,
      panels,
      dialogs,
      images,
      recognition,
      analysis,
      hasPermission: (permission) => this.hasPermission(pluginId, permission),
      requirePermission: (permission) => this.requirePermission(pluginId, permission)
    };
  }

  /** Trusted desktop read access: unscoped analysis records for rendering (ADR-0005). Plugins get
   *  the plugin-scoped view through `context.analysis`; this bypasses that scope for the app itself. */
  listAnalysis(query?: PluginAnalysisQuery): readonly PluginAnalysisRecord[] {
    return this.analysisStore.list(query);
  }

  getLatestAnalysis(query?: PluginAnalysisQuery): PluginAnalysisRecord | undefined {
    return this.analysisStore.getLatest(query);
  }

  proposePatch(pluginId: string, proposal: ProposedDocumentPatch): QueuedProposedPatch {
    return this.enqueueProposal(pluginId, proposal, undefined).snapshot;
  }

  private enqueueProposal(
    pluginId: string,
    proposal: ProposedDocumentPatch,
    invocationToken: symbol | undefined
  ): { snapshot: QueuedProposedPatch; hostHeld: boolean } {
    this.requirePermission(pluginId, "document.proposePatch");
    let parsedProposal = ProposedDocumentPatchSchema.parse(proposal);
    const hostHeld = isHostHeldRecognitionPatch(parsedProposal.patch);
    if (hostHeld) {
      const ref = (parsedProposal.patch as unknown as { ref?: unknown }).ref;
      const held = invocationToken ? this.heldRecognitionPatches.get(invocationToken) : undefined;
      const heldPatch = typeof ref === "string" ? held?.get(ref) : undefined;
      if (
        !invocationToken ||
        this.activeCommandInvocations.get(invocationToken)?.pluginId !== pluginId ||
        !heldPatch
      ) {
        throw new PluginHostError(
          `Plugin "${pluginId}" may propose a recognized structure only once, during the command invocation that recognized it.`
        );
      }
      // Single use: a second proposal of the same insertion would collide on its object id.
      held!.delete(ref as string);
      parsedProposal = { ...parsedProposal, patch: heldPatch.patch };
    }
    const timestamp = this.timestamp();
    const queued: QueuedProposedPatch = {
      id: `proposal_${this.nextProposalId++}`,
      pluginId,
      status: "pending",
      createdAt: timestamp,
      proposal: parsedProposal
    };

    // Snapshot BEFORE enqueueing: if a proposal cannot be cloned/frozen at all, it must never reach
    // the queue, or the tray's next render throws on an entry the user has no way to dismiss.
    const snapshot = snapshotProposal(queued);
    this.proposedPatches.set(queued.id, queued);
    this.onProposedPatchesChanged?.();
    return { snapshot, hostHeld };
  }

  private async applyPatchForPlugin(
    pluginId: string,
    invocationToken: symbol | undefined,
    patch: ProposedDocumentPatch
  ): Promise<AppliedPatchReceipt> {
    this.requirePermission(pluginId, "document.write");
    const invocation = invocationToken ? this.activeCommandInvocations.get(invocationToken) : undefined;
    if (!invocation || invocation.pluginId !== pluginId) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may call documents.applyPatch only while one of its own commands is executing.`
      );
    }
    const parsedPatch = ProposedDocumentPatchSchema.parse(patch);
    // Recognition is proposal-only (AGENTS.md §7/§8): enforced here, not left to plugin good manners.
    // The rule is per invocation rather than per plugin, so one plugin may still recognize images in
    // one command and write deterministic user input in another.
    if (invocation.recognized) {
      throw new PluginHostError(
        `Plugin "${pluginId}" recognized an image in this command, so its result must go through documents.proposePatch for review; documents.applyPatch was refused.`
      );
    }
    if (parsedPatch.recognition !== undefined || isHostHeldRecognitionPatch(parsedPatch.patch)) {
      throw new PluginHostError(
        `Plugin "${pluginId}" passed a recognition proposal to documents.applyPatch; recognized structures must be proposed for review with documents.proposePatch.`
      );
    }
    if (!this.applyDocumentPatch) {
      throw new PluginHostError(`This host provides no document-write path for plugin "${pluginId}".`);
    }
    if (this.getActiveDocumentKey && this.getActiveDocumentKey() !== invocation.documentKey) {
      throw new PluginHostError("The document changed while the plugin was running; nothing was inserted.");
    }
    const plugin = this.requireRegisteredPlugin(pluginId).manifest;
    const receipt = await this.applyDocumentPatch({
      plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
      command: { id: invocation.commandId, title: invocation.commandTitle },
      patch: parsedPatch,
      undoLabel: `${plugin.name}: ${invocation.commandTitle}`
    });
    return AppliedPatchReceiptSchema.parse(receipt);
  }

  listProposedPatches(status?: ProposedPatchStatus): QueuedProposedPatch[] {
    return Array.from(this.proposedPatches.values())
      .filter((proposal) => (status ? proposal.status === status : true))
      .map(snapshotProposal);
  }

  acceptProposedPatch(
    proposalId: string,
    document: ChemDraftDocument,
    options: ApplyPatchOptions = {}
  ): ChemDraftDocument {
    const queued = this.requirePendingProposal(proposalId);
    const updated = applyPatch(document, queued.proposal.patch, options);

    queued.status = "accepted";
    queued.resolvedAt = this.timestamp();
    // Resolved proposals leave the queue: a recognition proposal carries its whole source image as a
    // data URI (up to ~35 MB), and nothing reads a resolved entry back.
    this.proposedPatches.delete(proposalId);
    this.onProposedPatchesChanged?.();
    return updated;
  }

  rejectProposedPatch(proposalId: string): QueuedProposedPatch {
    const queued = this.requirePendingProposal(proposalId);
    queued.status = "rejected";
    queued.resolvedAt = this.timestamp();
    const snapshot = snapshotProposal(queued);
    this.proposedPatches.delete(proposalId);
    this.onProposedPatchesChanged?.();
    return snapshot;
  }

  getStorage(pluginId: string): PluginStorage {
    this.requirePermission(pluginId, "plugin.storage");
    if (this.createStorage) {
      let storage = this.storageByPluginId.get(pluginId);
      if (!storage) {
        storage = this.createStorage(pluginId);
        this.storageByPluginId.set(pluginId, storage);
      }
      return storage;
    }

    let scope = this.storageScopes.get(pluginId);
    if (!scope) {
      scope = new Map<string, unknown>();
      this.storageScopes.set(pluginId, scope);
    }

    return new ScopedPluginStorage(scope);
  }

  private registerManifestCommands(
    manifest: PluginManifest,
    handlers: Record<string, PluginCommandHandler>
  ): void {
    const registeredCommandIds: string[] = [];
    try {
      for (const command of manifest.contributes.commands) {
        const handler = handlers[command.id];
        // Track before calling into the registry: even an injected registry that throws after
        // mutating is rolled back, while the ownership check makes a throw-before-mutation a no-op.
        registeredCommandIds.push(command.id);
        this.commands.register(
          {
            id: command.id,
            title: command.title,
            category: command.category,
            description: command.description,
            source: "plugin",
            pluginId: manifest.id,
            requiredPermissions: command.requiredPermissions,
            defaultShortcut: command.defaultShortcut,
            enabled: command.enabled && Boolean(handler)
          },
          async () => {
            if (!handler) {
              throw new CommandRegistryError(`Command "${command.id}" has no registered handler.`);
            }

            for (const permission of command.requiredPermissions) {
              this.requirePermission(manifest.id, permission);
            }

            const invocationToken = Symbol(command.id);
            this.activeCommandInvocations.set(invocationToken, {
              pluginId: manifest.id,
              commandId: command.id,
              commandTitle: command.title,
              documentKey: this.getActiveDocumentKey?.(),
              recognized: false
            });
            try {
              return await handler(this.createCommandContext(manifest.id, invocationToken));
            } finally {
              this.finishCommandInvocation(invocationToken);
            }
          }
        );
      }
    } catch (error) {
      for (const commandId of registeredCommandIds.reverse()) {
        this.commands.unregisterOwnedByPlugin(commandId, manifest.id);
      }
      throw error;
    }
  }

  private assertCommandIdsAvailable(manifest: PluginManifest): void {
    for (const command of manifest.contributes.commands) {
      if (this.commands.has(command.id)) {
        throw new CommandRegistryError(`Command "${command.id}" is already registered.`);
      }
    }
  }

  private assertContributionPermissions(manifest: PluginManifest): void {
    const declared = new Set(manifest.permissions);
    for (const command of manifest.contributes.commands) {
      for (const permission of command.requiredPermissions) {
        if (!declared.has(permission)) {
          throw new PluginPermissionError(
            `Plugin "${manifest.id}" command "${command.id}" requires undeclared permission "${permission}".`
          );
        }
      }
    }
  }

  /** Menu/analyzer/panel contributions dispatch a command; that command must be one the same plugin
   *  contributes, or the entry would be an inert (or misrouted) UI element. The manifest schema
   *  already enforces this for toolset items; this covers the remaining command-bearing kinds so an
   *  unknown-command reference is rejected at registration rather than surfacing as a dead menu item. */
  private assertContributionCommands(manifest: PluginManifest): void {
    const contributed = new Set(manifest.contributes.commands.map((command) => command.id));
    const check = (commandId: string | undefined, describe: string): void => {
      if (commandId !== undefined && !contributed.has(commandId)) {
        throw new PluginHostError(
          `Plugin "${manifest.id}" ${describe} references command "${commandId}" that it does not contribute.`
        );
      }
    };
    for (const menu of manifest.contributes.menus) {
      check(menu.commandId, `menu "${menu.id}"`);
    }
    for (const analyzer of manifest.contributes.analyzers) {
      check(analyzer.commandId, `analyzer "${analyzer.id}"`);
    }
    for (const panel of manifest.contributes.panels) {
      check(panel.commandId, `panel "${panel.id}"`);
    }
  }

  private notifySubscribers(): void {
    for (const listener of this.subscribers) {
      listener();
    }
  }

  private async promptTextForPlugin(
    pluginId: string,
    invocationToken: symbol | undefined,
    request: PluginPromptTextRequest
  ): Promise<PluginPromptTextResult> {
    this.requirePermission(pluginId, "ui.panel");
    if (!invocationToken || this.activeCommandInvocations.get(invocationToken)?.pluginId !== pluginId) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may call dialogs.promptText only while one of its own commands is executing.`
      );
    }
    if (this.textPromptInvocations.has(invocationToken)) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may call dialogs.promptText at most once per command invocation.`
      );
    }
    this.textPromptInvocations.add(invocationToken);
    if (this.openTextPrompts.has(pluginId)) {
      throw new PluginHostError(
        `Plugin "${pluginId}" already has an open dialogs.promptText request; concurrent prompts are not allowed.`
      );
    }
    if (!this.promptText) {
      throw new PluginHostError(`This host provides no text-prompt UI for plugin "${pluginId}".`);
    }

    const parsedRequest = PluginPromptTextRequestSchema.parse(request);
    const plugin = this.requireRegisteredPlugin(pluginId);
    const abortController = new AbortController();
    const openPrompt = { invocationToken, abortController };
    this.openTextPrompts.set(pluginId, openPrompt);

    const cancelledOnAbort = new Promise<PluginPromptTextResult>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    });
    try {
      const result = await Promise.race([
        Promise.resolve(
          this.promptText(
            { id: plugin.manifest.id, name: plugin.manifest.name },
            parsedRequest,
            abortController.signal
          )
        ),
        cancelledOnAbort
      ]);
      const parsedResult = PluginPromptTextResultSchema.parse(result);
      if (parsedResult.status === "submitted" && parsedResult.value.length > parsedRequest.maxLength) {
        throw new PluginHostError(
          `Plugin "${pluginId}" text prompt returned more than ${parsedRequest.maxLength} characters.`
        );
      }
      return parsedResult;
    } finally {
      if (this.openTextPrompts.get(pluginId) === openPrompt) {
        this.openTextPrompts.delete(pluginId);
      }
    }
  }

  private async requestImageForPlugin(
    pluginId: string,
    invocationToken: symbol | undefined,
    request: PluginImageRequest
  ): Promise<PluginImageRequestResult> {
    this.requirePermission(pluginId, "image.read");
    if (!invocationToken || this.activeCommandInvocations.get(invocationToken)?.pluginId !== pluginId) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may call images.requestImage only while one of its own commands is executing.`
      );
    }

    const parsedRequest = PluginImageRequestSchema.parse(request);
    if (!this.requestImage) {
      return { status: "unavailable", reason: "This host provides no image acquisition UI." };
    }

    const plugin = this.requireRegisteredPlugin(pluginId);
    const abortController = new AbortController();
    const requests = this.openImageRequests.get(invocationToken) ?? new Set<AbortController>();
    requests.add(abortController);
    this.openImageRequests.set(invocationToken, requests);
    const cancelledOnAbort = new Promise<PluginImageRequestResult>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    });

    try {
      const result = await Promise.race([
        Promise.resolve(
          this.requestImage(
            { id: plugin.manifest.id, name: plugin.manifest.name },
            parsedRequest,
            abortController.signal
          )
        ),
        cancelledOnAbort
      ]);
      const parsedResult = PluginImageRequestResultSchema.parse(result);
      if (parsedResult.status !== "provided") {
        return parsedResult;
      }
      validateProvidedImage(pluginId, parsedRequest, parsedResult.image);
      // In-process plugins share a heap with the provider. Give them their own byte snapshot, matching
      // the independent value a structured-clone worker hop naturally produces.
      const imageSnapshot = {
        status: "provided",
        image: { ...parsedResult.image, bytes: new Uint8Array(parsedResult.image.bytes) }
      } as const;
      const handedOut = this.providedImagesByInvocation.get(invocationToken) ?? [];
      handedOut.push({ ...imageSnapshot.image, bytes: new Uint8Array(imageSnapshot.image.bytes) });
      this.providedImagesByInvocation.set(invocationToken, handedOut);
      return imageSnapshot;
    } finally {
      requests.delete(abortController);
      if (requests.size === 0) {
        this.openImageRequests.delete(invocationToken);
      }
    }
  }

  private async recognizeStructureForPlugin(
    pluginId: string,
    invocationToken: symbol | undefined,
    image: PluginProvidedImage
  ): Promise<PluginRecognitionResult> {
    for (const permission of ["image.read", "ml.inference", "model.load", "native.execute"] as const) {
      this.requirePermission(pluginId, permission);
    }
    if (!invocationToken || this.activeCommandInvocations.get(invocationToken)?.pluginId !== pluginId) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may call recognition.recognizeStructure only while one of its own commands is executing.`
      );
    }

    const parsedImage = PluginProvidedImageSchema.parse(image);
    const handedOut = this.providedImagesByInvocation.get(invocationToken) ?? [];
    const heldImage = handedOut.find((candidate) => providedImagesEqual(candidate, parsedImage));
    if (!heldImage) {
      throw new PluginHostError(
        `Plugin "${pluginId}" may recognize only an image returned by images.requestImage in this command invocation.`
      );
    }
    if (!this.recognizeStructure) {
      return {
        status: "failed",
        code: "unsupported",
        message: "This host provides no local structure-recognition engine."
      };
    }

    const plugin = this.requireRegisteredPlugin(pluginId).manifest;
    const abortController = new AbortController();
    const requests = this.openRecognitionRequests.get(invocationToken) ?? new Set<AbortController>();
    requests.add(abortController);
    this.openRecognitionRequests.set(invocationToken, requests);
    const cancelledOnAbort = new Promise<PluginRecognitionResult>((resolve) => {
      // Abandoned, not declined: the plugin should stay silent rather than explain an install.
      abortController.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), {
        once: true
      });
    });
    try {
      const result = await Promise.race([
        Promise.resolve(
          this.recognizeStructure(
            { id: plugin.id, name: plugin.name },
            // The host's own retained copy, not the caller's bytes: what is recognized is exactly
            // what the user chose, whatever the plugin did to its snapshot afterwards.
            { ...heldImage, bytes: new Uint8Array(heldImage.bytes) },
            abortController.signal
          )
        ),
        cancelledOnAbort
      ]);
      const parsed = PluginRecognitionResultSchema.parse(result);
      if (parsed.status !== "recognized") return parsed;
      const invocation = this.activeCommandInvocations.get(invocationToken);
      if (invocation) invocation.recognized = true;
      const proposedPatch = parsed.result.proposedPatch;
      if (!proposedPatch || this.hasPermission(pluginId, "document.read")) return parsed;
      // No `document.read`: keep the document-derived insertion host-side and hand out an opaque
      // reference that `documents.proposePatch` resolves during this invocation.
      // An invocation that already ended can never propose, so nothing is held for it.
      const ref = `recognition_${this.createId()}`;
      if (invocation) {
        const held = this.heldRecognitionPatches.get(invocationToken) ?? new Map<string, NormalizedProposedDocumentPatch>();
        held.set(ref, proposedPatch);
        this.heldRecognitionPatches.set(invocationToken, held);
      }
      return {
        ...parsed,
        result: {
          ...parsed.result,
          proposedPatch: {
            ...proposedPatch,
            patch: { op: HostHeldRecognitionPatchOp, ref } as unknown as NormalizedProposedDocumentPatch["patch"]
          }
        }
      };
    } finally {
      requests.delete(abortController);
      if (requests.size === 0) this.openRecognitionRequests.delete(invocationToken);
    }
  }

  private finishCommandInvocation(invocationToken: symbol): void {
    const pluginId = this.activeCommandInvocations.get(invocationToken)?.pluginId;
    this.activeCommandInvocations.delete(invocationToken);
    this.textPromptInvocations.delete(invocationToken);
    for (const controller of this.openImageRequests.get(invocationToken) ?? []) {
      controller.abort();
    }
    this.openImageRequests.delete(invocationToken);
    this.providedImagesByInvocation.delete(invocationToken);
    this.heldRecognitionPatches.delete(invocationToken);
    for (const controller of this.openRecognitionRequests.get(invocationToken) ?? []) {
      controller.abort();
    }
    this.openRecognitionRequests.delete(invocationToken);
    if (pluginId && this.openTextPrompts.get(pluginId)?.invocationToken === invocationToken) {
      this.cancelOpenTextPrompt(pluginId);
    }
  }

  private cancelOpenTextPrompt(pluginId: string): void {
    this.openTextPrompts.get(pluginId)?.abortController.abort();
  }

  private cancelOpenImageRequests(pluginId: string): void {
    for (const [invocationToken, invocation] of this.activeCommandInvocations) {
      if (invocation.pluginId !== pluginId) continue;
      for (const controller of this.openImageRequests.get(invocationToken) ?? []) {
        controller.abort();
      }
      this.openImageRequests.delete(invocationToken);
      this.providedImagesByInvocation.delete(invocationToken);
      this.heldRecognitionPatches.delete(invocationToken);
      for (const controller of this.openRecognitionRequests.get(invocationToken) ?? []) {
        controller.abort();
      }
      this.openRecognitionRequests.delete(invocationToken);
    }
  }

  private requireRegisteredPlugin(pluginId: string): RegisteredPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new PluginHostError(`Plugin "${pluginId}" is not registered.`);
    }

    return plugin;
  }

  private requirePendingProposal(proposalId: string): QueuedProposedPatch {
    const queued = this.proposedPatches.get(proposalId);
    if (!queued) {
      throw new PluginHostError(`Proposed patch "${proposalId}" does not exist.`);
    }

    if (queued.status !== "pending") {
      throw new PluginHostError(`Proposed patch "${proposalId}" has already been ${queued.status}.`);
    }

    return queued;
  }

  private timestamp(): string {
    const value = this.now();
    return typeof value === "string" ? value : value.toISOString();
  }
}

interface ActiveCommandInvocation {
  pluginId: string;
  commandId: string;
  commandTitle: string;
  /** `getActiveDocumentKey()` when the command started; `applyPatch` must still see the same key. */
  documentKey: string | undefined;
  /** Set once recognition returned a structure in this invocation; `applyPatch` is then refused. */
  recognized: boolean;
}

function isHostHeldRecognitionPatch(patch: NormalizedProposedDocumentPatch["patch"]): boolean {
  return (patch as { op: string }).op === HostHeldRecognitionPatchOp;
}

function proposalReceipt(queued: QueuedProposedPatch): ProposedPatchReceipt {
  const { id, pluginId, status, createdAt, resolvedAt } = queued;
  return { id, pluginId, status, createdAt, ...(resolvedAt === undefined ? {} : { resolvedAt }) };
}

function validateProvidedImage(
  pluginId: string,
  request: NormalizedPluginImageRequest,
  image: PluginProvidedImage
): void {
  if (!request.sources.includes(image.source)) {
    throw new PluginHostError(
      `Image provider for plugin "${pluginId}" returned source "${image.source}", which was not requested.`
    );
  }
  if (image.bytes.byteLength === 0) {
    throw new PluginHostError(`Image provider for plugin "${pluginId}" returned an empty image.`);
  }
  if (image.bytes.byteLength > PluginImageMaxBytes) {
    throw new PluginHostError(
      `Image for plugin "${pluginId}" is ${image.bytes.byteLength} bytes; the host limit is ${PluginImageMaxBytes} bytes (25 MB).`
    );
  }
  if (image.width > PluginImageMaxDimension || image.height > PluginImageMaxDimension) {
    throw new PluginHostError(
      `Image for plugin "${pluginId}" is ${image.width}×${image.height}; each side must be at most ${PluginImageMaxDimension} pixels.`
    );
  }
}

function providedImagesEqual(left: PluginProvidedImage, right: PluginProvidedImage): boolean {
  if (
    left.mediaType !== right.mediaType ||
    left.width !== right.width ||
    left.height !== right.height ||
    left.source !== right.source ||
    left.fileName !== right.fileName ||
    left.bytes.byteLength !== right.bytes.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < left.bytes.byteLength; index += 1) {
    if (left.bytes[index] !== right.bytes[index]) return false;
  }
  return true;
}

class ScopedPluginStorage implements PluginStorage {
  constructor(private readonly values: Map<string, unknown>) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    assertStorageKey(key);
    return this.values.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    assertStorageKey(key);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    this.values.delete(key);
  }

  async listKeys(): Promise<string[]> {
    return Array.from(this.values.keys()).sort();
  }
}

export function validateTrustedPluginManifest(candidate: unknown): PluginManifest {
  return parsePluginManifest(candidate);
}

type RequiredCommandDefinition = Omit<CommandDefinition, "requiredPermissions" | "enabled" | "source"> & {
  source: "core" | "plugin";
  requiredPermissions: PluginPermission[];
  enabled: boolean;
};

function normalizeCommandDefinition(definition: CommandDefinition): RequiredCommandDefinition {
  return {
    ...definition,
    source: definition.source ?? "core",
    requiredPermissions: definition.requiredPermissions ?? [],
    enabled: definition.enabled ?? true
  };
}

function assertStorageKey(key: string): void {
  if (key.length === 0) {
    throw new PluginHostError("Plugin storage keys must be non-empty strings.");
  }
}

/** Return a deep-cloned, deeply frozen copy of a selection snapshot: independent per caller and
 *  immutable, so a plugin can neither mutate the host's state nor another caller's result. */
function freezeSelectionSnapshot(snapshot: PluginSelectionSnapshot): PluginSelectionSnapshot {
  return deepFreeze(structuredClone(snapshot));
}

/** Hand out proposals by value, matching the selection/analysis boundaries. Returning the stored
 *  object let a caller flip `status` underneath the queue (so `requirePendingProposal` would then
 *  disagree with the host's own state); a frozen clone makes that mutation fail instead. */
function snapshotProposal(queued: QueuedProposedPatch): QueuedProposedPatch {
  return deepFreeze(structuredClone(queued));
}

/**
 * Freeze an object graph, cycle-safe. The patch interior is deliberately `passthrough()` and
 * `structuredClone`/`postMessage` both preserve cycles, so a plugin can hand the host a self-
 * referencing proposal; without the visited set this recursed until the stack blew, and because the
 * throw escaped `proposePatch`/`listProposedPatches`/`rejectProposedPatch` — which the patch review
 * tray calls during render, with no error boundary above it — untrusted plugin input could take the
 * whole desktop app down and keep doing it after every restart. Same threat class the
 * prototype-pollution guard exists for.
 */
function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  // An ArrayBuffer view is a leaf, because the language gives us no lock to put on it: `Object.freeze`
  // THROWS on a view that has elements ("Cannot freeze array buffer views with elements") and so does
  // `Object.seal`. `structuredClone`/`postMessage` preserve typed arrays faithfully, so a proposal
  // carrying image bytes or any binary blob reached here and threw out of the same three entry points
  // the cycle guard above was added for. Returning early also skips `Object.keys`, which lists every
  // index on a typed array — descending would otherwise recurse once per byte.
  if (ArrayBuffer.isView(object)) {
    return value;
  }
  seen.add(object);
  // Freeze before descending: a cycle that reaches this node again is then already frozen and the
  // `seen` check short-circuits it either way.
  Object.freeze(object);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}
