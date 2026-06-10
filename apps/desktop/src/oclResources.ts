/**
 * Browser-only resolver for OpenChemLib's torsion `resources.json` URL.
 *
 * Loaded ONLY via dynamic import() at spin time (see MainWindow `startSpin3d`), so
 * this node_modules asset reference never enters the static module graph the tests
 * traverse. `new URL(<static path>, import.meta.url)` is Vite's asset idiom: at
 * build time Vite emits the file and rewrites this to the hashed asset URL.
 *
 * OpenChemLib's package `exports` map forbids the bare `openchemlib/dist/...`
 * subpath, so we reference the symlinked file by relative path instead.
 */
export const oclResourcesUrl = new URL(
  "../node_modules/openchemlib/dist/resources.json",
  import.meta.url
).href;
