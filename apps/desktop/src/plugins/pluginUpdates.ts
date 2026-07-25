/**
 * Host-owned plugin update catalog and download path.
 *
 * Update locations never come from a plugin manifest. This module maps an allowlisted plugin id to
 * one exact public release repository, validates that repository's response, and downloads through
 * Tauri's native HTTP client. Installed plugin workers retain their same-origin-only CSP.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import {
  inspectPluginPackage,
  type InstalledPluginCatalogEntry,
  type PluginPackageInspection
} from "./installPluginPackage";
import {
  DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS
} from "./pluginPackageArchive";
import {
  comparePluginVersions,
  isPluginPrereleaseVersion,
  pluginVersionFromReleaseTag
} from "./pluginVersion";

const NMR_PLUGIN_ID = "org.chemdraft.nmr.predictor";

interface TrustedPluginUpdateSource {
  pluginId: string;
  repository: string;
  assetStem: string;
}

const TRUSTED_PLUGIN_UPDATE_SOURCES = new Map<string, TrustedPluginUpdateSource>([
  [NMR_PLUGIN_ID, {
    pluginId: NMR_PLUGIN_ID,
    repository: "jgassens/ChemDraft-NMR-Plugin",
    assetStem: "nmr-predictor"
  }]
]);

interface HostFetchInit extends RequestInit {
  /** Tauri HTTP client option. Zero prevents Rust/reqwest from following an unchecked target. */
  maxRedirections?: number;
  /** Tauri HTTP client connection timeout, in milliseconds. */
  connectTimeout?: number;
}

type HostFetch = (url: string, init?: HostFetchInit) => Promise<Response>;

const RELEASE_METADATA_LIMIT_BYTES = 1024 * 1024;
const UPDATE_CHECK_TIMEOUT_MS = 20_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
const UPDATE_CONNECT_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/**
 * Where GitHub redirects a release-asset download.
 *
 * These two strings are also spelled out in `capabilities/plugin-updates.json`, and the runtime
 * needs both to agree: this module refuses a redirect that does not match, and the capability scope
 * refuses the follow-up request that does not match. GitHub has moved this host before (from
 * `objects.githubusercontent.com`), so a test pins the constants to the capability file — otherwise
 * a future move would surface as "redirect did not target GitHub's trusted release-asset host" with
 * nothing pointing at the cause. Exported for that test.
 */
export const GITHUB_RELEASE_ASSET_HOST = "release-assets.githubusercontent.com";
export const GITHUB_RELEASE_ASSET_PATH_PREFIX = "/github-production-release-asset/";

export interface PluginUpdateOffer {
  pluginId: string;
  pluginName: string;
  installedVersion: string;
  version: string;
  releaseUrl: string;
  packageUrl: string;
  packageName: string;
  sourceChecksum: string;
  compressedBytes: number;
  publishedAt: string;
}

export type PluginUpdateCheckResult =
  | {
      status: "unsupported";
      pluginId: string;
      installedVersion: string;
    }
  | {
      status: "upToDate";
      pluginId: string;
      installedVersion: string;
      latestVersion: string;
    }
  | {
      status: "available";
      pluginId: string;
      installedVersion: string;
      latestVersion: string;
      offer: PluginUpdateOffer;
    }
  | {
      status: "failed";
      pluginId: string;
      installedVersion: string;
      message: string;
    };

export interface PreparedPluginUpdate {
  offer: PluginUpdateOffer;
  inspection: PluginPackageInspection;
  /** HTTPS source shown in the existing package-review disclosure. */
  sourcePath: string;
  /** The archive matched the SHA-256 digest in the trusted release response. */
  checksumVerified: true;
}

/** Check every installed plugin without allowing one failed source to hide the others. */
export async function checkForPluginUpdates(
  installedPlugins: readonly InstalledPluginCatalogEntry[],
  options: { fetch?: HostFetch } = {}
): Promise<readonly PluginUpdateCheckResult[]> {
  const fetch = options.fetch ?? (tauriFetch as HostFetch);
  return Promise.all(
    installedPlugins.map(async (entry): Promise<PluginUpdateCheckResult> => {
      const source = TRUSTED_PLUGIN_UPDATE_SOURCES.get(entry.record.id);
      if (!source) {
        return {
          status: "unsupported",
          pluginId: entry.record.id,
          installedVersion: entry.record.version
        };
      }

      try {
        const offer = await fetchLatestOffer(entry, source, fetch);
        const comparison = comparePluginVersions(offer.version, entry.record.version);
        if (comparison <= 0) {
          return {
            status: "upToDate",
            pluginId: entry.record.id,
            installedVersion: entry.record.version,
            latestVersion: offer.version
          };
        }
        return {
          status: "available",
          pluginId: entry.record.id,
          installedVersion: entry.record.version,
          latestVersion: offer.version,
          offer
        };
      } catch (cause: unknown) {
        return {
          status: "failed",
          pluginId: entry.record.id,
          installedVersion: entry.record.version,
          message: messageOf(cause)
        };
      }
    })
  );
}

