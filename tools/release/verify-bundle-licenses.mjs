#!/usr/bin/env node
// Read-only check of a built resource directory (Windows: target/release after NSIS packaging).
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredLicenseFiles } from "./required-license-files.mjs";

export function verifyBundleLicenses(resourceDirectory) {
  for (const { target } of requiredLicenseFiles) {
    const path = join(resourceDirectory, target);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${path}: required bundled licence file is missing`);
    }
  }
  return requiredLicenseFiles.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node tools/release/verify-bundle-licenses.mjs <resource-directory>");
    const directory = resolve(process.argv[2]);
    const count = verifyBundleLicenses(directory);
    console.log(`Verified ${count} bundled licence files (${directory})`);
  } catch (error) {
    console.error(`Bundle licence check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
