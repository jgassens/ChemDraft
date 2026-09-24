/**
 * Load an RDKit adapter entry point with the app's WASM loader registered first.
 *
 * `@chemdraft/rdkit-adapter` never loads RDKit on its own: until `registerRdkitWasmLoader()` has run,
 * every call rejects with "RDKit module loader not set". Each host path that reaches RDKit therefore
 * goes through here rather than importing the adapter bare — recognition validation once did, and
 * every recognition failed in the app while unit tests that mocked the adapter stayed green.
 */
export async function loadRdkitWithAppLoader<T>(load: () => Promise<T>): Promise<T> {
  const [{ registerRdkitWasmLoader }, loaded] = await Promise.all([import("../rdkitWasmLoader"), load()]);
  registerRdkitWasmLoader();
  return loaded;
}