/** Download and fully inspect an offered update, but do not install it. */
export async function preparePluginUpdate(
  offer: PluginUpdateOffer,
  options: { fetch?: HostFetch } = {}
): Promise<PreparedPluginUpdate> {
  const source = assertTrustedOffer(offer);
  const fetch = options.fetch ?? (tauriFetch as HostFetch);
  const zipBytes = await downloadTrustedReleaseAsset(fetch, {
    url: offer.packageUrl,
    limit: DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes,
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    timeoutLabel: `Downloading ${offer.pluginName} ${offer.version}`,
    assetLabel: "plugin package",
    boundedLabel: `${offer.pluginName} update`,
    failureLabel: `Downloading ${offer.pluginName} ${offer.version}`,
    redirectLabel: `Downloading ${offer.pluginName}`
  });

  // The release's own published `.sha256` is what verifies the archive, and it must agree with the
  // digest GitHub recorded for the asset. Requiring both means a release whose sidecar was made
  // from different bytes fails closed instead of silently deferring to the API digest — and it
  // makes the sidecar-must-exist rule enforced earlier actually mean something. Neither value is a
  // publisher signature; both are integrity metadata.
  const sidecar = await fetchReleaseSidecar(offer, fetch);
  const inspection = await inspectPluginPackage({ zipBytes, sidecar });
  if (inspection.manifest.id !== source.pluginId) {
    throw new Error(
      `The update package declares plugin id "${inspection.manifest.id}", but the trusted offer is for ` +
        `"${source.pluginId}". Refusing the replacement.`
    );
  }
  if (inspection.manifest.version !== offer.version) {
    throw new Error(
      `The update package declares version "${inspection.manifest.version}", but the trusted release offered ` +
        `"${offer.version}". Refusing the replacement.`
    );
  }
  if (comparePluginVersions(inspection.manifest.version, offer.installedVersion) <= 0) {
    throw new Error(
      `The downloaded plugin version ${inspection.manifest.version} is not newer than installed version ` +
        `${offer.installedVersion}.`
    );
  }

  return {
    offer,
    inspection,
    sourcePath: offer.packageUrl,
    checksumVerified: true
  };
}

