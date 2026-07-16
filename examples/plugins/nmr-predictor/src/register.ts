import type { PluginCommandHandler } from "@chemdraft/plugin-api";

import { predictSelectedStructure, type NmrCommandConfig, type NmrCommandServices } from "./application/predictSelectedStructure";
import { nmrPredictCarbonCommandId, nmrPredictProtonCommandId, nmrPredictorPanelId } from "./manifest";

export interface NmrPluginRegistration {
  commandHandlers: Record<string, PluginCommandHandler>;
  /** Cancels the in-flight prediction when the NMR panel is closed (ADR-0012). */
  onPanelClosed: (panelId: string) => void;
}

/**
 * Build the NMR plugin's registration for `host.registerPlugin`. A single shared `AbortController`
 * ties the active prediction to its panel: a new prediction supersedes (aborts) the prior one, and
 * closing the panel aborts the active one — so a late worker result can never resurrect a dismissed
 * panel. ¹³C is the default; ¹H is the separate experimental command (ADR-0011).
 */
export function createNmrRegistration(services: NmrCommandServices): NmrPluginRegistration {
  let active: AbortController | undefined;

  const run =
    (config: NmrCommandConfig): PluginCommandHandler =>
    async (context) => {
      active?.abort(); // supersede any in-flight prediction
      const controller = new AbortController();
      active = controller;
      try {
        return await predictSelectedStructure(context, services, config, controller.signal);
      } finally {
        if (active === controller) {
          active = undefined;
        }
      }
    };

  return {
    commandHandlers: {
      [nmrPredictCarbonCommandId]: run({ nuclei: ["13C"] }),
      [nmrPredictProtonCommandId]: run({ nuclei: ["1H"], ignoreLabileHydrogens: true })
    },
    onPanelClosed: (panelId) => {
      if (panelId === nmrPredictorPanelId) {
        active?.abort();
      }
    }
  };
}

/** Convenience for callers that only need the command handlers (no panel-close lifecycle). */
export function createNmrCommandHandlers(services: NmrCommandServices): Record<string, PluginCommandHandler> {
  return createNmrRegistration(services).commandHandlers;
}
