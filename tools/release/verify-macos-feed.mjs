#!/usr/bin/env node
// Offline gate: inspect supplied local artifacts, never fetch an enclosure URL.
// Historical entries receive URL/notes/hardware checks; each supplied DMG is mounted read-only
// and every app inside it receives the full final-app gate. Supply all DMGs being published.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dmgArchitecture, targetForFeed, verifyAppcast, verifyDmgEnclosure } from "./macos-appcast.mjs";
import { targetArchitecture } from "./macos-mach-o.mjs";
import { readAppPlist, verifyApp, verifySourceCommit } from "./verify-macos-app.mjs";
import { refuseUnsignedBuild, withDmgApps } from "./macos-dmg.mjs";

export function verifyDmg(dmg, target, {
  run = spawnSync, checkApp = (app, appTarget) => {
    refuseUnsignedBuild(readAppPlist(app, run));
    verifyApp(app, appTarget, { run });
  }, ...options
} = {}) {
  if (dmgArchitecture(basename(dmg)) !== targetArchitecture(target)) throw new Error(`${dmg}: filename does not match feed architecture`);
  return withDmgApps(dmg, (app) => checkApp(app, target), { ...options, run });
}

// Release provenance must come from the payload, never an adjacent build record.
export function verifyDmgCommit(dmg, target, commit, { run = spawnSync, ...options } = {}) {
  verifyDmg(dmg, target, {
    ...options, run,
    checkApp: (app) => {
      const plist = readAppPlist(app, run);
      refuseUnsignedBuild(plist);
      verifySourceCommit(plist, commit);
    }
  });
}

export function verifyFeedArtifacts({ xml, target, dmgs = [], apps = [] }, { checkDmg = verifyDmg, checkApp = verifyApp, sparklePublicKey } = {}) {
  const items = verifyAppcast(xml, target);
  for (const dmg of dmgs) {
    const matches = items.filter((item) => basename(decodeURIComponent(new URL(item.url).pathname)) === basename(dmg));
    if (!matches.length) throw new Error(`${dmg}: artifact is not listed in the feed`);
    const bytes = readFileSync(dmg);
    // Check every matching item so a duplicate enclosure cannot hide stale metadata.
    for (const item of matches) verifyDmgEnclosure(item, bytes, sparklePublicKey);
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