async function fetchLatestOffer(
  entry: InstalledPluginCatalogEntry,
  source: TrustedPluginUpdateSource,
  fetch: HostFetch
): Promise<PluginUpdateOffer> {
  const apiUrl = `https://api.github.com/repos/${source.repository}/releases/latest`;
  const releasePayload = await withUpdateTimeout(
    UPDATE_CHECK_TIMEOUT_MS,
    `Checking ${entry.manifest.name} updates`,
    async (signal) => {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
        maxRedirections: 0,
        connectTimeout: UPDATE_CONNECT_TIMEOUT_MS,
        signal
      });
      await assertResponseStayedAt(response, apiUrl, "release metadata");
      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response);
        throw new Error(`Checking ${entry.manifest.name} refused an unexpected metadata redirect.`);
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(
          `Checking ${entry.manifest.name} updates failed with HTTP ${response.status} ${response.statusText}.`
        );
      }
      const bytes = await readBoundedResponseBytes(
        response,
        RELEASE_METADATA_LIMIT_BYTES,
        `${entry.manifest.name} release metadata`
      );
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new Error(`The latest ${entry.manifest.name} release response is not valid JSON.`);
      }
    }
  );

  const release = asRecord(releasePayload, "latest release");
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error(`The latest ${entry.manifest.name} release is not a published stable release.`);
  }
  const tag = requiredString(release.tag_name, "release tag");
  const version = pluginVersionFromReleaseTag(tag);
  if (isPluginPrereleaseVersion(version)) {
    throw new Error(`Plugin release "${tag}" is a prerelease; only stable updates are offered.`);
  }

  const expectedReleaseUrl = `https://github.com/${source.repository}/releases/tag/${tag}`;
  const releaseUrl = requiredString(release.html_url, "release page");
  if (releaseUrl !== expectedReleaseUrl) {
    throw new Error(`The plugin release page did not match the trusted ${source.repository} repository.`);
  }

  if (!Array.isArray(release.assets)) {
    throw new Error("The plugin release does not contain an asset list.");
  }
  const packageName = `${source.assetStem}-${version}.zip`;
  const sidecarName = `${packageName}.sha256`;
  const packageAsset = release.assets.map((value) => asRecord(value, "release asset")).find((asset) => asset.name === packageName);
  const sidecarAsset = release.assets.map((value) => asRecord(value, "release asset")).find((asset) => asset.name === sidecarName);
  if (!packageAsset || !sidecarAsset) {
    throw new Error(
      `Plugin release ${tag} must contain both "${packageName}" and "${sidecarName}".`
    );
  }

  const expectedDownloadUrl = `https://github.com/${source.repository}/releases/download/${tag}/${packageName}`;
  const packageUrl = requiredString(packageAsset.browser_download_url, "package download URL");
  if (packageUrl !== expectedDownloadUrl) {
    throw new Error(`The plugin package download did not match the trusted ${source.repository} release path.`);
  }
  const expectedSidecarUrl = `${expectedDownloadUrl}.sha256`;
  if (requiredString(sidecarAsset.browser_download_url, "checksum download URL") !== expectedSidecarUrl) {
    throw new Error(`The plugin checksum download did not match the trusted ${source.repository} release path.`);
  }

  const sourceChecksum = parseAssetDigest(packageAsset.digest);
  const compressedBytes = requiredPositiveInteger(packageAsset.size, "package size");
  if (compressedBytes > DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new Error(
      `Plugin release ${tag} is ${compressedBytes} compressed bytes, exceeding ChemDraft's ` +
        `${DEFAULT_PLUGIN_PACKAGE_ARCHIVE_LIMITS.maxCompressedBytes}-byte package limit.`
    );
  }
  const publishedAt = requiredIsoDate(release.published_at, "release publication time");

  return {
    pluginId: source.pluginId,
    pluginName: entry.manifest.name,
    installedVersion: entry.record.version,
    version,
    releaseUrl,
    packageUrl,
    packageName,
    sourceChecksum,
    compressedBytes,
    publishedAt
  };
}

function assertTrustedOffer(offer: PluginUpdateOffer): TrustedPluginUpdateSource {
  const source = TRUSTED_PLUGIN_UPDATE_SOURCES.get(offer.pluginId);
  if (!source) {
    throw new Error(`Plugin "${offer.pluginId}" has no trusted ChemDraft update source.`);
  }
  const version = pluginVersionFromReleaseTag(`v${offer.version}`);
  const expectedName = `${source.assetStem}-${version}.zip`;
  const expectedUrl = `https://github.com/${source.repository}/releases/download/v${version}/${expectedName}`;
  if (
    offer.packageName !== expectedName ||
    offer.packageUrl !== expectedUrl ||
    !/^[0-9a-f]{64}$/.test(offer.sourceChecksum)
  ) {
    throw new Error(`The ${offer.pluginName} update offer does not match ChemDraft's trusted catalog.`);
  }
  return source;
}

async function withUpdateTimeout<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (cause: unknown) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

/** A shasum-format digest file is a few dozen bytes; anything larger is not one. */
const MAX_SIDECAR_BYTES = 4096;

/**
 * Fetch one allowlisted release asset: no automatic redirects, at most one hop that must resolve to
 * GitHub's release-asset host, and a body read that stops at `limit` rather than after buffering.
 */
