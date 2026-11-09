// Intel macOS build prerequisite. Only the checksum-verified archive is cached; each build extracts
// a fresh JDK outside the checkout and removes it afterwards. No JDK is redistributed with the app.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as filesystem } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const release = "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8";
const archive = "OpenJDK25U-jdk_x64_mac_hotspot_25.0.5_8.tar.gz";
export const INTEL_MAC_JDK = Object.freeze({
  version: "25.0.5+8",
  archive,
  url: `${release}/${archive}`,
  // From the published .sha256.txt below. The checksum file itself has SHA-256
  // 238959cdf4bc17f788a3c69bb353012a88a83b794d75a7e14fc89522e8cace36 in GitHub's release metadata.
  checksumUrl: `${release}/${archive}.sha256.txt`,
  sha256: "32cd4d2151c91aa00d0fc911edfd05245ed40fa6b1aa894d5f35c928cd67a59d"
});

export function verifyJdkChecksum(bytes, pin = INTEL_MAC_JDK) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== pin.sha256) {
    throw new Error(`OPSIN JDK SHA-256 mismatch for ${pin.archive}: expected ${pin.sha256}, got ${actual}; refusing extraction. Remove the cached archive and retry.`);
  }
}

export async function acquireIntelMacJdk({
  cacheDir = join(homedir(), "Library", "Caches", "ChemDraft", "opsin-jdk"),
  fs = filesystem, fetchImpl = globalThis.fetch, run = spawnSync, pin = INTEL_MAC_JDK,
  log = console.log
} = {}) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const temp = await fs.mkdtemp(join(cacheDir, ".extract-"));
  const cleanup = () => fs.rm(temp, { recursive: true, force: true });
  try {
    const cached = join(cacheDir, pin.archive);
    let bytes;
    try { bytes = await fs.readFile(cached); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (bytes === undefined) {
      log(`Downloading Eclipse Temurin ${pin.version} x64 macOS JDK: ${pin.url}`);
      const response = await fetchImpl(pin.url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`OPSIN JDK download failed: HTTP ${response.status} (${pin.url})`);
      bytes = Buffer.from(await response.arrayBuffer());
      verifyJdkChecksum(bytes, pin);
      const partial = join(temp, pin.archive);
      await fs.writeFile(partial, bytes, { mode: 0o600 });
      await fs.rename(partial, cached);
    } else {
      // Never trust an old cache entry without checking its bytes against the source pin again.
      verifyJdkChecksum(bytes, pin);
    }
    log(`Using verified OPSIN JDK archive: ${cached}`);
    const extraction = run("/usr/bin/tar", ["-xzf", cached, "-C", temp], { encoding: "utf8" });
    if (extraction.status !== 0) throw new Error(`OPSIN JDK extraction failed: ${extraction.error?.message ?? extraction.stderr ?? extraction.status}`);
    return { javaHome: join(temp, `jdk-${pin.version}`, "Contents", "Home"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
