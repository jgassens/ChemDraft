import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildWindowsUpdateManifest, WINDOWS_PLATFORM_KEY } from "../../../tools/release/windows-update-manifest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const base = JSON.parse(read("../src-tauri/tauri.conf.json"));
const windows = JSON.parse(read("../src-tauri/tauri.windows.conf.json"));
const allusers = JSON.parse(read("../src-tauri/tauri.allusers.conf.json"));
const workflow = read("../../../.github/workflows/windows-release.yml");
const step = (name: string) => {
  const body = workflow.split(`      - name: ${name}\n`)[1];
  expect(body, `Missing workflow step: ${name}`).toBeDefined();
  return body!.split(/\n      - (?:name:|uses:)/)[0];
};

describe("Windows installer scopes", () => {
  it("keeps the existing per-user configuration and update channel", () => {
    expect(base.bundle.windows.nsis).toEqual({ installMode: "currentUser" });
    expect(windows.bundle.windows.nsis.installerHooks).toBe("./windows/installer-hooks.nsh");
    expect(windows.plugins.updater.endpoints).toEqual([
      "https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest.json"
    ]);
    expect(windows.plugins.updater.windows).toEqual({ installMode: "passive" });
    expect(windows.bundle.fileAssociations.map((entry: { ext: string[] }) => entry.ext)).toEqual([["chemdraft"]]);
  });

  it("overrides only scope and feed for the all-users installer", () => {
    expect(allusers).toEqual({
      $schema: "https://schema.tauri.app/config/2",
      bundle: {
        windows: {
          nsis: { installMode: "perMachine" }
        }
      },
      plugins: {
        updater: { endpoints: ["https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest-allusers.json"] }
      }
    });
  });

  it("uses the shared hook to quote executable and document paths for both installers", () => {
    expect(allusers.bundle.windows.nsis).not.toHaveProperty("installerHooks");
    const hook = read(`../src-tauri/${windows.bundle.windows.nsis.installerHooks}`);
    expect(hook).toContain("!macro NSIS_HOOK_POSTINSTALL");
    expect(hook).toContain('WriteRegStr SHCTX "Software\\Classes\\ChemDraft Document\\shell\\open\\command" ""');
    const command = hook.match(/"" '([^']+)'/)?.[1];
    expect(command).toBe('$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\" $\\"%1$\\"');
    expect(command?.replaceAll('$\\"', '"')
      .replace("$INSTDIR", "C:\\Program Files\\ChemDraft")
      .replace("${MAINBINARYNAME}", "chemdraft")
      .replace("%1", "C:\\Users\\A User\\My drawing.chemdraft"))
      .toBe('"C:\\Program Files\\ChemDraft\\chemdraft.exe" "C:\\Users\\A User\\My drawing.chemdraft"');
  });
});

