#!/usr/bin/env node
// Offline gate: inspect supplied local artifacts, never fetch an enclosure URL.
// Historical entries receive URL/notes/hardware checks; each supplied DMG is mounted read-only
// and every app inside it receives the full final-app gate. Supply all DMGs being published.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dmgArchitecture, targetForFeed, verifyAppcast } from "./macos-appcast.mjs";
import { targetArchitecture } from "./macos-mach-o.mjs";
import { readAppPlist, verifyApp, verifySourceCommit } from "./verify-macos-app.mjs";

export function verifyDmg(dmg, target, {
  run = spawnSync, checkApp = verifyApp, makeTemp = () => mkdtempSync(join(tmpdir(), "chemdraft-dmg-")),
  entries = readdirSync, cleanup = (path) => rmSync(path, { recursive: true, force: true })
} = {}) {
  if (dmgArchitecture(basename(dmg)) !== targetArchitecture(target)) throw new Error(`${dmg}: filename does not match feed architecture`);
  const mount = makeTemp();
  let mounted = false;
  try {
    const attach = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg], { encoding: "utf8" });
    if (attach.status !== 0) throw new Error(`Cannot mount ${dmg}: ${attach.stderr || attach.error?.message}`);
    mounted = true;
    const apps = entries(mount).filter((name) => name.endsWith(".app"));
    if (!apps.length) throw new Error(`${dmg}: no app bundle found`);
    for (const app of apps) checkApp(join(mount, app), target);
  } finally {
    if (mounted) {
      const detach = run("/usr/bin/hdiutil", ["detach", mount], { encoding: "utf8" });
      // Never recursively remove a mountpoint if detach failed.
      if (detach.status !== 0) throw new Error(`Cannot detach ${mount}: ${detach.stderr || detach.error?.message}`);
    }
    cleanup(mount);
  }
}

// Release provenance must come from the payload, never an adjacent build record.
export function verifyDmgCommit(dmg, target, commit, { run = spawnSync, ...options } = {}) {
  verifyDmg(dmg, target, {
    ...options, run,
    checkApp: (app) => verifySourceCommit(readAppPlist(app, run), commit)
  });
}

export function verifyFeedArtifacts({ xml, target, dmgs = [], apps = [] }, { checkDmg = verifyDmg, checkApp = verifyApp } = {}) {
  const items = verifyAppcast(xml, target);
  for (const dmg of dmgs) {
    if (!items.some((item) => basename(new URL(item.url).pathname) === basename(dmg))) throw new Error(`${dmg}: artifact is not listed in the feed`);
    checkDmg(dmg, target);
  }
  for (const app of apps) checkApp(app, target);
  return items.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { dmg: { type: "string", multiple: true }, app: { type: "string", multiple: true } }, allowPositionals: true });
    if (positionals.length !== 1 || (!values.dmg?.length && !values.app?.length)) throw new Error("Usage: node tools/release/verify-macos-feed.mjs <appcast.xml|appcast-intel.xml> --dmg <final.dmg> [--dmg …] [--app <final.app>]");
    const target = targetForFeed(basename(positionals[0]));
    verifyFeedArtifacts({ xml: readFileSync(positionals[0], "utf8"), target, dmgs: values.dmg, apps: values.app });
    console.log(`Verified ${positionals[0]} and supplied local artifacts (${target})`);
  } catch (error) { console.error(`macOS feed check failed: ${error.message}`); process.exitCode = 1; }
}
