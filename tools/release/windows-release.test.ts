import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
const hasPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
// A cold pwsh start on CI runners can exceed Vitest's 5 s default.
const pwshTestTimeoutMs = 30_000;

// Execute the workflow's actual scripts, with only the Windows certificate/file APIs mocked.
function stepScript(name: string) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  const script = step?.split("        run: |\n")[1];
  if (!script) throw new Error(`Missing workflow script: ${name}`);
  return script.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
}

function run(script: string, env: Record<string, string>) {
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

describe.skipIf(!hasPowerShell)("Windows release signing gates (requires installed pwsh)", () => {
  it.each([
    ["Valid", "CN=SignPath Foundation", "SignPath Foundation", true],
    ["Valid", "CN=Unexpected Publisher", "SignPath Foundation", false],
    ["Valid", "CN=SignPath Foundation", "", false],
    ["Valid", "CN=SignPath Foundation", "   ", false],
    ["NotSigned", "CN=SignPath Foundation", "SignPath Foundation", false]
  ] as const)("checks status %s and subject %s against '%s'", (status, subject, expected, accepted) => {
    const root = mkdtempSync(join(tmpdir(), "chemdraft-signing-gate-"));
    const output = join(root, "output");
    try {
      const result = run(`
function Get-ChildItem { [PSCustomObject]@{ Name = 'test.exe'; FullName = 'test.exe' } }
function Get-AuthenticodeSignature {
  [PSCustomObject]@{ Status = $env:TEST_STATUS; SignerCertificate = [PSCustomObject]@{ Subject = $env:TEST_SUBJECT } }
}
function Copy-Item { }
${stepScript("Verify Authenticode and replace unsigned installer")}`, {
        TEST_STATUS: status,
        TEST_SUBJECT: subject,
        EXPECTED_AUTHENTICODE_SUBJECT: expected,
        INSTALLER: "test.exe",
        GITHUB_OUTPUT: output
      });
      expect(result.status === 0, result.stderr).toBe(accepted);
      if (accepted) expect(readFileSync(output, "utf8")).toContain("signed=true");
      if (!expected.trim()) expect(result.stderr).toContain("EXPECTED_AUTHENTICODE_SUBJECT repository variable is required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, pwshTestTimeoutMs);

  it.each([
    ["true", "true", "false", true, false],
    ["false", "true", "false", false, false],
    ["true", "false", "false", false, false],
    ["false", "false", "false", false, false],
    ["", "", "false", false, false],
    ["false", "true", "true", true, true],
    ["true", "false", "true", true, true],
    ["false", "false", "true", true, true]
  ] as const)("gates upload with Authenticode=%s updater=%s override=%s", (authenticode, updater, override, accepted, warned) => {
    const result = run(stepScript("Require verified signatures before release upload"), {
      AUTHENTICODE_SIGNED: authenticode,
      UPDATER_SIGNED: updater,
      ALLOW_UNSIGNED_UPLOAD: override
    });
    expect(result.status === 0, result.stderr).toBe(accepted);
    expect(result.stdout.includes("::warning::UNSIGNED RELEASE UPLOAD OVERRIDE")).toBe(warned);
  }, pwshTestTimeoutMs);
});
