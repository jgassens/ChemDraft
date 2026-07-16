/**
 * TEST SUPPORT — a clean, committed copy of a plugin, so tests can drive the real packaging gates
 * against real plugin source.
 *
 * `plugin:package` (like `plugin:extract`) refuses a plugin whose Git tree is dirty, because the commit
 * it records must actually describe the bytes it ships. That gate is correct, and it makes a test that
 * packages a live workspace plugin depend on the developer's working tree being clean — which it is not,
 * mid-change. This copies a plugin into its own throwaway repository and commits it, so the gates run
 * for real against real source.
 *
 * **Not a way to distribute uncommitted work.** Provenance recorded from a copy made here points at a
 * throwaway commit that exists nowhere else, which is exactly the meaningless provenance the gate is
 * there to prevent. Real distributions must be packaged from a committed repository.
 *
 * `node_modules` is symlinked rather than copied: the plugin's dependencies (`openchemlib`, the SDK)
 * must still resolve for the bundler, and pnpm's per-package `node_modules` contains relative symlinks
 * that resolve correctly through the link.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface CommittedPluginCopy {
  /** Throwaway root holding the copy; remove it with {@link removeCommittedPluginCopy}. */
  caseRoot: string;
  /** The copied plugin directory — pass this as `pluginRoot`. */
  pluginRoot: string;
  /** The synthetic commit the copy was committed at. */
  sourceCommit: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function createCommittedPluginCopy(pluginRoot: string, label = "chemdraft-package-"): CommittedPluginCopy {
  const caseRoot = mkdtempSync(join(tmpdir(), label));
  // Keep the directory name: both tools derive the artifact filename from it.
  const copy = join(caseRoot, basename(pluginRoot));

  cpSync(pluginRoot, copy, {
    recursive: true,
    // Never copy node_modules (huge, and pnpm's relative symlinks would not survive the move).
    filter: (source) => !/[/\\]node_modules([/\\]|$)/.test(source)
  });

  const dependencies = join(pluginRoot, "node_modules");
  if (existsSync(dependencies)) {
    symlinkSync(dependencies, join(copy, "node_modules"), "dir");
  }
  writeFileSync(join(copy, ".gitignore"), "node_modules/\n");

  git(copy, ["init", "-q"]);
  git(copy, ["add", "."]);
  git(copy, [
    "-c",
    "user.name=ChemDraft Test",
    "-c",
    "user.email=tests@chemdraft.invalid",
    "commit",
    "-q",
    "-m",
    "packaging fixture"
  ]);

  return { caseRoot, pluginRoot: copy, sourceCommit: git(copy, ["rev-parse", "HEAD"]) };
}

export function removeCommittedPluginCopy(copy: CommittedPluginCopy): void {
  rmSync(copy.caseRoot, { recursive: true, force: true });
}
