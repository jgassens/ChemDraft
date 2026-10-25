import { CommandRegistry } from "@chemdraft/plugin-host";
import { createCoreCommandRegistrar, invokeAssistantRegistryCommand, type CoreCommandBinding } from "../commands/coreCommandRegistrar";
import type { AssistantCommandTarget, AssistantToolContext } from "./AssistantToolContext";

export function testCommandRegistry(context: AssistantToolContext, id: string, run: (target: AssistantCommandTarget) => void | Promise<void>) {
  const registry = new CommandRegistry();
  const bindings = new Map<string, CoreCommandBinding>([[id, {
    spec: { id, title: id, source: "core", enabled: false }, acceptsDocumentTarget: true,
    run: target => { if (!target) throw new Error("Missing document target"); return run(target); }
  }]]);
  createCoreCommandRegistrar(registry, () => bindings)(bindings);
  context.commands = { has: command => registry.has(command), invoke: (command, target) => invokeAssistantRegistryCommand(registry, command, target) };
  return registry;
}
