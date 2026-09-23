import { setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";

import { runRenderCommand } from "../render";

// Reproduce a duplicated adapter module: `instanceof` cannot cross that identity boundary, but the
// typed error name still marks this as a configuration failure that must never trigger OCL fallback.
installNodeRdkitModuleLoader();
setRdkitModuleLoader(() => {
  const error = new Error("RDKit module loader not set (duplicate module identity).");
  error.name = "RdkitNotConfiguredError";
  return Promise.reject(error);
});
process.exitCode = await runRenderCommand([
  "--smiles", "CCO",
  "--out", process.argv[2] ?? "rdkit-not-configured.svg"
]);
