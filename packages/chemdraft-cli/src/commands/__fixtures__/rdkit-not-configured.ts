import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import { runRenderCommand } from "../render";

// Reproduce a host that installed its bridge and then lost the configured loader. The Node bridge's
// idempotence guard deliberately prevents the command from repairing this inconsistent state.
installNodeRdkitModuleLoader();
resetRdkitForTesting();
process.exitCode = await runRenderCommand([
  "--smiles", "CCO",
  "--out", process.argv[2] ?? "rdkit-not-configured.svg"
]);
