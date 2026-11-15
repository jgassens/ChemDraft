// Dependency-free payload inspection, shared by recording and final release gates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySourceCommit } from "./source-commit.mjs";

export function refuseUnsignedBuild(plist) {
  if (plist.ChemDraftUnsignedBuild !== undefined && plist.ChemDraftUnsignedBuild !== false) {
    throw new Error("ChemDraftUnsignedBuild: UNSIGNED local build must NEVER be published; rebuild without CHEMDRAFT_ALLOW_UNSIGNED_STABLE=1 using APPLE_SIGNING_IDENTITY");
  }
}

export function readAppPlist(app, run = spawnSync) {
  const result = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot read bundle Info.plist: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

export function withDmgApps(dmg, checkApp, {
  run = spawnSync, makeTemp = () => mkdtempSync(join(tmpdir(), "chemdraft-dmg-")),
  entries = readdirSync, cleanup = (path) => rmSync(path, { recursive: true, force: true }),
  wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
} = {}) {
  const mount = makeTemp();
  let mounted = false;
  let earlierError;
  let failed = false;
  try {
    const attach = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg], { encoding: "utf8" });
    if (attach.status !== 0) throw new Error(`Cannot mount ${dmg}: ${attach.stderr || attach.error?.message}`);
    mounted = true;
    const apps = entries(mount).filter((name) => name.endsWith(".app"));
    if (!apps.length) throw new Error(`${dmg}: no app bundle found`);
    return apps.map((app) => checkApp(join(mount, app)));
  } catch (error) {
    failed = true;
    earlierError = error;
    throw error;
  } finally {
    if (mounted) {
      const detachDmg = (args) => {
        try {
          return run("/usr/bin/hdiutil", args, { encoding: "utf8" });
        } catch (error) {
          return { status: null, error };
        }
      };
      let detach = detachDmg(["detach", mount]);
      if (detach.status !== 0) {
        wait();
        detach = detachDmg(["detach", "-force", mount]);
      }
      // Never recursively remove a mountpoint if detach failed.
      if (detach.status !== 0) {
        const message = `Cannot detach ${mount}: ${detach.stderr || detach.error?.message}`;
        if (failed && earlierError instanceof Error) {
          earlierError.message += `; ${message}`;
          throw earlierError;
        }
        if (failed) throw new Error(`${String(earlierError)}; ${message}`, { cause: earlierError });
        throw new Error(message);
      }
    }
    cleanup(mount);
  }
}

export function verifyDmgSourceCommit(dmg, commit, { run = spawnSync, recordCommit, ...options } = {}) {
  return withDmgApps(dmg, (app) => {
    const plist = readAppPlist(app, run);
    // Shared by record-build and the final macOS asset gate.
    refuseUnsignedBuild(plist);
    verifySourceCommit(plist, commit);
    if (recordCommit !== undefined) verifySourceCommit(plist, recordCommit);
  }, { ...options, run });
}
