#!/usr/bin/env node
/**
 * What build is each ChemDraft on this machine actually running?
 *
 * Every window writes `runtime-build.json` into its own app-data directory when it loads, after
 * each hot update, and whenever it comes back to the front. This reads those files. It answers a
 * different question from "what does the source say": the dev server always serves the newest
 * code, while an open window holds whatever its last hot reload managed to apply.
 *
 *   node scripts/running-build.mjs            # one line per app
 *   node scripts/running-build.mjs --json     # the raw records
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDataRoot } from "./app-data-root.mjs";

const SUPPORT_DIR = appDataRoot();
const STATUS_FILE = "runtime-build.json";

function chemdraftAppDirs() {
  let entries;
  try {
    entries = readdirSync(SUPPORT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("org.chemdraft."))
    .map((entry) => ({ id: entry.name, path: join(SUPPORT_DIR, entry.name, STATUS_FILE) }));
}

function readStatus(app) {
  try {
    const status = JSON.parse(readFileSync(app.path, "utf8"));
    return { ...app, status, writtenAt: statSync(app.path).mtime };
  } catch {
    return undefined;
  }
}

function ageOf(date) {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h ago` : `${Math.round(hours / 24)} days ago`;
}

const records = chemdraftAppDirs()
  .map(readStatus)
  .filter((record) => record !== undefined)
  .sort((left, right) => right.writtenAt.getTime() - left.writtenAt.getTime());

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(records, null, 2));
} else if (records.length === 0) {
  console.log("No running ChemDraft has reported a build yet.");
  console.log(`Looked for ${STATUS_FILE} under ${SUPPORT_DIR}/org.chemdraft.*`);
  console.log("A window writes it on load — reload the app window (Cmd-R) and run this again.");
} else {
  for (const { id, status, writtenAt } of records) {
    const updates = status.hotUpdates > 0
      ? `, ${status.hotUpdates} hot update${status.hotUpdates === 1 ? "" : "s"}`
      : "";
    console.log(`${id}`);
    console.log(`  build   ${status.buildStamp}`);
    console.log(`  bundle  ${status.bundleStamp}`);
    console.log(`  window  ${status.windowLabel} · loaded ${ageOf(new Date(status.loadedAt))}${updates}`);
    console.log(`  seen    ${ageOf(writtenAt)} (${status.reason})`);
  }
}
