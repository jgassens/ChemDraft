import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest, BUILD_TARGETS } from "./record-build.mjs";

export const version = "1.2.3";
export const commit = "a".repeat(40);
export const arm = `ChemDraft_${version}_aarch64.dmg`;
export const intel = `ChemDraft_${version}_x86_64.dmg`;
export const installer = `ChemDraft_${version}_x64-setup.exe`;

// Private keys exist only in memory for this test process.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyId = randomBytes(8);
const keyPacket = Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
export const updaterPublicKey = Buffer.from(`untrusted comment: ephemeral test key\n${keyPacket.toString("base64")}\n`).toString("base64");
export const windowsPlatformKey = "windows-x86_64-nsis";
export const installerUrl = `https://github.com/jgassens/ChemDraft/releases/download/v${version}/${installer}`;

export function updaterSignature(bytes) {
  const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
  const comment = `timestamp:1792540800\tfile:${installer}`;
  const packet = Buffer.concat([Buffer.from("ED"), keyId, signature]);
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  return Buffer.from(`untrusted comment: ephemeral test signature\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
}

export function releaseFixture(t) {
  const rootDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".release-test-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const assets = join(rootDir, "assets");
  mkdirSync(assets);
  for (const [target, suffix] of Object.entries(BUILD_TARGETS)) {
    const file = join(assets, `ChemDraft_${version}_${suffix}`);
    writeFileSync(file, `synthetic ${target}`);
    writeFileSync(`${file}.build.json`, JSON.stringify({ commit, version, target, clean: true, ...artifactDigest(file) }));
  }
  const signature = updaterSignature(readFileSync(join(assets, installer)));
  writeFileSync(join(assets, `${installer}.sig`), `${signature}\n`);
  writeFileSync(join(assets, "latest.json"), JSON.stringify({
    version, platforms: { [windowsPlatformKey]: { url: installerUrl, signature } }
  }));
  return { rootDir, assets, version };
}

export function fakeReleaseRunner({ taggedCommit = commit, embeddedCommit = commit, unsigned = false, calls = [], downloadFrom } = {}) {
  return (command, args, options) => {
    calls.push({ command, args });
    assert.equal(options.encoding, "utf8");
    if (command === "git") {
      assert.ok([
        ["fetch", "origin", "tag", `v${version}`, "--no-tags"],
        ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]
      ].some((expected) => JSON.stringify(args) === JSON.stringify(expected)), `Unexpected git arguments: ${args}`);
      return { status: 0, stdout: args[0] === "fetch" ? "" : `${taggedCommit}\n` };
    }
    if (command === "gh") {
      assert.deepEqual(args.slice(0, 3), ["release", "download", `v${version}`]);
      assert.equal(args[3], "--dir");
      for (const name of readdirSync(downloadFrom)) copyFileSync(join(downloadFrom, name), join(args[4], name));
      return { status: 0 };
    }
    if (command === "/usr/bin/hdiutil") {
      if (args[0] === "attach") {
        assert.deepEqual(args.slice(0, 4), ["attach", "-readonly", "-nobrowse", "-mountpoint"]);
        assert.equal(args.length, 6);
        const app = join(args[4], "ChemDraft.app", "Contents");
        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, "Info.plist"), JSON.stringify({
          ChemDraftSourceCommit: typeof embeddedCommit === "function" ? embeddedCommit(args[5]) : embeddedCommit,
          ...((typeof unsigned === "function" ? unsigned(args[5]) : unsigned) ? { ChemDraftUnsignedBuild: true } : {})
        }));
      } else assert.deepEqual(args, ["detach", args[1]]);
      return { status: 0 };
    }
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args.slice(0, 5), ["-convert", "json", "-o", "-", args[4]]);
      assert.equal(args.length, 5);
      return { status: 0, stdout: readFileSync(args[4], "utf8") };
    }
    assert.fail(`Unexpected native command: ${command} ${args.join(" ")}`);
  };
}
