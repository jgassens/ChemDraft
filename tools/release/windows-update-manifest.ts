/**
 * Write `latest.json`, the Windows update feed, from a signed release installer.
 *
 * The Windows counterpart of Sparkle's `generate_appcast` (docs/releasing/windows-updates.md): the
 * installed app fetches this file from `main`, compares `version` with its own, and — if newer —
 * downloads `url` and verifies it against `signature` with the public key built into the app.
 *
 *   pnpm release:windows-manifest --version 0.3.6 \
 *     --installer "apps/desktop/src-tauri/target/release/bundle/nsis/ChemDraft_0.3.6_x64-setup.exe" \
 *     [--notes notes.md] [--out latest.json]
 *
 * `--installer` must have the `.sig` file the stable build wrote beside it (createUpdaterArtifacts).
 * The URL points at the GitHub release `v<version>`, so upload that exact file there before
 * committing the manifest to main — an app that sees the manifest first would fail its download.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_DOWNLOAD_BASE = "https://github.com/jgassens/ChemDraft/releases/download";
/** The platform key tauri-plugin-updater looks up first for an NSIS build (`{os}-{arch}-{installer}`). */
export const WINDOWS_PLATFORM_KEY = "windows-x86_64-nsis";

export interface UpdateManifest {
  version: string;
  notes?: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function buildWindowsUpdateManifest(input: {
  version: string;
  installerFileName: string;
  signature: string;
  notes?: string;
  publishedAt: Date;
}): UpdateManifest {
  const { version, installerFileName, notes, publishedAt } = input;
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a version like 0.3.6 (no leading "v").`);
  }
  if (!installerFileName.includes(`_${version}_`)) {
    // Stops publishing last release's installer under a new version number.
    throw new Error(`Installer "${installerFileName}" is not the ${version} build.`);
  }
  if (/\(dev\)/i.test(installerFileName)) {
    throw new Error(
      `"${installerFileName}" is a branch build. Build the release with CHEMDRAFT_STABLE_BUILD=1 so it installs as ChemDraft.`
    );
  }
  const signature = input.signature.trim();
  if (!signature) {
    throw new Error("The installer's .sig file is empty.");
  }
  const trimmedNotes = notes?.trim();
  return {
    version,
    ...(trimmedNotes ? { notes: trimmedNotes } : {}),
    pub_date: publishedAt.toISOString(),
    platforms: {
      [WINDOWS_PLATFORM_KEY]: {
        signature,
        url: `${RELEASE_DOWNLOAD_BASE}/v${version}/${encodeURIComponent(installerFileName)}`
      }
    }
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(args: readonly string[]): void {
  const version = option(args, "version");
  const installer = option(args, "installer");
  if (!version || !installer) {
    throw new Error("Usage: --version <x.y.z> --installer <path to setup.exe> [--notes <file>] [--out <latest.json>]");
  }
  const installerPath = resolve(installer);
  const signaturePath = `${installerPath}.sig`;
  if (!existsSync(installerPath)) {
    throw new Error(`No installer at ${installerPath}.`);
  }
  if (!existsSync(signaturePath)) {
    throw new Error(
      `No signature at ${signaturePath}. Build with the updater key available (see docs/releasing/windows-updates.md).`
    );
  }
  const notesPath = option(args, "notes");
  const manifest = buildWindowsUpdateManifest({
    version,
    installerFileName: basename(installerPath),
    signature: readFileSync(signaturePath, "utf8"),
    notes: notesPath ? readFileSync(resolve(notesPath), "utf8") : undefined,
    publishedAt: new Date()
  });
  const out = resolve(option(args, "out") ?? "latest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${out}: ChemDraft ${version} → ${manifest.platforms[WINDOWS_PLATFORM_KEY].url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`windows-update-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
