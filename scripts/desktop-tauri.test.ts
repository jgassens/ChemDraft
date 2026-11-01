import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "  test-only-key\n") }));
vi.mock("./worktree-identity.mjs", async (importOriginal) => ({
  ...await importOriginal<typeof import("./worktree-identity.mjs")>(),
  worktreeIdentity: () => ({ branch: "release/test", label: "checkout [release/test]", devBundleId: "org.chemdraft.desktop.dev" })
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

async function build(platform = "win32", stable = true) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "desktop-tauri.mjs", "--package-build", "--bundles", "nsis"]);
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test exit"); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("CHEMDRAFT_STABLE_BUILD", stable ? "1" : undefined);
  await expect(import("./desktop-tauri.mjs")).rejects.toThrow("test exit");
  const call = vi.mocked(spawnSync).mock.calls.at(-1)!;
  return { args: call[1] as string[], env: call[2]!.env! };
}

describe("desktop updater signing", () => {
  it("explicitly disables build-time signatures even with an env key or a key on disk", async () => {
    vi.stubEnv("CHEMDRAFT_SKIP_UPDATER_SIGNING", "1");
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", "test-only-env-key");
    vi.mocked(existsSync).mockReturnValue(true);
    const { args, env } = await build();
    expect(args).toContain(JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
    expect(readFileSync).not.toHaveBeenCalled();
    expect(env.CHEMDRAFT_WORKTREE_LABEL).toBe("");
  });

  it("keeps the VM default: reads and trims the local key and enables updater artifacts", async () => {
    vi.stubEnv("CHEMDRAFT_SKIP_UPDATER_SIGNING", undefined);
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", undefined);
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    const { args, env } = await build();
    expect(args).toContain(JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
    expect(env.TAURI_SIGNING_PRIVATE_KEY).toBe("test-only-key");
    expect(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
  });

  it("keeps env keys preferred and treats only 1 as the opt-out", async () => {
    vi.stubEnv("CHEMDRAFT_SKIP_UPDATER_SIGNING", "0");
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", "test-only-env-key");
    const { args, env } = await build();
    expect(args).toContain(JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
    expect(env.TAURI_SIGNING_PRIVATE_KEY).toBe("test-only-env-key");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("keeps a stable Windows build without a key buildable", async () => {
    vi.stubEnv("CHEMDRAFT_SKIP_UPDATER_SIGNING", undefined);
    vi.stubEnv("TAURI_SIGNING_PRIVATE_KEY", undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const { args } = await build();
    expect(args).not.toContain("--config");
  });

  it("does not change the macOS package build path", async () => {
    vi.stubEnv("CHEMDRAFT_SKIP_UPDATER_SIGNING", "1");
    const { args } = await build("darwin");
    expect(args).toContain("pnpm prepare:sparkle && pnpm sign:opsin-runtime && PATH=\"$HOME/.cargo/bin:$PATH\" tauri \"$@\"");
    expect(args).not.toContain("--config");
  });
});

describe("branch build identity", () => {
  it.each(["win32", "linux"])("uses the shared dev id and keeps the worktree label on %s", async (platform) => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { args, env } = await build(platform, false);
    const config = JSON.parse(args[args.indexOf("--config") + 1]);
    expect(config.identifier).toBe("org.chemdraft.desktop.dev");
    expect(config.productName).toBe("ChemDraft (dev)");
    expect(env.CHEMDRAFT_WORKTREE_LABEL).toBe("checkout [release/test]");
  });
});
