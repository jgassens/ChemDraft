import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { setRdkitModuleLoader, type RdkitMinimalModule } from
  "../../../../packages/rdkit-adapter/src/conformer";

/** jsdom rewrites import.meta.url to HTTP; load the real vendored WASM by filesystem path. */
export function installDomRdkitLoader(): void {
  const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
  const factory = new Function("require", "__dirname",
    `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(
      createRequire(glue), resolve("packages/rdkit-adapter/vendor")
    ) as (options: { wasmBinary: Uint8Array }) => Promise<RdkitMinimalModule>;
  setRdkitModuleLoader(() => factory({ wasmBinary: new Uint8Array(
    readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm"))) }));
}
