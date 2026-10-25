import type { CommandDefinition, CommandInvocationContext, CommandRegistry } from "@chemdraft/plugin-host";
import type { AssistantCommandTarget } from "../assistant/AssistantToolContext";
import { assistantCommand } from "../assistant/commandCatalog";

// Host-only, per invocation: neither plugin input nor model arguments can manufacture this target.
const documentTargets = new WeakMap<CommandInvocationContext, AssistantCommandTarget>();
export async function invokeAssistantRegistryCommand(registry: CommandRegistry, id: string, target: AssistantCommandTarget): Promise<void> {
  if (!assistantCommand(id) || registry.get(id)?.source !== "core") throw new Error(`Command ${id} is not allowlisted.`);
  const invocation: CommandInvocationContext = {};
  documentTargets.set(invocation, target);
  try {
    const result = await registry.invoke<{ ok: boolean }>(id, invocation);
    if (!result?.ok) throw new Error(`Command ${id} is unavailable.`);
  } finally { documentTargets.delete(invocation); }
}

export interface CoreCommandBinding {
  spec: CommandDefinition;
  run: (target?: AssistantCommandTarget) => void | Promise<void>;
  acceptsDocumentTarget?: boolean;
}

export type CoreCommandBindings = ReadonlyMap<string, CoreCommandBinding>;

/**
 * Keeps a CommandRegistry's *core* commands in sync with a live bindings map — without ever
 * replacing the registry instance. Every core handler delegates to `getLiveBindings()`, so
 * it always runs the latest closure even though the registry is registered once; and the
 * enabled-gate lives in the delegating handler so the always-enabled registered definition
 * never goes stale. Because the instance is stable, plugin commands registered separately
 * into the same registry are never wiped when core bindings change (Phase 2 relies on this).
 *
 * Returns a `sync(bindings)` to call whenever the bindings map changes: it registers newly
 * added ids, unregisters removed ones, and leaves everything else (including plugin
 * commands) untouched.
 */
export function createCoreCommandRegistrar(
  registry: CommandRegistry,
  getLiveBindings: () => CoreCommandBindings
): (bindings: CoreCommandBindings) => void {
  const registeredIds = new Set<string>();

  return (bindings) => {
    for (const registeredId of [...registeredIds]) {
      if (!bindings.has(registeredId)) {
        registry.unregister(registeredId);
        registeredIds.delete(registeredId);
      }
    }

    for (const [commandId, binding] of bindings) {
      if (registeredIds.has(commandId)) {
        continue;
      }

      registry.register({ ...binding.spec, enabled: true }, async invocation => {
        const current = getLiveBindings().get(commandId);
        if (!current) {
          return { ok: false, commandId };
        }
        const target = documentTargets.get(invocation);
        if (target && (!current.acceptsDocumentTarget || !assistantCommand(commandId))) {
          throw new Error(`Command ${commandId} does not support an isolated document target.`);
        }
        // The menu's enabled state describes its live selection. Target handlers validate the
        // captured selection themselves, without changing the user's live selection.
        if (!target && current.spec.enabled === false) {
          throw new Error(`Command "${commandId}" is disabled.`);
        }
        target?.assertActive();
        await current.run(target);
        return { ok: true, commandId };
      });
      registeredIds.add(commandId);
    }
  };
}
