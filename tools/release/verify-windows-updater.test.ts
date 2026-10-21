import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyUpdaterSignature } from "./verify-windows-updater";

// Ephemeral test keys only. No project private key is read, stored, or needed.
function signed(algorithm = "ED") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const installer = Buffer.from("final Authenticode-signed installer bytes");
  const message = algorithm === "ED" ? createHash("blake2b512").update(installer).digest() : installer;
  const signature = sign(null, message, privateKey);
  const comment = "timestamp:1792540800\tfile:ChemDraft_1.0.0_x64-setup.exe";
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString("base64");
  const packet = Buffer.concat([Buffer.from(algorithm), id, signature]).toString("base64");
  const key = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
  const pubkey = Buffer.from(`untrusted comment: test key\n${key.toString("base64")}\n`).toString("base64");
  const encode = (text: string) => Buffer.from(text).toString("base64");
  const raw = `untrusted comment: test signature\n${packet}\ntrusted comment: ${comment}\n${global}\n`;
  return { installer, pubkey, sig: encode(raw), raw, encode };
}

describe("Windows updater verification", () => {
  it("accepts an actual Tauri CLI signature with an ephemeral test key", () => {
    const root = mkdtempSync(join(tmpdir(), "chemdraft-updater-verify-"));
    const cli = fileURLToPath(new URL("../../apps/desktop/node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
    const key = join(root, "test.key");
    const installer = join(root, "test.exe");
    try {
      // Capture all CLI output: even generated test keys must not appear in test logs.
      const generated = spawnSync(process.execPath, [cli, "signer", "generate", "--ci", "--password", "", "--write-keys", key]);
      expect(generated.status).toBe(0);
      writeFileSync(installer, "final installer test bytes");
      const signed = spawnSync(process.execPath, [cli, "signer", "sign", "--password", "", installer], {
        env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8").trim() }
      });
      expect(signed.status).toBe(0);
      expect(() => verifyUpdaterSignature(readFileSync(installer), readFileSync(`${installer}.sig`, "utf8"),
        readFileSync(`${key}.pub`, "utf8"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["ED", "Ed"])("verifies %s Minisign packets in Tauri's base64 envelope", (algorithm) => {
    const { installer, pubkey, sig } = signed(algorithm);
    expect(() => verifyUpdaterSignature(installer, sig, pubkey)).not.toThrow();
  });

  it("rejects signing before Authenticode changes the bytes", () => {
    const { installer, pubkey, sig } = signed();
    expect(() => verifyUpdaterSignature(Buffer.concat([installer, Buffer.from("certificate")]), sig, pubkey))
      .toThrow(/verification failed/);
  });

  it("rejects a different key, tampered comments, truncated packets and unsupported algorithms", () => {
    const { installer, pubkey, sig, raw, encode } = signed();
    expect(() => verifyUpdaterSignature(installer, sig, signed().pubkey)).toThrow(/key ID mismatch/);
    expect(() => verifyUpdaterSignature(installer, encode(raw.replace("timestamp:1792540800", "timestamp:1")), pubkey))
      .toThrow(/verification failed/);
    expect(() => verifyUpdaterSignature(installer, encode(raw.split("\n").slice(0, 3).join("\n")), pubkey))
      .toThrow(/structure/);
    const lines = raw.trim().split("\n");
    lines[1] = Buffer.from("Ed").toString("base64");
    expect(() => verifyUpdaterSignature(installer, encode(lines.join("\n")), pubkey)).toThrow(/packet/);
    const unknown = signed("XX");
    expect(() => verifyUpdaterSignature(unknown.installer, unknown.sig, unknown.pubkey)).toThrow(/algorithm/);
    expect(() => verifyUpdaterSignature(installer, "bad-base64!", pubkey)).toThrow(/base64/);
  });
});
