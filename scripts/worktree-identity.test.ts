import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStableBuild, labelFromEnv, worktreeIdentity, worktreeLabelFor } from "./worktree-identity.mjs";

describe("shared dev identity", () => {
  it.each(["feature-one", "Feature Two", "---"])("uses the same id for worktree %s and retains its label", (folder) => {
    const result = worktreeIdentity(`/nonexistent/${folder}`);
    expect(result.devBundleId).toBe("org.chemdraft.desktop.dev");
    expect(result.label).toBe(folder);
  });
});

// Exercise only the launcher's definitions with mocked process observations. No app is built,
// launched, or stopped. These macOS shell checks are skipped on Windows, where Node launches Tauri.
describe.skipIf(process.platform === "win32")("run-app shared dev lock guard", () => {
  const source = readFileSync(new URL("../run-app", import.meta.url), "utf8");
  const definitions = source.split('\ncd "$ROOT_DIR"\n')[0]
    .replace(/^ROOT_DIR=.*$/m, 'ROOT_DIR="/test/current checkout"');
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function lockFixture() {
    const directory = mkdtempSync(join(process.cwd(), ".run-app-lock-test-"));
    temporaryDirectories.push(directory);
    return {
      lock: join(directory, "org.chemdraft.desktop.dev.launch.lock"),
      env: { ...process.env, TMPDIR: directory }
    };
  }

  function runShell(script: string, env: NodeJS.ProcessEnv) {
    return spawnSync("/bin/bash", ["-c", `${definitions}\n${script}`], { encoding: "utf8", env, timeout: 5000 });
  }

  const probeOnly = `kill() {
    if [ "$1" != "-0" ]; then echo 'unexpected kill' >&2; exit 99; fi
    builtin kill "$@"
  }`;

  it("refuses a live launch lock and reports its checkout without removing it", () => {
    const { lock, env } = lockFixture();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    writeFileSync(join(lock, "checkout"), "/test/other checkout\n");
    const result = runShell(`${probeOnly}\nacquire_dev_launch_lock`, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`/test/other checkout`);
    expect(result.stderr).toContain(`pid ${process.pid}`);
    expect(result.stderr).not.toContain("unexpected kill");
    expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(process.pid));
  });

  it("takes over a stale lock and releases it on normal exit", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`${probeOnly}
      mkdir "$DEV_LAUNCH_LOCK"
      (exit 0) &
      stale_pid=$!
      wait "$stale_pid"
      printf '%s\\n' "$stale_pid" >"$DEV_LAUNCH_LOCK/pid"
      printf '%s\\n' '/test/old checkout' >"$DEV_LAUNCH_LOCK/checkout"
      acquire_dev_launch_lock
      test "$(cat "$DEV_LAUNCH_LOCK/pid")" = "$$"
      test "$(cat "$DEV_LAUNCH_LOCK/checkout")" = "$ROOT_DIR"
    `, env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it.each([false, true])("takes over an aged ownerless lock (abandoned reclaim: %s)", (abandonedReclaim) => {
    const { lock, env } = lockFixture();
    mkdirSync(lock);
    const old = new Date(Date.now() - 30_000);
    if (abandonedReclaim) {
      mkdirSync(join(lock, "reclaim"));
      utimesSync(join(lock, "reclaim"), old, old);
    }
    utimesSync(lock, old, old);
    const result = runShell(`${probeOnly}
      acquire_dev_launch_lock
      test "$(cat "$DEV_LAUNCH_LOCK/pid")" = "$$"
      test "$(cat "$DEV_LAUNCH_LOCK/checkout")" = "$ROOT_DIR"
    `, env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves a fresh ownerless lock alone while its owner may be publishing metadata", () => {
    const { lock, env } = lockFixture();
    mkdirSync(lock);
    const result = runShell(`${probeOnly}\nacquire_dev_launch_lock`, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pid unknown");
    expect(result.stderr).not.toContain("unexpected kill");
    expect(existsSync(lock)).toBe(true);
  });

  it.each(["INT", "TERM", "HUP"] as const)("holds the lock after %s until the launcher child exits", async (signal) => {
    const { lock, env } = lockFixture();
    const interrupted = join(env.TMPDIR!, "interrupted");
    const finish = join(env.TMPDIR!, "finish");
    const holder = spawn("/bin/bash", ["-c", `${definitions}
      ${probeOnly}
      acquire_dev_launch_lock
      pgrep() {
        case "$(trap -p ${signal})" in *"''"*) touch "$TMPDIR/interrupted" ;; esac
        return 1
      }
      DEV_LAUNCHER_EXECUTABLE="$DEV_APP_EXECUTABLE"
      # The mock launcher exits on request, with a fallback deadline for failed tests.
      (for _ in {1..150}; do
        [ ! -e "$TMPDIR/finish" ] || exit 0
        sleep 0.02
      done) &
      DEV_LAUNCHER_PID=$!
      printf 'ready\\n'
      wait_for_launched_app "$DEV_APP_EXECUTABLE" "$DEV_LAUNCHER_PID"
    `], { env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve) => holder.on("close", resolve));
    let stderr = "";
    holder.stderr.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout.once("data", () => resolve());
        holder.once("exit", () => reject(new Error(`Lock holder exited early: ${stderr}`)));
      });
      holder.kill(`SIG${signal}` as NodeJS.Signals);
      await expect.poll(() => existsSync(interrupted), { timeout: 2000 }).toBe(true);
      expect(existsSync(lock)).toBe(true);
      const second = runShell(`${probeOnly}\nacquire_dev_launch_lock`, env);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("another run-app holds");
      expect(holder.exitCode).toBe(null);
    } finally {
      writeFileSync(finish, "");
      await closed;
    }
    expect(holder.exitCode).toBe({ INT: 130, TERM: 143, HUP: 129 }[signal]);
    expect(stderr).not.toContain("unexpected kill");
    expect(existsSync(lock)).toBe(false);
  });

  it("bounds the interrupted wait even if the launcher stays alive", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`${probeOnly}
      acquire_dev_launch_lock
      DEV_LAUNCHER_PID=$$
      DEV_LAUNCHER_EXECUTABLE="$DEV_APP_EXECUTABLE"
      pgrep() { return 1; }
      # Advance the shell clock instead of spending 60 seconds in this test.
      sleep() { SECONDS=$((SECONDS + 60)); }
      handle_dev_launch_signal 143
    `, env);
    expect(result.status).toBe(143);
    expect(result.stderr).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  it("handles a signal before any launcher exists under set -u", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`${probeOnly}
      acquire_dev_launch_lock
      DEV_LAUNCHER_EXECUTABLE="$DEV_APP_EXECUTABLE"
      handle_dev_launch_signal 129
    `, env);
    expect(result.status).toBe(129);
    expect(result.stderr).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  it("holds the lock until the app becomes visible, then releases it before the launcher exits", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`${probeOnly}
      acquire_dev_launch_lock
      # Observe no app on the first poll, then a matching executable on the next.
      pgrep() {
        test -d "$DEV_LAUNCH_LOCK"
        [ "$2" = "chemdraft" ] || return 1
        if [ -f "$TMPDIR/polled" ]; then printf '12345\\n'; else touch "$TMPDIR/polled"; fi
      }
      process_executable() { printf '%s\\n' "$DEV_APP_EXECUTABLE"; }
      wait_for_launched_app "$DEV_APP_EXECUTABLE" "$$"
      test ! -d "$DEV_LAUNCH_LOCK"
    `, env);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock if the launcher exits before the app appears", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`${probeOnly}
      acquire_dev_launch_lock
      pgrep() { return 1; }
      (exit 1) &
      launcher_pid=$!
      wait "$launcher_pid" || true
      wait_for_launched_app "$DEV_APP_EXECUTABLE" "$launcher_pid"
    `, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("before its app process became visible");
    expect(result.stderr).not.toContain("unexpected kill");
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock on a failed conflict check", () => {
    const { lock, env } = lockFixture();
    const result = runShell(`
      acquire_dev_launch_lock
      pgrep() { printf '12345\\n'; }
      process_executable() { printf '/test/other/target/debug/chemdraft\\n'; }
      process_bundle_identifier() { :; }
      assert_no_other_dev_app
    `, env);
    expect(result.status).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("allows only one checkout through while launches overlap", async () => {
    const { lock, env } = lockFixture();
    const first = spawn("/bin/bash", ["-c", `${definitions}
      ROOT_DIR='/test/first checkout'
      acquire_dev_launch_lock
      printf 'locked\\n'
      read -r -t 4 reply
    `], { env, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve) => first.on("close", resolve));
    let stderr = "";
    first.stderr.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.stdout.once("data", () => resolve());
        first.once("exit", () => reject(new Error(`Lock holder exited early: ${stderr}`)));
      });
      const second = runShell("ROOT_DIR='/test/second checkout'\nacquire_dev_launch_lock", env);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("/test/first checkout");
      expect(existsSync(lock)).toBe(true);
    } finally {
      first.stdin.end("done\n");
      await closed;
    }
    expect(stderr).toBe("");
    expect(existsSync(lock)).toBe(false);
  });

  function check(executable: string, bundleId = "") {
    return spawnSync("/bin/bash", ["-c", `${definitions}
      pgrep() { printf '12345\\n'; }
      process_executable() { printf '%s\\n' "$TEST_EXECUTABLE"; }
      process_bundle_identifier() { printf '%s\\n' "$TEST_BUNDLE_ID"; }
      kill() { echo 'unexpected kill' >&2; return 99; }
      assert_no_other_dev_app
      printf '%s\\n' "$RUN_APP_BUNDLE_ID"
    `], { encoding: "utf8", env: { ...process.env, TEST_EXECUTABLE: executable, TEST_BUNDLE_ID: bundleId } });
  }

  it.each([
    "/test/sibling checkout/app/ChemDraft (dev).app/Contents/MacOS/chemdraft",
    "/test/sibling checkout/app/ChemDraft (dev).app/Contents/MacOS/ChemDraft",
    "/test/sibling checkout/apps/desktop/src-tauri/target/debug/chemdraft",
    "/test/current checkout/worktrees/nested/apps/desktop/src-tauri/target/debug/chemdraft",
    "/test/sibling checkout/apps/desktop/src-tauri/target/release/chemdraft",
    "/test/sibling checkout/apps/desktop/src-tauri/target/release/bundle/macos/ChemDraft.app/Contents/MacOS/chemdraft"
  ])("refuses a sibling executable without stopping anything: %s", (executable) => {
    const result = check(executable);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(executable);
    expect(result.stderr).toContain("Quit that build");
    expect(result.stderr).not.toContain("unexpected kill");
    expect(result.stdout).toBe("");
  });

  it("recognizes the shared bundle id even outside a checkout's app or target directory", () => {
    expect(check("/elsewhere/ChemDraft (dev).app/Contents/MacOS/chemdraft", "org.chemdraft.desktop.dev").status).toBe(1);
  });

  it.each([
    ["/test/current checkout/apps/desktop/src-tauri/target/debug/chemdraft", ""],
    ["/test/current checkout/app/ChemDraft (dev).app/Contents/MacOS/chemdraft", "org.chemdraft.desktop.dev"],
    ["/Applications/ChemDraft.app/Contents/MacOS/chemdraft", "org.chemdraft.desktop"],
    ["/test/sibling/target/release/bundle/macos/ChemDraft.app/Contents/MacOS/chemdraft", "org.chemdraft.desktop"],
    ["/unrelated/program", ""],
    ["", ""]
  ])("leaves local, stable, and unidentified processes alone: %s", (executable, bundleId) => {
    const result = check(executable, bundleId);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("org.chemdraft.desktop.dev");
    expect(result.stderr).not.toContain("unexpected kill");
  });

  it("checks before cleanup and again immediately before either launch path", () => {
    const main = source.slice(source.indexOf('\ncd "$ROOT_DIR"\n'));
    expect(main.indexOf("acquire_dev_launch_lock")).toBeLessThan(main.indexOf("assert_no_other_dev_app"));
    expect(main.indexOf("assert_no_other_dev_app")).toBeLessThan(main.indexOf("stop_existing_dev_apps"));
    expect(main.indexOf("assert_no_other_dev_app")).toBeLessThan(main.indexOf("pnpm install"));
    expect(main).toContain('assert_no_other_dev_app\n  DEV_LAUNCHER_EXECUTABLE="$DEV_APP_EXECUTABLE"\n  npm run dev:tauri &');
    expect(main).toContain('wait_for_launched_app "$DEV_APP_EXECUTABLE" "$dev_launcher_pid"');
    expect(main).toContain('assert_no_other_dev_app\nlaunch_bundle "$RUN_APP_BUNDLE"');
    expect(source).toContain('wait_for_launched_app "$bundle/Contents/MacOS/$executable" "$launcher_pid"');
  });
});

const identity = (branch: string) => ({ branch, label: `chemdraw [${branch}]` });

describe("worktreeLabelFor", () => {
  it("labels a build on main with the empty string, even over an inherited label", () => {
    expect(isStableBuild({ command: "build", branch: "main", env: {} })).toBe(true);
    expect(worktreeLabelFor({ command: "build", identity: identity("main"), env: {} })).toBe("");
    expect(
      worktreeLabelFor({ command: "build", identity: identity("main"), env: { CHEMDRAFT_WORKTREE_LABEL: "leaked [x]" } })
    ).toBe("");
  });

  it("treats CHEMDRAFT_STABLE_BUILD=1 on a release branch as stable", () => {
    const env = { CHEMDRAFT_STABLE_BUILD: "1" };
    expect(isStableBuild({ command: "build", branch: "release/0.3.7", env })).toBe(true);
    expect(worktreeLabelFor({ command: "build", identity: identity("release/0.3.7"), env })).toBe("");
  });

  it("keeps the identity label on a feature-branch build", () => {
    expect(isStableBuild({ command: "build", branch: "feature/x", env: {} })).toBe(false);
    expect(worktreeLabelFor({ command: "build", identity: identity("feature/x"), env: {} })).toBe("chemdraw [feature/x]");
  });

  it("prefers an env label on a feature-branch build", () => {
    expect(
      worktreeLabelFor({ command: "build", identity: identity("feature/x"), env: { CHEMDRAFT_WORKTREE_LABEL: "mine" } })
    ).toBe("mine");
  });

  it("does not let an inherited empty label unlabel a branch build", () => {
    for (const inherited of ["", "   "]) {
      const env = { CHEMDRAFT_WORKTREE_LABEL: inherited };
      expect(worktreeLabelFor({ command: "build", identity: identity("feature/x"), env })).toBe("chemdraw [feature/x]");
      expect(worktreeLabelFor({ command: "dev", identity: identity("main"), env })).toBe("chemdraw [main]");
    }
  });

  it("never treats dev as stable, even on main", () => {
    expect(isStableBuild({ command: "dev", branch: "main", env: { CHEMDRAFT_STABLE_BUILD: "1" } })).toBe(false);
    expect(worktreeLabelFor({ command: "dev", identity: identity("main"), env: {} })).toBe("chemdraw [main]");
  });
});

describe("labelFromEnv", () => {
  it("returns the empty string for a defined-empty label (stable build: no git fallback)", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "" })).toBe("");
  });

  it("returns the empty string for a whitespace label", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "   " })).toBe("");
  });

  it("returns undefined when the variable is not set", () => {
    expect(labelFromEnv({})).toBeUndefined();
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: undefined })).toBeUndefined();
  });

  it("returns the trimmed value otherwise", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "  chemdraw [x] " })).toBe("chemdraw [x]");
  });
});
