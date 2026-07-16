import { createStructureSourceFingerprint } from "@chemdraft/plugin-api";

import type { ChemicalStructureInput } from "./contracts";

export { createStructureSourceFingerprint };

/**
 * Structure-only fingerprint (empty document/page/object identity), used when a prediction request
 * omits the selection's fingerprint. Reuses the plugin-api algorithm so a value computed here and one
 * computed from a full selection over the same payload agree on the payload contribution.
 */
export function fingerprintStructureInput(input: ChemicalStructureInput): string {
  return createStructureSourceFingerprint({
    documentId: "",
    pageId: "",
    objectId: "",
    structureFormat: input.format,
    structure: input.value
  });
}
