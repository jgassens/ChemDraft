import type { ApplyPatchOptions, ChemDraftDocument } from "@chemdraft/chem-core";
import { applyPatch } from "@chemdraft/chem-core";
import type {
  PluginCommandContext,
  PluginCommandHandler,
  NormalizedProposedDocumentPatch,
  PluginManifest,
  PluginPermission,
  PluginStorage,
  ProposedDocumentPatch,
  ProposedPatchReceipt,
  ProposedPatchStatus
} from "@chemdraft/plugin-api";
import { ProposedDocumentPatchSchema, parsePluginManifest } from "@chemdraft/plugin-api";

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
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  permissions: ReadonlySet<PluginPermission>;
}

export interface QueuedProposedPatch extends ProposedPatchReceipt {
  proposal: NormalizedProposedDocumentPatch;
}

export interface PluginHostOptions {
  commandRegistry?: CommandRegistry;
  getActiveDocument?: () => ChemDraftDocument | undefined | Promise<ChemDraftDocument | undefined>;
  now?: () => Date | string;
}

export class PluginHost {
  readonly commands: CommandRegistry;

  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly proposedPatches = new Map<string, QueuedProposedPatch>();
  private readonly storageScopes = new Map<string, Map<string, unknown>>();
  private readonly getActiveDocument?: PluginHostOptions["getActiveDocument"];
  private readonly now: () => Date | string;
  private nextProposalId = 1;

  constructor(options: PluginHostOptions = {}) {
    this.commands = options.commandRegistry ?? new CommandRegistry();
    this.getActiveDocument = options.getActiveDocument;
    this.now = options.now ?? (() => new Date());
  }

  registerPlugin(candidate: unknown, options: RegisterPluginOptions = {}): RegisteredPlugin {
    const manifest = validateTrustedPluginManifest(candidate);
    if (this.plugins.has(manifest.id)) {
      throw new PluginHostError(`Plugin "${manifest.id}" is already registered.`);
    }

    this.assertContributionPermissions(manifest);

    const registered: RegisteredPlugin = {
      manifest,
      permissions: new Set(manifest.permissions)
    };
    this.plugins.set(manifest.id, registered);
    this.registerManifestCommands(manifest, options.commandHandlers ?? {});
    return registered;
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
          return await this.getActiveDocument?.();
        },
        proposePatch: async (proposal) => this.proposePatch(pluginId, proposal)
      },
      storage,
      hasPermission: (permission) => this.hasPermission(pluginId, permission),
      requirePermission: (permission) => this.requirePermission(pluginId, permission)
    };
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

    this.proposedPatches.set(queued.id, queued);
    return queued;
  }

  listProposedPatches(status?: ProposedPatchStatus): QueuedProposedPatch[] {
    return Array.from(this.proposedPatches.values()).filter((proposal) => {
      return status ? proposal.status === status : true;
    });
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
    return updated;
  }

  rejectProposedPatch(proposalId: string): QueuedProposedPatch {
    const queued = this.requirePendingProposal(proposalId);
    queued.status = "rejected";
    queued.resolvedAt = this.timestamp();
    return queued;
  }

  getStorage(pluginId: string): PluginStorage {
    this.requirePermission(pluginId, "plugin.storage");
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
    for (const command of manifest.contributes.commands) {
      const handler = handlers[command.id];
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
