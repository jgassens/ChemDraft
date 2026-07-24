/**
 * Load a plugin from its **built package** instead of from a worker entry bundled into the app
 * (ADR-0029 §5, M35).
 *
 * This is the programmatic/dev-only load path: it takes the *already-unpacked* contents of a package
 * produced by `pnpm plugin:package` and runs the plugin in a Worker through the same
 * {@link PluginWorkerBridge} the bundled plugins use. Staging a downloaded zip, install records, and any
 * user-facing UI are M36; nothing here reads a zip, touches app data, or renders.
 *
 * The whole point is that nothing downstream can tell the difference: the descriptor returned here has
 * the same shape as a bundled one, its command handlers are built by the same
 * {@link createWorkerRoutedOptions}, and it registers through the same runtime `registerPlugin`. A packaged
 * plugin therefore produces the same analysis record and the same panel report as the bundled path
 * because it *is* the same path — only the worker's script URL differs.
 *
 * ## Co-location is load-bearing
 *
 * `baseUrl` must be a real directory URL whose files are co-located, because the package's internal
 * references are relative to the *importing module's own URL* (`plugin:package` builds with
 * `base: "./"`). The NMR plugin makes this concrete: from inside its worker it does
 * `new Worker(new URL("assets/nmrWorker-*.js", import.meta.url))` and its reference database rides in
 * that sibling chunk.
 *
 * A **blob URL cannot host this package**: a blob has no siblings, so `import.meta.url`-relative
 * resolution has nothing to resolve against, and inlining a multi-megabyte database into one script to
 * dodge the problem is not acceptable. {@link assertResolvablePackageBase} refuses a blob/data base
 * loudly rather than letting a plugin fail deep inside its own startup — the constraint is surfaced, not
 * papered over. See reports/0030 for the measured evidence and its consequences for M36/M37.
 */

import {
  PluginApiVersion,
  parsePackagedPluginManifest,
  type PackagedPluginManifest,
  type PluginWorkerHandle
} from "@chemdraft/plugin-api";

import { PluginWorkerBridge } from "./PluginWorkerBridge";
import { createWorkerRoutedOptions, type BundledPluginDescriptor } from "./registerBundledPlugins";

export interface PackagedPluginLocation {
  /**
   * Directory URL holding the unpacked package's files (`manifest.json`, the built entry, its chunks and
   * assets, `LICENSE`). A trailing slash is added if missing.
   */
  baseUrl: string | URL;
  /** Parsed JSON contents of the package's `manifest.json`. */
  manifest: unknown;
}

export interface LoadPackagedPluginOptions {
  /** Host API version the worker's `ready` handshake is checked against. Defaults to the SDK's. */
  hostApiVersion?: string;
  /**
   * Create the worker for the package's entry. Defaults to a real ES-module `Worker`. Injectable so a
   * non-browser host (or a test) can supply an equivalent handle for the same entry URL.
   */
  createWorker?: (entryUrl: URL) => PluginWorkerHandle;
}

export interface PackagedPluginDescriptor extends BundledPluginDescriptor {
  /** Always present for a packaged plugin: its execution is always a worker. */
  bridge: PluginWorkerBridge;
  /** Where the package's entry was loaded from. */
  entryUrl: URL;
  /** Provenance recorded at packaging time. Descriptive only — never a trust gate (ADR-0029 §4). */
  provenance: PackagedPluginManifest["provenance"];
}

/** A package base whose files cannot have siblings can never satisfy the package's relative references. */
export class PackagedPluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagedPluginLoadError";
  }
}

function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith("/")) return url;
  const normalized = new URL(url.href);
  normalized.pathname = `${normalized.pathname}/`;
  return normalized;
}

/**
 * Refuse a base URL that cannot resolve relative siblings. `blob:` and `data:` URLs are opaque — they
 * address one anonymous byte string with no directory around it — so a multi-file package loaded from
 * one would fail unpredictably deep inside the plugin (the NMR plugin, for instance, only discovers it
 * when it tries to spawn its nested worker). Failing here instead keeps the real constraint visible.
 */
export function assertResolvablePackageBase(baseUrl: URL): void {
  if (baseUrl.protocol === "blob:" || baseUrl.protocol === "data:") {
    throw new PackagedPluginLoadError(
      `Cannot load a built plugin package from a ${baseUrl.protocol} base URL: it has no sibling files, so the ` +
        "package's relative references (nested workers, code-split chunks, data assets) cannot resolve. " +
        "Serve the unpacked package from a real directory URL with its files co-located."
    );
  }
}

/** The URL the package's built worker entry will be loaded from. */
export function packagedPluginEntryUrl(location: PackagedPluginLocation, manifest: PackagedPluginManifest): URL {
  const base = withTrailingSlash(new URL(location.baseUrl.toString()));
  assertResolvablePackageBase(base);
  return new URL(manifest.manifest.entry, base);
}

/** Parse and validate a package's `manifest.json` (schema-identical to a bundled plugin's manifest). */
export function readPackagedPluginManifest(location: PackagedPluginLocation): PackagedPluginManifest {
  return parsePackagedPluginManifest(location.manifest);
}

function defaultWorkerFactory(entryUrl: URL): PluginWorkerHandle {
  if (typeof Worker === "undefined") {
    throw new PackagedPluginLoadError(
      "This environment has no Worker, so a built plugin package cannot be loaded. Supply createWorker to " +
        "drive an equivalent worker handle."
    );
  }
  return new Worker(entryUrl, { type: "module" }) as unknown as PluginWorkerHandle;
}

/**
 * Build a registerable descriptor for a plugin held in an unpacked package. The worker is created
 * lazily by the bridge on first invocation, so listing an installed plugin costs nothing until it runs;
 * the `ready`/`apiVersion` handshake is enforced there, and `bridge.terminate()` is the full teardown
 * M36's uninstall will call.
 *
 * Supported declared permissions are honored exactly as the manifest states them — auto-granted, no
 * consent gate (ADR-0029 §3). The desktop runtime rejects reserved permissions for which it has no safe
 * capability broker; the host still builds the context, so an undeclared capability is never available
 * to the worker.
 */
export function loadPackagedPlugin(
  location: PackagedPluginLocation,
  options: LoadPackagedPluginOptions = {}
): PackagedPluginDescriptor {
  const packaged = readPackagedPluginManifest(location);
  const entryUrl = packagedPluginEntryUrl(location, packaged);
  const createWorker = options.createWorker ?? defaultWorkerFactory;

  const descriptor = {
    manifest: packaged.manifest,
    options: { commandHandlers: {} },
    bridge: undefined as unknown as PluginWorkerBridge,
    entryUrl,
    provenance: packaged.provenance
  } as PackagedPluginDescriptor;
  let active = false;
  descriptor.activate = () => {
    if (active) return;
    const bridge = new PluginWorkerBridge({
      pluginId: packaged.manifest.id,
      createWorker: () => createWorker(entryUrl),
      hostApiVersion: options.hostApiVersion ?? PluginApiVersion
    });
    descriptor.bridge = bridge;
    descriptor.options = createWorkerRoutedOptions(packaged.manifest, bridge);
    active = true;
  };
  descriptor.deactivate = () => {
    if (!active) return;
    descriptor.bridge.terminate();
    active = false;
  };
  descriptor.activate();
  return descriptor;
}
