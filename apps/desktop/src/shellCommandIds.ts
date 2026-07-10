import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";

/**
 * Every command id the in-place customize gallery can add to a toolbar — the full shell catalog, not
 * just the commands already declared in a toolset manifest. The toolset registry must treat these as
 * valid override/addition targets (via `applyToolsetLayoutState`'s `additionalCommandIds`), otherwise
 * an in-place addition of a non-manifest command (e.g. `edit.undo`) is pruned as "unknown" on render.
 * Command ids are static (only their enabled state depends on the document), so this is computed once.
 */
export const SHELL_COMMAND_IDS: ReadonlySet<string> = new Set(
  allShellCommands(createPhase4Document()).map((command) => command.id)
);
