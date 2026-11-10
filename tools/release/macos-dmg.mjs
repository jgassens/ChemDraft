// Dependency-free payload inspection, shared by recording and final release gates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySourceCommit } from "./source-commit.mjs";

export function readAppPlist(app, run = spawnSync) {
  const result = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot read bundle Info.plist: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

export function withDmgApps(dmg, checkApp, {
  run = spawnSync, makeTemp = () => mkdtempSync(join(tmpdir(), "chemdraft-dmg-")),
  entries = readdirSync, cleanup = (path) => rmSync(path, { recursive: true, force: true })
} = {}) {
  const mount = makeTemp();
  let mounted = false;
  try {
    const attach = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg], { encoding: "utf8" });
    if (attach.status !== 0) throw new Error(`Cannot mount ${dmg}: ${attach.stderr || attach.error?.message}`);
    mounted = true;
    const apps = entries(mount).filter((name) => name.endsWith(".app"));
    if (!apps.length) throw new Error(`${dmg}: no app bundle found`);
    return apps.map((app) => checkApp(join(mount, app)));
  } finally {
    if (mounted) {
      const detach = run("/usr/bin/hdiutil", ["detach", mount], { encoding: "utf8" });
      // Never recursively remove a mountpoint if detach failed.
      if (detach.status !== 0) throw new Error(`Cannot detach ${mount}: ${detach.stderr || detach.error?.message}`);
    }
    cleanup(mount);
  }
}

export function verifyDmgSourceCommit(dmg, commit, { run = spawnSync, recordCommit, ...options } = {}) {
  return withDmgApps(dmg, (app) => {
    const plist = readAppPlist(app, run);
    verifySourceCommit(plist, commit);
    if (recordCommit !== undefined) verifySourceCommit(plist, recordCommit);
  }, { ...options, run });
}
