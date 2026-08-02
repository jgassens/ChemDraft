// `applyPatch` (and its `ApplyPatchOptions`) are the chem-core RUNTIME the host calls; tsup bundles them
// into this package's dist so no `@chemdraft/chem-core` dependency ships (ADR-0031). `ChemDraftDocument`,
// however, is taken from `@chemdraft/plugin-api` so a consumer using both SDK packages sees ONE canonical
// document type — not a second, structurally-identical copy inlined here.
import type { ApplyPatchOptions } from "@chemdraft/chem-core";
import { applyPatch } from "@chemdraft/chem-core";
import type { ChemDraftDocument } from "@chemdraft/plugin-api";
import type {
  PluginAnalysisAPI,
  PluginAnalysisQuery,
  PluginAnalysisRecord,
  PluginAnalyzerContribution,
  PluginCommandContext,
  PluginCommandContribution,
  PluginCommandHandler,
  PluginMenuContribution,
  NormalizedProposedDocumentPatch,
  PluginManifest,
  PluginPanelAPI,
  PluginPanelContribution,
  PluginPanelReport,
  PluginPermission,
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
import { PluginPanelReportSchema, ProposedDocumentPatchSchema, parsePluginManifest } from "@chemdraft/plugin-api";

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

export interface PluginHostOptions {
  commandRegistry?: CommandRegistry;
  getActiveDocument?: () => ChemDraftDocument | undefined | Promise<ChemDraftDocument | undefined>;
  getSelection?: () => PluginSelectionSnapshot | undefined | Promise<PluginSelectionSnapshot | undefined>;
  /** Storage backend factory (defaults to per-plugin in-memory maps). The desktop app
   *  supplies a disk-backed implementation; the host stays platform-free. */
  createStorage?: (pluginId: string) => PluginStorage;
  /** Renders a validated panel report; absent hosts simply expose no panels API. */
  showPanelReport?: (pluginId: string, panelId: string, report: PluginPanelReport) => void | Promise<void>;
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
  private readonly getSelectionSnapshot?: PluginHostOptions["getSelection"];
  private readonly createStorage?: PluginHostOptions["createStorage"];
  private readonly showPanelReport?: PluginHostOptions["showPanelReport"];
  private readonly onProposedPatchesChanged?: PluginHostOptions["onProposedPatchesChanged"];
  private readonly now: () => Date | string;
  private readonly createId: () => string;
  private readonly analysisStore: AnalysisStore;
  private nextProposalId = 1;
  private readonly subscribers = new Set<() => void>();

  constructor(options: PluginHostOptions = {}) {
    this.commands = options.commandRegistry ?? new CommandRegistry();
    this.getActiveDocument = options.getActiveDocument;
    this.getSelectionSnapshot = options.getSelection;
    this.createStorage = options.createStorage;
    this.showPanelReport = options.showPanelReport;
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

  /** Removes a plugin and its registered commands. Storage scopes and proposal history
   *  survive on purpose: they are user-facing records, not runtime wiring. */
  unregisterPlugin(pluginId: string): void {
    const plugin = this.requireRegisteredPlugin(pluginId);
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

  createCommandContext(pluginId: string): PluginCommandContext {
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

    return {
      plugin: {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        permissions: plugin.manifest.permissions
      },
      documents: {
        getActiveDocument: async () => {
          this.requirePermission(pluginId, "document.read");
          const document = await this.getActiveDocument?.();
          // Same boundary as the selection API above: an independent, immutable copy. In-process
          // plugins share the host's heap, so returning the provider's value handed them the live
          // document — edits would land without ever passing through propose/review.
          return document === undefined ? undefined : deepFreeze(structuredClone(document));
        },
        proposePatch: async (proposal) => this.proposePatch(pluginId, proposal)
      },
      storage,
      selection,
      panels,
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
    this.requirePermission(pluginId, "document.proposePatch");
    const parsedProposal = ProposedDocumentPatchSchema.parse(proposal);
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
    return snapshot;
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
    this.onProposedPatchesChanged?.();
    return updated;
  }

  rejectProposedPatch(proposalId: string): QueuedProposedPatch {
    const queued = this.requirePendingProposal(proposalId);
    queued.status = "rejected";
    queued.resolvedAt = this.timestamp();
    this.onProposedPatchesChanged?.();
    return snapshotProposal(queued);
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

            return await handler(this.createCommandContext(manifest.id));
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
