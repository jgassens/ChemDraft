/**
 * The browser build's startup command (`CHEMDRAFT_WEB_STARTUP_COMMAND`, see `webStartupCommandName.ts`).
 *
 * After the preloaded web plugins have finished loading, the named command is invoked once through the
 * app's ordinary command path — the one a menu item uses — so the plugin's permissions, its command
 * queue and the status line all apply exactly as if the user had chosen it. Only a command registered
 * by a *preloaded* plugin may run this way: core commands and bundled-plugin commands are refused, as is
 * an id that is not a well-formed command id, each with a specific diagnostic. A preloaded plugin that
 * declares any dangerous permission (`dangerousPluginPermissions`) is refused too: nothing dangerous runs
 * without explicit user action (AGENTS.md §3.2), and a build-time variable is not one. When the command
 * is unknown and a preloaded plugin that could have registered it failed to load, that failure is already
 * on the status line and nothing more is said; an unrelated failure does not hide an unknown id. It runs
 * at most once per page load, so a dev-server hot reload that remounts the app does not run it again. A
 * Tauri host never runs it (the desktop build refuses the variable outright).
 */

import { dangerousPluginPermissions } from "@chemdraft/plugin-api";
import type { CommandDefinition } from "@chemdraft/plugin-host";
import { isValidToolsetCommandId } from "@chemdraft/toolset-registry";
import { useEffect, useRef } from "react";

import type { TourMode } from "../tour/tourState";
import type { WebPreloadedPluginEntry, WebPreloadedPluginFailure } from "./webPreloadedPlugins";
import { parseWebStartupCommand } from "./webStartupCommandName";

/** This build's startup command; `undefined` for every desktop build and the normal web build. */
export const webStartupCommandId = parseWebStartupCommand(import.meta.env.CHEMDRAFT_WEB_STARTUP_COMMAND);

export const WEB_STARTUP_COMMAND_DIAGNOSTIC = "web-startup-command-refused";

export type WebStartupCommandDecision =
  | { kind: "run"; commandId: string; pluginId: string }
  /** A preloaded plugin that could have registered the command failed to load; its failure status
   *  already explains why nothing opened. */
  | { kind: "skip" }
  | { kind: "refuse"; message: string };

export interface WebStartupCommandContext {
  commandId: string;
  /** Preloaded plugins that loaded and registered. */
  preloaded: readonly WebPreloadedPluginEntry[];
  failures: readonly WebPreloadedPluginFailure[];
  /** The app's command registry lookup. */
  getCommand: (commandId: string) => CommandDefinition | undefined;
}

export function decideWebStartupCommand({ commandId, preloaded, failures, getCommand }: WebStartupCommandContext): WebStartupCommandDecision {
  const prefix = `Startup command "${commandId}" was not run:`;
  if (!isValidToolsetCommandId(commandId)) {
    return { kind: "refuse", message: `${prefix} it is not a valid command id.` };
  }
  const definition = getCommand(commandId);
  if (!definition) {
    const failedOwnerPossible = failures.some(failure => failure.commandIds === undefined || failure.commandIds.includes(commandId));
    if (failedOwnerPossible) return { kind: "skip" };
    return { kind: "refuse", message: `${prefix} no preloaded plugin registers that command.` };
  }
  const owner = definition.source === "plugin" && definition.pluginId !== undefined
    ? preloaded.find(entry => entry.descriptor !== undefined && entry.manifest.id === definition.pluginId)
    : undefined;
  if (!owner) {
    const registeredBy = definition.source === "plugin"
      ? `plugin "${definition.pluginId ?? "unknown"}", which is not a preloaded plugin`
      : "ChemDraft itself";
    return { kind: "refuse", message: `${prefix} it is registered by ${registeredBy}; only a preloaded plugin's command may run at startup.` };
  }
  const dangerous = new Set<string>(dangerousPluginPermissions);
  const declaredDangerous = owner.manifest.permissions.filter(permission => dangerous.has(permission));
  if (declaredDangerous.length > 0) {
    return {
      kind: "refuse",
      message: `${prefix} its plugin "${owner.manifest.id}" declares the dangerous permission${declaredDangerous.length === 1 ? "" : "s"} ` +
        `${declaredDangerous.join(", ")}, so its commands run only when you choose them.`
    };
  }
  return { kind: "run", commandId, pluginId: owner.manifest.id };
}

/** Survives a remount of the app within one page (a dev-server hot reload that does not preserve
 *  state) and resets on a real page load, which builds a fresh global object. */
const PAGE_GUARD_KEY = Symbol.for("chemdraft.webStartupCommand.claimed");
type GuardedGlobal = typeof globalThis & { [PAGE_GUARD_KEY]?: boolean };

/** True the first time it is called in this page, false after. */
export function claimWebStartupCommandForPage(target: object = globalThis): boolean {
  const guarded = target as GuardedGlobal;
  if (guarded[PAGE_GUARD_KEY]) return false;
  guarded[PAGE_GUARD_KEY] = true;
  return true;
}

/** Tests only: forget that this page already ran its startup command. */
export function resetWebStartupCommandPageGuard(target: object = globalThis): void {
  delete (target as GuardedGlobal)[PAGE_GUARD_KEY];
}

/** With a startup command configured the first-run tour does not open on its own (Help > Take the Tour
 *  still does). An explicit mode, as tests pass, always wins. */
export function tourModeForStartupCommand(mode: TourMode | undefined, startupCommandId: string | undefined): TourMode | undefined {
  return mode ?? (startupCommandId ? "suppress" : undefined);
}

export interface UseWebStartupCommandOptions {
  commandId: string | undefined;
  /** False on a Tauri host: there the startup command never runs. */
  enabled: boolean;
  /** `undefined` until the preloaded-plugin load has finished; then what it loaded and what failed. */
  preloadedLoad: { loaded: readonly WebPreloadedPluginEntry[]; failures: readonly WebPreloadedPluginFailure[] } | undefined;
  getCommand: (commandId: string) => CommandDefinition | undefined;
  /** The ordinary command path (MainWindow's `invoke`, as a menu item uses). */
  invoke: (commandId: string) => void | Promise<void>;
  /** Records a refusal or a failed invocation (plugin diagnostics and the console). */
  report: (message: string) => void;
}

/** Runs the startup command once per page load, after the preloaded plugins have loaded. A ref guards the
 *  mount, so StrictMode's repeated effects and any later change of the plugin list never run it again,
 *  and a page-wide flag guards a remount (a dev-server hot reload that does not preserve state). */
export function useWebStartupCommand(options: UseWebStartupCommandOptions): void {
  const current = useRef(options);
  current.current = options;
  const settledRef = useRef(false);
  const { commandId, enabled, preloadedLoad } = options;
  useEffect(() => {
    if (settledRef.current || !commandId || !enabled || !preloadedLoad) return;
    settledRef.current = true;
    if (!claimWebStartupCommandForPage()) return;
    const { getCommand, invoke, report } = current.current;
    const decision = decideWebStartupCommand({ commandId, preloaded: preloadedLoad.loaded, failures: preloadedLoad.failures, getCommand });
    if (decision.kind === "refuse") {
      report(decision.message);
      return;
    }
    if (decision.kind === "skip") return;
    void Promise.resolve()
      .then(() => invoke(decision.commandId))
      .catch((error: unknown) => {
        report(`Startup command "${decision.commandId}" failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, [commandId, enabled, preloadedLoad]);
}