describe("Windows release workflow", () => {
  it("builds and stages both variants before either is overwritten", () => {
    const build = step("Build, verify and stage stable NSIS installers without updater signing");
    expect(build).toContain("CHEMDRAFT_STABLE_BUILD: '1'");
    expect(build).toContain("CHEMDRAFT_SKIP_UPDATER_SIGNING: '1'");
    expect(build).toContain("@{ Suffix = ''; Config = ''; Feed = 'latest.json' }");
    expect(build).toContain("@{ Suffix = '-allusers'; Config = 'src-tauri/tauri.allusers.conf.json'; Feed = 'latest-allusers.json' }");
    expect(build).toContain("foreach ($variant in $variants)");
    expect(build).toContain("$buildArgs += @('--config', $variant.Config)");
    expect(build).toContain("pnpm @buildArgs");
    expect(build).toContain('$original = "ChemDraft_$($config.version)_x64-setup.exe"');
    expect(build).toContain('$expected = "ChemDraft_$($config.version)_x64$($variant.Suffix)-setup.exe"');
    expect(build).toContain("-Destination (Join-Path release-assets $expected)");
    expect(build).toContain("$artifacts += @{ Installer = $expected; Feed = $variant.Feed }");
    expect(build).toContain("Bundle has a development identity.");
    expect(build).toContain("Native build has a worktree label.");
    expect(build).toContain("Frontend build stamp missing or labelled.");
    expect(build).toContain("Updater signing ran before Authenticode.");
    expect(build).not.toContain("offline");
  });

  it("requires Authenticode and updater verification for every staged installer", () => {
    const authenticode = step("Verify Authenticode and replace unsigned installers");
    expect(authenticode).toContain("$signed.Count -ne $installers.Count");
    expect(authenticode).toContain("foreach ($installer in $installers)");
    expect(authenticode).toContain("$match.Count -ne 1");
    expect(authenticode).toContain("$signature.Status -ne 'Valid'");
    expect(authenticode).toContain("$signature.SignerCertificate.Subject.Contains($env:EXPECTED_AUTHENTICODE_SUBJECT)");
    const sign = step("Sign final installers for the Tauri updater");
    expect(sign).toContain("foreach ($artifact in ($env:INSTALLERS | ConvertFrom-Json))");
    expect(sign).toContain("signer sign --password '' $installer");
    const updater = step("Verify updater signatures and generate latest.json and latest-allusers.json");
    expect(updater).toContain("foreach ($artifact in ($env:INSTALLERS | ConvertFrom-Json))");
    expect(updater).toContain("pnpm exec tsx tools/release/verify-windows-updater.ts $installer");
    expect(updater).toContain("'--out', (Join-Path release-assets $artifact.Feed)");
    expect(updater).toContain("pnpm -s release:windows-manifest @manifestArgs");
    expect(updater.indexOf("'signed=true'")).toBeGreaterThan(updater.indexOf("Windows update manifest generation failed"));
  });

  it("retains missing-key and draft-only upload guards for the whole artifact set", () => {
    expect(step("Check signing availability")).toContain("Skipping updater .sig files, latest.json and latest-allusers.json");
    expect(step("Upload unsigned installers for SignPath provenance")).toContain("path: release-assets/*.exe");
    expect(step("Upload final release artifacts")).toContain("path: release-assets/*");
    expect(step("Require verified signatures before release upload")).toContain("$env:AUTHENTICODE_SIGNED -ne 'true' -or $env:UPDATER_SIGNED -ne 'true'");
    const upload = step("Upload only to an existing draft release");
    expect(upload).toContain('$env:RELEASE_TAG -cne "v$env:VERSION"');
    expect(upload).toContain("$release.isDraft -ne $true");
    expect(upload).toContain("Get-ChildItem release-assets -File");
    expect(upload).toContain("gh release upload $env:RELEASE_TAG @assets --clobber");
  });
});

describe("shared Windows update manifest generator", () => {
  it.each(["", "-allusers"])("keeps the signed installer URL for suffix '%s'", (suffix) => {
    const input = {
      version: "1.2.3",
      installerFileName: `ChemDraft_1.2.3_x64${suffix}-setup.exe`,
      signature: "  signature-for-this-installer\n",
      publishedAt: new Date("2026-11-02T12:00:00Z")
    };
    expect(buildWindowsUpdateManifest(input).platforms[WINDOWS_PLATFORM_KEY]).toEqual({
      signature: "signature-for-this-installer",
      url: `https://github.com/jgassens/ChemDraft/releases/download/v1.2.3/${input.installerFileName}`
    });
    expect(() => buildWindowsUpdateManifest({ ...input, version: "1.2.4" })).toThrow(/not the 1.2.4 build/);
    expect(() => buildWindowsUpdateManifest({ ...input, version: "v1.2.3" })).toThrow(/not a version/);
    expect(() => buildWindowsUpdateManifest({ ...input, signature: " " })).toThrow(/empty/);
    expect(() => buildWindowsUpdateManifest({ ...input, installerFileName: `ChemDraft (dev)_1.2.3_x64${suffix}-setup.exe` })).toThrow(/branch build/);
  });
});
