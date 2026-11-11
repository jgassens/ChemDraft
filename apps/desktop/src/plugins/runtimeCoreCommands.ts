import { CommandRegistry, type CommandDefinition, type CommandHandler, type CommandInvocationContext } from "@chemdraft/plugin-host";
import { RuntimeBroker } from "./runtimeBroker";

/** The owner's registry owns plugin handlers only. Core definitions and invocations travel as
 * data; the document's registry remains the sole owner of core handlers and their live state. */
export class RuntimeCoreCommandRegistry extends CommandRegistry {
  private definitions: CommandDefinition[] = [];
  private revision = -1;
  readonly dispose: () => void;
  readonly ready: Promise<void>;
  constructor(private readonly broker: RuntimeBroker, private readonly documentWindow: string, strictInitialization = false) {
    super();
    this.dispose = broker.handle("setCoreCommands", ({ commands, revision }, sender) => {
      if (sender !== documentWindow) throw new Error("Core commands belong to another document window.");
      if (revision > this.revision) { this.definitions = commands; this.revision = revision; }
      return null;
    });
    this.ready = broker.call(documentWindow, "getCoreCommands", {}, strictInitialization ? 15_000 : undefined).then(commands => {
      if (this.revision < 0) this.definitions = commands;
    }).catch(error => { if (strictInitialization) throw error; });
  }
  private core(): CommandDefinition[] { return this.definitions; }
  override get(id: string): CommandDefinition | undefined {
    return super.get(id) ?? this.definitions.find(command => command.id === id);
  }
  override has(id: string): boolean { return !!this.get(id); }
  override list(): CommandDefinition[] { return [...this.core(), ...super.list()]; }
  override register(definition: CommandDefinition, handler: CommandHandler): void {
    if (this.has(definition.id)) throw new Error(`Command "${definition.id}" is already registered.`);
    super.register(definition, handler);
  }
  override async invoke<Result = unknown>(id: string, context: CommandInvocationContext = {}): Promise<Result> {
    if (super.has(id)) return super.invoke<Result>(id, context);
    return await this.broker.call(this.documentWindow, "invokeCoreCommand", { commandId: id, input: context.input,
      pluginId: context.pluginId, permissions: [...context.permissions ?? []] }) as Result;
  }
}

export function bindRuntimeCoreCommands(broker: RuntimeBroker, registry: CommandRegistry): () => void {
  const describe = ({ id, title, category, description, requiredPermissions, defaultShortcut, enabled }: CommandDefinition) =>
    ({ id, title, source: "core" as const, category, description, requiredPermissions, defaultShortcut, enabled });
  let revision = 0;
  let previous = "";
  const publish = () => {
    const commands = registry.list().filter(command => command.source !== "plugin" && !command.pluginId).map(describe);
    const value = JSON.stringify(commands);
    if (value === previous) return;
    previous = value;
    void broker.call("runtime", "setCoreCommands", { commands, revision: ++revision }).catch(() => undefined);
  };
  const stops = [
    registry.subscribe(publish),
    broker.handle("getCoreCommands", () => registry.list().filter(command => command.source !== "plugin" && !command.pluginId)
      .map(describe)),
    broker.handle("getCoreCommand", ({ commandId }) => {
      const command = registry.get(commandId);
      return command && command.source !== "plugin" && !command.pluginId ? describe(command) : undefined;
    }),
    broker.handle("invokeCoreCommand", ({ commandId, input, pluginId, permissions }) => {
      const command = registry.get(commandId);
      if (!command || command.source === "plugin" || command.pluginId) throw new Error("This document command is unavailable.");
      return registry.invoke(commandId, { input, pluginId, permissions: new Set(permissions) });
    })
  ];
  publish();
  return Object.assign(() => { for (const stop of stops) stop(); }, { publish });
}
