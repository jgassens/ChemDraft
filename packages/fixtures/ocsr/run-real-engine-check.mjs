#!/usr/bin/env node
// Opt-in real-engine OCSR accuracy check (`pnpm test:ocsr-real`). Not part of `pnpm test`: it needs
// an installed MolScribe engine and its 1.1 GB model, which CI does not have.
//
// Finds an installed engine, then runs real_engine_check.py with that engine's own venv interpreter
// against the sidecar in this checkout. Set CHEMDRAFT_OCSR_ENGINE_DIR to an `ocsr-engine` directory
// to choose one; otherwise every ChemDraft app data folder (the stable app and every dev build) is
// searched and the most recently installed engine is used.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const sidecar = join(repoRoot, "apps/desktop/src-tauri/resources/ocsr/molscribe_sidecar.py");
const MODEL_FILENAME = "swin_base_char_aux_1m.pth";
const STABLE_ID = "org.chemdraft.desktop";

function venvPython(engineDir) {
  return platform() === "win32"
    ? join(engineDir, "venv", "Scripts", "python.exe")
    : join(engineDir, "venv", "bin", "python");
}

/** Where Tauri puts `app_data_dir()` for each bundle id on this OS. */
function appDataRoots() {
  if (platform() === "darwin") return [join(homedir(), "Library", "Application Support")];
  if (platform() === "win32") return [process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")];
  return [process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")];
}

function isUsable(engineDir) {
  return existsSync(venvPython(engineDir)) && existsSync(join(engineDir, MODEL_FILENAME));
}

function discoverEngines() {
  const found = [];
  for (const root of appDataRoots()) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name !== STABLE_ID && !name.startsWith(`${STABLE_ID}.dev.`)) continue;
      const engineDir = join(root, name, "ocsr-engine");
      if (!isUsable(engineDir)) continue;
      const receipt = join(engineDir, "install.json");
      const installedAt = existsSync(receipt) ? statSync(receipt).mtimeMs : 0;
      found.push({ engineDir, installedAt });
    }
  }
  return found.sort((a, b) => b.installedAt - a.installedAt).map((entry) => entry.engineDir);
}

let engineDir = process.env.CHEMDRAFT_OCSR_ENGINE_DIR;
if (engineDir) {
  if (!isUsable(engineDir)) {
    console.error(
      `CHEMDRAFT_OCSR_ENGINE_DIR=${engineDir} has no venv interpreter (${venvPython(engineDir)}) or no ${MODEL_FILENAME}.`
    );
    process.exit(2);
  }
} else {
  const engines = discoverEngines();
  if (engines.length === 0) {
    console.error(
      "No installed OCSR engine found in the ChemDraft app data folders. Install it from the app " +
        "(Add or Remove Plugins → Structure from Image), or set CHEMDRAFT_OCSR_ENGINE_DIR."
    );
    process.exit(2);
  }
  if (engines.length > 1) console.log(`found ${engines.length} engines; using the newest:\n  ${engines.join("\n  ")}`);
  engineDir = engines[0];
}

const result = spawnSync(
  venvPython(engineDir),
  [join(here, "real_engine_check.py"), "--engine", engineDir, "--sidecar", sidecar, "--fixtures", here],
  { stdio: "inherit" }
);
if (result.error) {
  console.error(`Could not start ${venvPython(engineDir)}: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
