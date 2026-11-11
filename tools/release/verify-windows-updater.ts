/** Verify Tauri's base64-wrapped Minisign .sig against the checked-in updater public key.
 * Tauri CLI has no `signer verify` command. Use Node's Ed25519 and BLAKE2b-512 primitives;
 * verify both the file signature and Minisign's authenticated comment, including the key ID.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUpdaterPublicKey, verifyUpdaterSignature } from "./windows-updater.mjs";

export { verifyUpdaterSignature } from "./windows-updater.mjs";

export function main(args: readonly string[]): void {
  if (args.length !== 1) throw new Error("Usage: verify-windows-updater.ts <installer.exe>");
  const installer = resolve(args[0]);
  verifyUpdaterSignature(readFileSync(installer), readFileSync(`${installer}.sig`, "utf8"),
    loadUpdaterPublicKey(resolve("apps/desktop/src-tauri/tauri.windows.conf.json")));
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
