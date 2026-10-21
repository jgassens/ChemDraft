/** Verify Tauri's base64-wrapped Minisign .sig against the checked-in updater public key.
 * Tauri CLI has no `signer verify` command. Use Node's Ed25519 and BLAKE2b-512 primitives;
 * verify both the file signature and Minisign's authenticated comment, including the key ID.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function decode(value: string): Buffer {
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, "base64");
  if (!bytes.length || bytes.toString("base64") !== trimmed) throw new Error("Invalid Minisign base64 encoding.");
  return bytes;
}

export function verifyUpdaterSignature(installer: Buffer, encodedSignature: string, encodedPublicKey: string): void {
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

export function main(args: readonly string[]): void {
  if (args.length !== 1) throw new Error("Usage: verify-windows-updater.ts <installer.exe>");
  const installer = resolve(args[0]);
  const config = JSON.parse(readFileSync(resolve("apps/desktop/src-tauri/tauri.windows.conf.json"), "utf8"));
  verifyUpdaterSignature(readFileSync(installer), readFileSync(`${installer}.sig`, "utf8"), config.plugins.updater.pubkey);
  console.log("Updater signature verified against tauri.windows.conf.json.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-windows-updater: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