async function downloadTrustedReleaseAsset(
  fetch: HostFetch,
  options: {
    url: string;
    limit: number;
    timeoutMs: number;
    timeoutLabel: string;
    assetLabel: string;
    boundedLabel: string;
    failureLabel: string;
    redirectLabel: string;
  }
): Promise<Uint8Array> {
  return withUpdateTimeout(options.timeoutMs, options.timeoutLabel, async (signal) => {
    const initialResponse = await fetch(options.url, {
      method: "GET",
      maxRedirections: 0,
      connectTimeout: UPDATE_CONNECT_TIMEOUT_MS,
      signal
    });
    await assertResponseStayedAt(initialResponse, options.url, options.assetLabel);

    let response = initialResponse;
    if (REDIRECT_STATUSES.has(initialResponse.status)) {
      let redirectUrl: string;
      try {
        redirectUrl = trustedGitHubAssetRedirect(
          requiredString(initialResponse.headers.get("location"), `${options.assetLabel} redirect`)
        );
      } catch (cause: unknown) {
        await cancelResponseBody(initialResponse);
        throw cause;
      }
      await cancelResponseBody(initialResponse);
      response = await fetch(redirectUrl, {
        method: "GET",
        maxRedirections: 0,
        connectTimeout: UPDATE_CONNECT_TIMEOUT_MS,
        signal
      });
      await assertResponseStayedAt(response, redirectUrl, "release asset");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await cancelResponseBody(response);
      throw new Error(`${options.redirectLabel} refused an unexpected second redirect.`);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(
        `${options.failureLabel} failed with HTTP ${response.status} ${response.statusText}.`
      );
    }

    return readBoundedResponseBytes(response, options.limit, options.boundedLabel);
  });
}

async function fetchReleaseSidecar(offer: PluginUpdateOffer, fetch: HostFetch): Promise<string> {
  const bytes = await downloadTrustedReleaseAsset(fetch, {
    url: `${offer.packageUrl}.sha256`,
    limit: MAX_SIDECAR_BYTES,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    timeoutLabel: `Downloading the ${offer.pluginName} ${offer.version} checksum`,
    assetLabel: "plugin checksum",
    boundedLabel: `The ${offer.pluginName} ${offer.version} checksum`,
    failureLabel: `Downloading the ${offer.pluginName} ${offer.version} checksum`,
    redirectLabel: `Downloading the ${offer.pluginName} checksum`
  });

  const text = new TextDecoder().decode(bytes);
  // shasum output is `<hex>  <name>`; `shasum -b` marks binary with `*`, and publishers on Windows
  // produce uppercase digests.
  const match = /^([0-9a-fA-F]{64})(?:\s|$)/.exec(text.trim());
  if (!match) {
    throw new Error(
      `The published ${offer.pluginName} ${offer.version} checksum file is not in shasum format.`
    );
  }
  if (match[1].toLowerCase() !== offer.sourceChecksum.toLowerCase()) {
    throw new Error(
      `The published ${offer.pluginName} ${offer.version} checksum does not match the digest recorded ` +
        "for the release asset. Refusing the replacement."
    );
  }
  return text;
}

async function readBoundedResponseBytes(
  response: Response,
  limit: number,
  label: string
): Promise<Uint8Array> {
  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (declaredBytes !== undefined && declaredBytes > limit) {
    await cancelResponseBody(response);
    throw new Error(`${label} declares ${declaredBytes} bytes, exceeding ChemDraft's ${limit}-byte limit.`);
  }
  if (!response.body) {
    throw new Error(`${label} returned no response body.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The limit violation remains authoritative; cancellation is best-effort cleanup.
        }
        throw new Error(`${label} exceeded ChemDraft's ${limit}-byte limit while downloading.`);
      }
      chunks.push(value);
    }
  } catch (cause: unknown) {
    try {
      await reader.cancel();
    } catch {
      // The original read/limit failure is the useful error.
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function trustedGitHubAssetRedirect(location: string): string {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new Error("The plugin package redirect is not a valid absolute URL.");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== GITHUB_RELEASE_ASSET_HOST ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    !target.pathname.startsWith(GITHUB_RELEASE_ASSET_PATH_PREFIX)
  ) {
    throw new Error("The plugin package redirect did not target GitHub's trusted release-asset host.");
  }
  return target.toString();
}

async function assertResponseStayedAt(
  response: Response,
  expectedUrl: string,
  label: string
): Promise<void> {
  // Browser Response fixtures have an empty URL; Tauri's native fetch always reports the effective URL.
  if (response.url !== "" && response.url !== expectedUrl) {
    await cancelResponseBody(response);
    throw new Error(`The ${label} request followed an unexpected redirect.`);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The validation error remains authoritative; cancellation is best-effort resource cleanup.
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The plugin ${label} response is not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The plugin ${label} is missing or invalid.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The plugin ${label} is missing or invalid.`);
  }
  return value;
}

function requiredIsoDate(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`The plugin ${label} is not an ISO date.`);
  }
  return text;
}

function parseAssetDigest(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("The plugin release asset has no SHA-256 digest.");
  }
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (!match) {
    throw new Error("The plugin release asset does not carry a valid SHA-256 digest.");
  }
  return match[1];
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
