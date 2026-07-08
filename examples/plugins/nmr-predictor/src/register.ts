import type { PluginCommandHandler } from "@chemdraft/plugin-api";

import { predictSelectedStructure, type NmrCommandServices } from "./application/predictSelectedStructure";
import { nmrPredictCarbonCommandId, nmrPredictProtonCommandId } from "./manifest";

/**
 * Command handlers for the NMR plugin, keyed by command id, ready to hand to `host.registerPlugin`.
 * ¹³C is the default; ¹H is the separate experimental command (ADR-0011). The desktop registration
 * module supplies a worker-backed predictor via {@link NmrCommandServices}.
 */
export function createNmrCommandHandlers(services: NmrCommandServices): Record<string, PluginCommandHandler> {
  return {
    [nmrPredictCarbonCommandId]: (context) => predictSelectedStructure(context, services, { nuclei: ["13C"] }),
    [nmrPredictProtonCommandId]: (context) =>
      predictSelectedStructure(context, services, { nuclei: ["1H"], ignoreLabileHydrogens: true })
  };
}
