import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pinsPath = join(repoRoot, "apps", "desktop", "src-tauri", "src", "external_tools", "pins.rs");
const claudeBase = "https://downloads.claude.ai/claude-code-releases";

function tarArchiveEntries(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 });
  const entries = [];
  let count = 0, ended = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const tail = tar.subarray(offset);
      if (tail.length > 1024 * 1024 || !tail.every((b) => b === 0)) throw new Error("Invalid tar end padding.");
      ended = true;
      break;
    }
    if (++count > 10_000) throw new Error("Too many tar entries.");
    const checksum = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error("Invalid tar header checksum.");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    // GNU's old header stores timestamps here; only POSIX ustar has a prefix field.
    const prefix = header.subarray(257, 263).equals(Buffer.from("ustar\0"))
      ? header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "") : "";
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024 || offset + 512 + size > tar.length) throw new Error("Invalid tar entry size.");
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^(\.\/)+/, "").replace(/\/$/, "");
    if (!path || /[\\:\x00-\x1f]/.test(path) || path.split("/").some((part) => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe tar path.");
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (header[156] === 120) validatePaxTimestamps(content);
    else {
      if (![0, 48, 53].includes(header[156]) || (header[156] === 53 && size !== 0)) throw new Error("Tar links and special entries are forbidden.");
      if (header[156] !== 53) entries.push({ name: path, type: header[156], content });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error("Missing tar end marker.");
  return entries;
}

export function validatePaxTimestamps(bytes) {
  if (bytes.length > 64 * 1024) throw new Error("PAX metadata exceeds size limit.");
  while (bytes.length) {
    const space = bytes.indexOf(32);
    const length = Number(bytes.subarray(0, space).toString("ascii"));
    if (space < 1 || !Number.isSafeInteger(length) || length <= space + 1 || length > bytes.length || bytes[length - 1] !== 10) throw new Error("Malformed PAX metadata.");
    if (!/^(mtime|atime|ctime)=[0-9.-]+$/.test(bytes.subarray(space + 1, length - 1).toString("utf8"))) throw new Error("Unsupported PAX metadata override.");
    bytes = bytes.subarray(length);
  }
}

export function singleArchiveEntryName(kind, bytes) {
  const names = kind === "tar.gz" ? tarArchiveEntries(bytes).map((entry) => entry.name)
    : kind === "zip" ? zipArchiveEntryNames(bytes) : null;
  if (!names) throw new Error(`Unsupported archive type: ${kind}`);
  if (names.length !== 1) throw new Error(`Expected one archive entry; found ${names.length}.`);
  return names[0];
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
  if (archive === "TarGz" && entry.startsWith("bin/")) {
    codexPackageEntries(bytes, entry);
  } else if (archive === "ZipTree") {
    if (!zipArchiveEntryNames(bytes).includes(entry)) throw new Error(`ZIP tree is missing ${entry}.`);
  } else if (singleArchiveEntryName(archive === "TarGz" ? "tar.gz" : "zip", bytes) !== entry) {
    throw new Error("Unexpected archive entry.");
  }
}

export function codexPackageEntries(bytes, entry) {
  if (!["bin/codex", "bin/codex.exe"].includes(entry)) throw new Error("Invalid Codex entrypoint.");
  const suffix = entry.endsWith(".exe") ? ".exe" : "";
  const wanted = [entry, `bin/codex-code-mode-host${suffix}`];
  const all = tarArchiveEntries(bytes);
  return wanted.map((name) => {
    const matches = all.filter((candidate) => candidate.name === name);
    if (matches.length !== 1 || matches[0].content.length === 0) throw new Error(`Codex package requires exactly one nonempty ${name}.`);
    return matches[0];
  });
}

export function parseCodexChecksums(text) {
  const checksums = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (\S+)$/.exec(line);
    if (!match || checksums.has(match[2])) throw new Error("Invalid or duplicate codex-package_SHA256SUMS row.");
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

export function verifyCodexPackage(asset, downloaded, checksums) {
  const expected = checksums.get(asset.name);
  if (!expected || downloaded.sha256 !== expected || downloaded.size !== asset.size || (asset.digest && asset.digest !== `sha256:${expected}`)) {
    throw new Error(`${asset.name}: download does not match published size and codex-package_SHA256SUMS.`);
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
    `pub const PINS: [ToolPin; ${pins.length}] = [`,
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

export function parsePinnedVersions(source) {
  const constant = (name, pattern) => {
    const declarations = source.match(new RegExp(`^pub const ${name}:[^\\r\\n]*$`, "gm")) ?? [];
    const match = declarations.length === 1
      ? new RegExp(`^pub const ${name}: &str = "([^"]+)";$`).exec(declarations[0]) : null;
    if (!match || !pattern.test(match[1])) throw new Error(`Invalid or duplicate pinned ${name}.`);
    return match[1];
  };
  const claudeVersion = constant("CLAUDE_VERSION", /^\d+\.\d+\.\d+$/);
  const codexTag = constant("CODEX_TAG", /^rust-v\d+\.\d+\.\d+$/);
  const codexVersion = constant("CODEX_VERSION", /^\d+\.\d+\.\d+$/);
  if (codexTag !== `rust-v${codexVersion}`) throw new Error("Pinned CODEX_TAG and CODEX_VERSION disagree.");
  return { claudeVersion, codexTag, codexVersion };
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
  if (!entry || !Number.isSafeInteger(entry.size) || entry.size <= 0 || typeof entry.checksum !== "string" || !/^[a-f0-9]{64}$/.test(entry.checksum)) {
    throw new Error(`Claude manifest has no valid ${platform} size/checksum.`);
  }
  return entry;
}

async function buildPins(temp, pinnedVersions) {
  const claudeVersion = pinnedVersions?.claudeVersion ?? await fetchClaudeLatestVersion(`${claudeBase}/latest`);
  const manifest = await fetchJson(`${claudeBase}/${claudeVersion}/manifest.json`);
  const claude = [
    ["darwin-arm64", "DarwinArm64", "claude", "claude"],
    ["darwin-x64", "DarwinX64", "claude", "claude"],
    ["win32-x64", "WindowsX64", "claude.exe", "claude.exe"],
    ["linux-x64", "LinuxX64", "claude", "claude"],
    ["linux-arm64", "LinuxArm64", "claude", "claude"]
  ].map(([platform, rustPlatform, entry, binary]) => {
    const published = claudeManifestEntry(manifest, platform);
    return { tool: "Claude", platform: rustPlatform, version: "CLAUDE_VERSION", url: `${claudeBase}/${claudeVersion}/${platform}/${entry}`, size: published.size, sha256: published.checksum, archive: "Raw", entry, binary };
  });
  if (pinnedVersions) {
    // Verify every committed raw executable too, rather than checking only the manifest and host.
    for (const pin of claude) {
      const path = join(temp, `Claude-${pin.platform}.download`);
      const downloaded = await download(pin.url, path);
      if (downloaded.size !== pin.size || downloaded.sha256 !== pin.sha256) throw new Error(`Claude ${pin.platform}: download does not match the versioned manifest.`);
      pin.downloadedPath = path;
    }
  }

  const releaseUrl = pinnedVersions
    ? `https://api.github.com/repos/openai/codex/releases/tags/${encodeURIComponent(pinnedVersions.codexTag)}`
    : "https://api.github.com/repos/openai/codex/releases/latest";
  const release = await fetchGitHubJson(releaseUrl);
  const codexTag = release.tag_name;
  const codexVersion = codexTag?.replace(/^rust-v/, "");
  if (typeof codexTag !== "string" || !/^rust-v\d+\.\d+\.\d+$/.test(codexTag) || !codexVersion) throw new Error("Invalid Codex release tag.");
  if (pinnedVersions && codexTag !== pinnedVersions.codexTag) throw new Error("Codex release does not match the committed tag.");
  const assets = [
    ["codex-package-aarch64-apple-darwin.tar.gz", "DarwinArm64", "TarGz", "bin/codex", "codex"],
    ["codex-package-x86_64-apple-darwin.tar.gz", "DarwinX64", "TarGz", "bin/codex", "codex"],
    ["codex-package-x86_64-pc-windows-msvc.tar.gz", "WindowsX64", "TarGz", "bin/codex.exe", "codex.exe"],
    ["codex-package-x86_64-unknown-linux-musl.tar.gz", "LinuxX64", "TarGz", "bin/codex", "codex"],
    ["codex-package-aarch64-unknown-linux-musl.tar.gz", "LinuxArm64", "TarGz", "bin/codex", "codex"]
  ];
  const sumsAsset = release.assets?.find((asset) => asset.name === "codex-package_SHA256SUMS");
  if (!sumsAsset?.browser_download_url) throw new Error("Codex release has no codex-package_SHA256SUMS.");
  const sumsDownload = await download(sumsAsset.browser_download_url, join(temp, sumsAsset.name));
  if (sumsDownload.size !== sumsAsset.size || (sumsAsset.digest && sumsAsset.digest !== `sha256:${sumsDownload.sha256}`)) throw new Error("Published checksum asset does not match release metadata.");
  const checksums = parseCodexChecksums(sumsDownload.bytes.toString("utf8"));
  const codex = [];
  for (const [name, platform, archive, entry, binary] of assets) {
    const asset = release.assets?.find((candidate) => candidate.name === name);
    if (!asset?.browser_download_url) throw new Error(`Codex release is missing ${name}.`);
    const downloaded = await download(asset.browser_download_url, join(temp, name));
    verifyCodexPackage(asset, downloaded, checksums);
    validateArchiveEntry(archive, downloaded.bytes, entry);
    codex.push({ tool: "Codex", platform, version: "CODEX_VERSION", url: asset.browser_download_url, size: downloaded.size, sha256: downloaded.sha256, archive, entry, binary, downloadedPath: join(temp, name) });
  }
  return { claudeVersion, codexTag, codexVersion, pins: [...claude, ...codex] };
}

export function hostToolPins(pins, platform = process.platform, arch = process.arch) {
  const host = { "darwin-arm64": "DarwinArm64", "darwin-x64": "DarwinX64", "win32-x64": "WindowsX64", "linux-x64": "LinuxX64", "linux-arm64": "LinuxArm64" }[`${platform}-${arch}`];
  return pins.filter((pin) => host !== undefined && pin.platform === host);
}

export function parityPlatformMessage(platform = process.platform, arch = process.arch, mode = "--check") {
  const checkedPlatform = { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform] ?? null;
  const notChecked = ["macOS", "Windows", "Linux"].filter((name) => name !== checkedPlatform).join(" and ");
  const host = checkedPlatform ? `${checkedPlatform} (${platform}-${arch})` : `${platform}-${arch} (no supported desktop platform)`;
  const rerun = notChecked;
  const hosts = rerun.includes(" and ") ? `${rerun} hosts` : `a ${rerun} host`;
  return `Pinned CLI parity checked on host ${host}; NOT checked on ${notChecked}. Run ${mode} on ${hosts} too.`;
}

// Use argv and an explicit environment, never a shell string (Windows paths can contain spaces).
export function parityCommand(binaries, parentEnv = process.env) {
  const env = Object.fromEntries(Object.entries(parentEnv).filter(([key]) => !/^CHEMDRAFT_PINNED_(CODEX|CLAUDE)$/i.test(key)));
  for (const [tool, binary] of Object.entries(binaries)) env[`CHEMDRAFT_PINNED_${tool.toUpperCase()}`] = binary;
  return {
    command: "cargo",
    // Restrict the opt-in run to CLI-contract fixtures, excluding archive installer tests.
    args: ["test", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "external_tools::tests::pinned_", "--", "--include-ignored", "--nocapture"],
    options: { cwd: repoRoot, env, stdio: "inherit", shell: false }
  };
}

export async function prepareHostBinary(pin, temp) {
  const destination = join(temp, `${pin.tool}-${pin.platform}`);
  await mkdir(destination);
  const downloaded = pin.downloadedPath
    ? { bytes: await readFile(pin.downloadedPath) }
    : await download(pin.url, join(temp, `${pin.tool}.download`));
  const bytes = downloaded.bytes;
  if (bytes.length !== pin.size || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
    throw new Error(`${pin.tool}: downloaded host binary does not match pinned size/SHA-256.`);
  }
  if (pin.archive === "Raw") {
    await writeFile(join(destination, pin.binary), bytes);
  } else {
    validateArchiveEntry(pin.archive, bytes, pin.entry);
    let files;
    if (pin.archive === "TarGz" && pin.tool === "Codex") {
      files = Object.fromEntries(codexPackageEntries(bytes, pin.entry).map((entry) => [entry.name.slice(4), entry.content]));
    } else if (pin.archive === "TarGz") {
      // Reuse the inspected entry, skipping directory headers and refusing symlinks.
      const [entry] = tarArchiveEntries(bytes);
      if (entry.type !== 0 && entry.type !== 48) throw new Error("Expected a regular executable tar entry.");
      files = { [pin.binary]: entry.content };
    } else {
      throw new Error("Host parity supports raw binaries and tar.gz packages only.");
    }
    for (const [name, content] of Object.entries(files)) {
      if (/^[\\/]/.test(name) || name.includes(":") || name.split(/[\\/]/).some((part) => part === "..")) {
        throw new Error(`Unsafe archive path: ${name}`);
      }
      const path = join(destination, name);
      if (name.endsWith("/")) await mkdir(path, { recursive: true });
      else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        await chmod(path, 0o755);
      }
    }
  }
  const binary = join(destination, pin.binary);
  await chmod(binary, 0o755);
  return binary;
}

async function checkParity(pins, temp, mode) {
  console.log(parityPlatformMessage(process.platform, process.arch, mode));
  const selected = hostToolPins(pins);
  const binaries = {};
  for (const tool of ["Codex", "Claude"]) {
    const pin = selected.find((candidate) => candidate.tool === tool);
    if (!pin) {
      console.log(`Skipping ${tool} parity: no pinned host binary for ${process.platform}-${process.arch}.`);
      continue;
    }
    binaries[tool] = await prepareHostBinary(pin, temp);
  }
  if (!Object.keys(binaries).length) return;
  const { command, args, options } = parityCommand(binaries);
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pinned CLI parity failed (${result.signal ?? result.status}).`);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/pin-external-tools.mjs [--check | --check-pinned]\nWithout flags: print pins for vendor latest versions.\n--check: compare against vendor latest and run host CLI parity.\n--check-pinned: verify all committed versioned downloads, compare pins and run host CLI parity; never upgrade versions.");
    return;
  }
  const checkPinned = process.argv.includes("--check-pinned");
  const checkLatest = process.argv.includes("--check");
  if (checkPinned && checkLatest) throw new Error("Choose --check or --check-pinned, not both.");
  const existing = checkPinned || checkLatest ? await readFile(pinsPath, "utf8") : undefined;
  const pinnedVersions = checkPinned ? parsePinnedVersions(existing) : undefined;
  if (pinnedVersions) console.log(`Checking committed Claude ${pinnedVersions.claudeVersion} and Codex ${pinnedVersions.codexTag}; verifying every platform download before host CLI parity.`);
  const temp = await mkdtemp(join(tmpdir(), "chemdraft-external-tools-"));
  try {
    const built = await buildPins(temp, pinnedVersions);
    const generated = renderPins(built);
    if (checkPinned || checkLatest) {
      const difference = pinDiff(existing, generated);
      if (difference) throw new Error(difference);
      await checkParity(built.pins, temp, checkPinned ? "--check-pinned" : "--check");
    } else {
      console.log(generated);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function selfTest() {
  validatePaxTimestamps(Buffer.from("22 mtime=1792097863.0\n"));
  assert.throws(() => validatePaxTimestamps(Buffer.from("18 path=../escape\n")), /override/);
  assert.throws(() => validatePaxTimestamps(Buffer.from("999 mtime=1\n")));
  const digest = "a".repeat(64);
  const sums = parseCodexChecksums(`${digest}  package.tar.gz\n`);
  const asset = { name: "package.tar.gz", size: 42, digest: `sha256:${digest}` };
  verifyCodexPackage(asset, { size: 42, sha256: digest }, sums);
  assert.throws(() => parseCodexChecksums(`${digest}  a\n${digest}  a`));
  assert.throws(() => parseCodexChecksums("invalid"));
  for (const downloaded of [{ size: 41, sha256: digest }, { size: 42, sha256: "b".repeat(64) }]) assert.throws(() => verifyCodexPackage(asset, downloaded, sums));
  assert.throws(() => verifyCodexPackage(asset, { size: 42, sha256: digest }, new Map()));
  const tar = (names) => gzipSync(Buffer.concat([...names.flatMap((name) => {
    const header = Buffer.alloc(512);
    header.write(name); header.write("00000000001\0", 124); header[156] = 48;
    header.fill(32, 148, 156);
    header.write(`${header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    return [header, Buffer.from("x"), Buffer.alloc(511)];
  }), Buffer.alloc(1024)]));
  for (const suffix of ["", ".exe"]) {
    const names = [`bin/codex${suffix}`, `bin/codex-code-mode-host${suffix}`];
    const bytes = tar([...names, "codex-package.json", "codex-path/rg", "codex-resources/voice/unused"]);
    assert.deepEqual(codexPackageEntries(bytes, names[0]).map((e) => e.name), names);
    assert.throws(() => codexPackageEntries(tar(names.slice(0, 1)), names[0]));
    assert.throws(() => codexPackageEntries(tar([...names, names[1]]), names[0]));
    for (const unsafe of ["../escape", "/absolute", "C:/drive", "bin/../codex"]) assert.throws(() => codexPackageEntries(tar([...names, unsafe]), names[0]));
  }
  console.log("Codex package pin self-tests passed (offline).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
