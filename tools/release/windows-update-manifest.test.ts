import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_PLATFORM_KEY, buildWindowsUpdateManifest, main, type UpdateManifest } from "./windows-update-manifest";

const publishedAt = new Date("2026-09-25T18:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildWindowsUpdateManifest", () => {
  it("writes the static manifest shape tauri-plugin-updater reads, keyed for an NSIS build", () => {
    const manifest = buildWindowsUpdateManifest({
      version: "0.3.6",
      installerFileName: "ChemDraft_0.3.6_x64-setup.exe",
      signature: "  dW50cnVzdGVk...  \n",
      notes: "  Faster export.\n",
      publishedAt
    });
    expect(manifest).toEqual({
      version: "0.3.6",
      notes: "Faster export.",
      pub_date: "2026-09-25T18:00:00.000Z",
      platforms: {
        [WINDOWS_PLATFORM_KEY]: {
          signature: "dW50cnVzdGVk...",
          url: "https://github.com/jgassens/ChemDraft/releases/download/v0.3.6/ChemDraft_0.3.6_x64-setup.exe"
        }
      }
    });
    expect(WINDOWS_PLATFORM_KEY).toBe("windows-x86_64-nsis");
  });

  it("leaves notes out rather than publishing an empty string", () => {
    const manifest = buildWindowsUpdateManifest({
      version: "0.3.6",
      installerFileName: "ChemDraft_0.3.6_x64-setup.exe",
      signature: "sig",
      notes: "   ",
      publishedAt
    });
    expect("notes" in manifest).toBe(false);
  });

  it("refuses the mistakes that would ship a broken or wrong update", () => {
    const base = { installerFileName: "ChemDraft_0.3.6_x64-setup.exe", signature: "sig", publishedAt };
    expect(() => buildWindowsUpdateManifest({ ...base, version: "v0.3.6" })).toThrow(/not a version/);
    expect(() => buildWindowsUpdateManifest({ ...base, version: "0.3.7" })).toThrow(/not the 0.3.7 build/);
    expect(() =>
      buildWindowsUpdateManifest({ ...base, version: "0.3.6", installerFileName: "ChemDraft (dev)_0.3.6_x64-setup.exe" })
    ).toThrow(/branch build/);
    expect(() => buildWindowsUpdateManifest({ ...base, version: "0.3.6", signature: " \n" })).toThrow(/empty/);
  });
});

describe("the CLI", () => {
  it("reads the installer's .sig and writes latest.json", () => {
    const root = mkdtempSync(join(tmpdir(), "chemdraft-manifest-"));
    roots.push(root);
    const installer = join(root, "ChemDraft_0.3.6_x64-setup.exe");
    writeFileSync(installer, "installer bytes");
    writeFileSync(`${installer}.sig`, "c2lnbmF0dXJl\n");
    const out = join(root, "latest.json");

    main(["--version", "0.3.6", "--installer", installer, "--out", out]);
    const written = JSON.parse(readFileSync(out, "utf8")) as UpdateManifest;
    expect(written.version).toBe("0.3.6");
    expect(written.platforms[WINDOWS_PLATFORM_KEY].signature).toBe("c2lnbmF0dXJl");
  });

  it("explains a missing signature instead of writing an unverifiable manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "chemdraft-manifest-"));
    roots.push(root);
    const installer = join(root, "ChemDraft_0.3.6_x64-setup.exe");
    writeFileSync(installer, "installer bytes");
    expect(() => main(["--version", "0.3.6", "--installer", installer, "--out", join(root, "latest.json")])).toThrow(
      /No signature/
    );
  });
});
