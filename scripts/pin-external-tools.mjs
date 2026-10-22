import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pinsPath = join(repoRoot, "apps", "desktop", "src-tauri", "src", "external_tools", "pins.rs");
const claudeBase = "https://downloads.claude.ai/claude-code-releases";

export function singleArchiveEntryName(kind, bytes) {
  if (kind === "tar.gz") {
    const tar = gunzipSync(bytes);
    const names = [];
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      // GNU's old header stores timestamps here; only POSIX ustar has a prefix field.
      const prefix = header.subarray(257, 263).equals(Buffer.from("ustar\0"))
        ? header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "") : "";
      const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tar entry size.");
      if (header[156] !== 53) names.push(prefix ? `${prefix}/${name}` : name);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (names.length !== 1) throw new Error(`Expected one archive entry; found ${names.length}.`);
    return names[0];
  }
  if (kind === "zip") {
    const names = zipArchiveEntryNames(bytes);
    if (names.length !== 1) throw new Error(`Expected one archive entry; found ${names.length}.`);
    return names[0];
  }
  throw new Error(`Unsupported archive type: ${kind}`);
}

export function zipArchiveEntryNames(bytes) {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP has no end of central directory.");
  const safeNumber = (value) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP64 value is too large.");
    return Number(value);
  };
  let count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff || bytes.readUInt32LE(eocd + 12) === 0xffffffff) {
    if (eocd < 20 || bytes.readUInt32LE(eocd - 20) !== 0x07064b50) throw new Error("ZIP64 locator is missing.");
    const zip64 = safeNumber(bytes.readBigUInt64LE(eocd - 12));
    if (zip64 + 56 > bytes.length || bytes.readUInt32LE(zip64) !== 0x06064b50) throw new Error("ZIP64 directory is invalid.");
    count = safeNumber(bytes.readBigUInt64LE(zip64 + 32));
    offset = safeNumber(bytes.readBigUInt64LE(zip64 + 48));
  }
  const names = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP central directory is invalid.");
    const end = offset + 46 + bytes.readUInt16LE(offset + 28);
    const next = end + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > eocd) throw new Error("ZIP central directory is truncated.");
    names.push(bytes.subarray(offset + 46, end).toString("utf8"));
    offset = next;
  }
  return names;
}

export function validateArchiveEntry(archive, bytes, entry) {
  if (archive === "ZipTree") {
    if (!zipArchiveEntryNames(bytes).includes(entry)) throw new Error(`ZIP tree is missing ${entry}.`);
  } else if (singleArchiveEntryName(archive === "TarGz" ? "tar.gz" : "zip", bytes) !== entry) {
    throw new Error("Unexpected archive entry.");
  }
}

export function formatToolPin(pin) {
  return `    ToolPin {\n        tool: ToolId::${pin.tool},\n        platform: ToolPlatform::${pin.platform},\n        version: ${pin.version},\n        url: "${pin.url}",\n        size: ${pin.size},\n        sha256: "${pin.sha256}",\n        archive: ArchiveKind::${pin.archive},\n        entry: "${pin.entry}",\n        binary: "${pin.binary}",\n    },`;
}

export function renderPins({ claudeVersion, codexTag, codexVersion, pins }) {
  return [
    `pub const CLAUDE_VERSION: &str = "${claudeVersion}";`,
    `pub const CODEX_TAG: &str = "${codexTag}";`,
    `pub const CODEX_VERSION: &str = "${codexVersion}";`,
    "pub const PINS: [ToolPin; 6] = [",
    ...pins.map(formatToolPin),
    "];"
  ].join("\n");
}

export function pinDiff(existing, rendered) {
  const current = existing.match(/pub const CLAUDE_VERSION:[\s\S]*?^\];$/m)?.[0] ?? "";
  return current === rendered ? "" : "Published external-tool pins differ from pins.rs.";
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ChemDraft pin refresh" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function fetchGitHubJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ChemDraft pin refresh" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export function parseClaudeLatestVersion(text) {
  const version = text.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Claude latest version.");
  return version;
}

async function fetchClaudeLatestVersion(url) {
  const response = await fetch(url, { headers: { Accept: "text/plain", "User-Agent": "ChemDraft pin refresh" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseClaudeLatestVersion(await response.text());
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "ChemDraft pin refresh" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

function claudeManifestEntry(manifest, platform) {
  const entry = manifest.platforms?.[platform];
  if (!entry || !Number.isSafeInteger(entry.size) || typeof entry.checksum !== "string") {
    throw new Error(`Claude manifest has no valid ${platform} size/checksum.`);
  }
  return entry;
}

async function buildPins() {
  const claudeVersion = await fetchClaudeLatestVersion(`${claudeBase}/latest`);
  const manifest = await fetchJson(`${claudeBase}/${claudeVersion}/manifest.json`);
  const claude = [
    ["darwin-arm64", "DarwinArm64", "claude", "claude"],
    ["darwin-x64", "DarwinX64", "claude", "claude"],
    ["win32-x64", "WindowsX64", "claude.exe", "claude.exe"]
  ].map(([platform, rustPlatform, entry, binary]) => {
    const published = claudeManifestEntry(manifest, platform);
    return { tool: "Claude", platform: rustPlatform, version: "CLAUDE_VERSION", url: `${claudeBase}/${claudeVersion}/${platform}/${entry}`, size: published.size, sha256: published.checksum, archive: "Raw", entry, binary };
  });

  const release = await fetchGitHubJson("https://api.github.com/repos/openai/codex/releases/latest");
  const codexTag = release.tag_name;
  const codexVersion = codexTag?.replace(/^rust-v/, "");
  if (typeof codexTag !== "string" || !/^rust-v\d+\.\d+\.\d+$/.test(codexTag) || !codexVersion) throw new Error("Invalid Codex release tag.");
  const temp = await mkdtemp(join(tmpdir(), "chemdraft-external-tools-"));
  try {
    const assets = [
      ["codex-aarch64-apple-darwin.tar.gz", "DarwinArm64", "TarGz", "codex-aarch64-apple-darwin", "codex"],
      ["codex-x86_64-apple-darwin.tar.gz", "DarwinX64", "TarGz", "codex-x86_64-apple-darwin", "codex"],
      ["codex-x86_64-pc-windows-msvc.exe.zip", "WindowsX64", "ZipTree", "codex-x86_64-pc-windows-msvc.exe", "codex-x86_64-pc-windows-msvc.exe"]
    ];
    const codex = [];
    for (const [name, platform, archive, entry, binary] of assets) {
      const asset = release.assets?.find((candidate) => candidate.name === name);
      if (!asset?.browser_download_url) throw new Error(`Codex release is missing ${name}.`);
      const downloaded = await download(asset.browser_download_url, join(temp, name));
      validateArchiveEntry(archive, downloaded.bytes, entry);
      codex.push({ tool: "Codex", platform, version: "CODEX_VERSION", url: asset.browser_download_url, size: downloaded.size, sha256: downloaded.sha256, archive, entry, binary });
    }
    return { claudeVersion, codexTag, codexVersion, pins: [...claude, ...codex] };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  const generated = renderPins(await buildPins());
  if (process.argv.includes("--check")) {
    const difference = pinDiff(await readFile(pinsPath, "utf8"), generated);
    if (difference) {
      console.error(difference);
      process.exitCode = 1;
    }
    return;
  }
  console.log(generated);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
