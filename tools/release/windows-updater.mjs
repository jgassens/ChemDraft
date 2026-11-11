// Shared offline Tauri updater contract and Minisign verifier.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const RELEASE_DOWNLOAD_BASE = "https://github.com/jgassens/ChemDraft/releases/download";
// tauri-plugin-updater's NSIS-specific platform key, as emitted by the manifest generator.
export const WINDOWS_PLATFORM_KEY = "windows-x86_64-nsis";

export function loadUpdaterPublicKey(config = new URL("../../apps/desktop/src-tauri/tauri.windows.conf.json", import.meta.url)) {
  const key = JSON.parse(readFileSync(config, "utf8"))?.plugins?.updater?.pubkey;
  if (typeof key !== "string" || !key.trim()) throw new Error("tauri.windows.conf.json: plugins.updater.pubkey: expected a nonempty updater public key");
  return key;
}

function decode(value) {
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, "base64");
  if (!bytes.length || bytes.toString("base64") !== trimmed) throw new Error("Invalid Minisign base64 encoding.");
  return bytes;
}

/** @param {Buffer} installer @param {string} encodedSignature @param {string} encodedPublicKey */
export function verifyUpdaterSignature(installer, encodedSignature, encodedPublicKey) {
  const publicLines = decode(encodedPublicKey).toString("utf8").trim().split(/\r?\n/);
  const signatureLines = decode(encodedSignature).toString("utf8").trim().split(/\r?\n/);
  if (publicLines.length !== 2 || signatureLines.length !== 4 ||
      !publicLines[0].startsWith("untrusted comment: ") ||
      !signatureLines[0].startsWith("untrusted comment: ") ||
      !signatureLines[2].startsWith("trusted comment: ")) {
    throw new Error("Invalid Minisign key or signature structure.");
  }
  const key = decode(publicLines[1]);
  const signature = decode(signatureLines[1]);
  const globalSignature = decode(signatureLines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed" ||
      signature.length !== 74 || globalSignature.length !== 64) {
    throw new Error("Invalid Minisign key or signature packet.");
  }
  if (!key.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error("Updater signature key ID mismatch.");
  const algorithm = signature.subarray(0, 2).toString();
  if (algorithm !== "Ed" && algorithm !== "ED") throw new Error("Unsupported Minisign signature algorithm.");
  // DER SubjectPublicKeyInfo prefix for a raw Ed25519 public key (RFC 8410).
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki"
  });
  const message = algorithm === "ED" ? createHash("blake2b512").update(installer).digest() : installer;
  const fileSignature = signature.subarray(10);
  const comment = Buffer.from(signatureLines[2].slice("trusted comment: ".length));
  if (!verify(null, message, publicKey, fileSignature) ||
      !verify(null, Buffer.concat([fileSignature, comment]), publicKey, globalSignature)) {
    throw new Error("Updater signature verification failed: installer or authenticated comment changed.");
  }
}
