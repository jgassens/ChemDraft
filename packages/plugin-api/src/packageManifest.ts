/**
 * The built-package distribution contract (ADR-0029 §5, M35).
 *
 * `plugin:package` emits a **built, installable package**: a zip of `manifest.json`, the plugin's built
 * ES-module worker entry plus whatever chunks/assets it needs, and `LICENSE`. This module owns the shape
 * of that `manifest.json` so the two ends cannot drift — the packaging tool writes it, and a host reads
 * it to identify, permission, and load the plugin *without the monorepo*.
 *
 * The file is a **superset of {@link PluginManifest}**: every field the in-process registration path
 * already validates, plus one `chemdraftPackage` block carrying the provenance that `EXTRACTED.md`
 * records for the source distribution (source commit, SDK version, license file, packaging time).
 * `entry` is repurposed from the bundled convention's placeholder (`"dist/plugin.js"`) to the real,
 * package-relative filename of the built worker entry.
 *
 * Provenance is **descriptive, not a trust gate**: ADR-0029 is permissive, so nothing here adjudicates
 * whether a plugin may load. The adjacent `.sha256` sidecar is likewise integrity-only.
 *
 * It lives in the SDK (not in the tool or the desktop) because it is a generic, framework-free contract
 * between a plugin distribution and any host that loads one — the same reasoning that puts the worker
 * protocol here.
 */
import { z } from "zod";

import { PluginManifestSchema, parsePluginManifest, type PluginManifest } from "./index";

/** Filename of the manifest inside a built plugin package. */
export const PACKAGED_PLUGIN_MANIFEST_FILE = "manifest.json";

/** Key under which packaging provenance rides alongside the plugin manifest fields. */
export const PACKAGED_PLUGIN_PROVENANCE_KEY = "chemdraftPackage";

const NonEmpty = z.string().min(1);

/**
 * How the package was produced. `sourceTree: "clean"` is a literal because the packaging tool refuses a
 * dirty tree outright — a package that recorded anything else would be describing a commit that does not
 * match its own bytes.
 */
export const PackagedPluginProvenanceSchema = z
  .object({
    /** The single SDK package the plugin's source is allowed to import (ADR-0028). */
    sdk: NonEmpty,
    /** `PluginApiVersion` of the SDK bundled into the built entry. */
    sdkVersion: NonEmpty,
    /** Commit the plugin source was built from; its tree was verified clean. */
    sourceCommit: NonEmpty,
    sourceTree: z.literal("clean"),
    /** License file included in the package, verbatim from the plugin. */
    licenseFile: NonEmpty,
    /** ISO-8601 timestamp of the build. */
    packagedAt: NonEmpty
  })
  .strict();

export type PackagedPluginProvenance = z.infer<typeof PackagedPluginProvenanceSchema>;

/** A parsed `manifest.json`: the plugin manifest a host registers, plus the package's provenance. */
export interface PackagedPluginManifest {
  manifest: PluginManifest;
  provenance: PackagedPluginProvenance;
}

/** The `manifest.json` document as written to disk. */
export type PackagedPluginManifestDocument = PluginManifest & {
  [PACKAGED_PLUGIN_PROVENANCE_KEY]: PackagedPluginProvenance;
};

export function createPackagedPluginManifestDocument(
  manifest: PluginManifest,
  provenance: PackagedPluginProvenance
): PackagedPluginManifestDocument {
  return { ...manifest, [PACKAGED_PLUGIN_PROVENANCE_KEY]: provenance };
}

/**
 * Parse a package's `manifest.json`.
 *
 * `PluginManifestSchema` is `.strict()`, so the provenance block is split off before the manifest is
 * validated — the manifest half is then held to exactly the same schema (and the same cross-field rules,
 * such as "no contribution may require an undeclared permission") as a bundled plugin's. A packaged
 * plugin therefore cannot smuggle in a shape the in-process path would have rejected.
 *
 * @throws if the document is not an object, the provenance block is missing/malformed, or the manifest
 *   half fails validation.
 */
export function parsePackagedPluginManifest(candidate: unknown): PackagedPluginManifest {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid packaged plugin manifest: expected a JSON object.");
  }

  const { [PACKAGED_PLUGIN_PROVENANCE_KEY]: provenanceCandidate, ...manifestCandidate } = candidate as Record<
    string,
    unknown
  >;

  const provenance = PackagedPluginProvenanceSchema.safeParse(provenanceCandidate);
  if (!provenance.success) {
    throw new Error(
      `Invalid packaged plugin manifest: "${PACKAGED_PLUGIN_PROVENANCE_KEY}" is missing or malformed ` +
        `(${provenance.error.issues.map((issue) => `${issue.path.join(".") || "."}: ${issue.message}`).join("; ")}).`
    );
  }

  return { manifest: parsePluginManifest(manifestCandidate), provenance: provenance.data };
}

/** Whether a value is a well-formed packaged manifest document, without throwing. */
export function isPackagedPluginManifestDocument(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const { [PACKAGED_PLUGIN_PROVENANCE_KEY]: provenance, ...manifest } = candidate as Record<string, unknown>;
  return PackagedPluginProvenanceSchema.safeParse(provenance).success && PluginManifestSchema.safeParse(manifest).success;
}
