import { installNodeIsoSpecModuleLoader } from "./node";

/**
 * Point the adapter at the real IsoSpec WASM build under `vendor/`. Node-only.
 *
 * The glue is evaluated in a fresh function scope rather than `require()`d: the package is
 * `"type": "module"`, so Node would treat the vendored `.js` as ESM and its `module.exports =` would
 * never run. Same trap the RDKit loader documents.
 */
export function installRealIsoSpecModuleLoader(): void {
  installNodeIsoSpecModuleLoader();
}
