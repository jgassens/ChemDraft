import type { ComputeStructureIdentifiers } from "@chemdraft/document-workflow-core";

// `moleculeSmiles` moved to @chemdraft/document-workflow-core so the headless CLI shares it; the
// engine loader below stays here because it registers the desktop's WASM URL.
export { moleculeSmiles } from "@chemdraft/document-workflow-core";

export async function loadStructureIdentifiers(): Promise<ComputeStructureIdentifiers | undefined> {
  try {
    const { registerRdkitWasmLoader } = await import("./rdkitWasmLoader");
    registerRdkitWasmLoader();
    const { computeStructureIdentifiers } = await import("@chemdraft/rdkit-adapter/identifiers");
    return computeStructureIdentifiers;
  } catch {
    // Export remains available through the native writer, with stereo loss disclosed below.
    return undefined;
  }
}
