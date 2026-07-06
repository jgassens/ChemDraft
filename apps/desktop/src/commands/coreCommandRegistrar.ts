import type { CommandDefinition, CommandRegistry } from "@chemdraft/plugin-host";

export interface CoreCommandBinding {
  spec: CommandDefinition;
  run: () => void | Promise<void>;
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

      registry.register({ ...binding.spec, enabled: true }, async () => {
        const current = getLiveBindings().get(commandId);
        if (!current) {
          return { ok: false, commandId };
        }
        if (current.spec.enabled === false) {
          throw new Error(`Command "${commandId}" is disabled.`);
        }
        await current.run();
        return { ok: true, commandId };
      });
      registeredIds.add(commandId);
    }
  };
}
