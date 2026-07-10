import type { PluginCommandHandler } from "@chemdraft/plugin-api";

import { analyzeSelectedStructureMass } from "./application/analyzeSelectedStructureMass";
import { massAnalyzeCommandId } from "./manifest";

export interface MassPluginRegistration {
  commandHandlers: Record<string, PluginCommandHandler>;
}

/**
 * Build the mass plugin's registration for `host.registerPlugin`. No panel-close lifecycle is needed:
 * the analysis is synchronous, so there is never an in-flight result to abort (contrast the NMR
 * plugin's `onPanelClosed`). Kept as a factory to match the NMR shape and stay easy to extend.
 */
export function createMassRegistration(): MassPluginRegistration {
  return {
    commandHandlers: {
      [massAnalyzeCommandId]: (context) => analyzeSelectedStructureMass(context)
    }
  };
}
