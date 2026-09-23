import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";

/** Install the Node-backed chemistry engines used by ChemDraft CLI commands. */
export function installNodeEngines(): void {
  installNodeRdkitModuleLoader();
}
