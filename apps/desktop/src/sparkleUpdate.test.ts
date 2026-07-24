import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readRepositoryFile = (path: string) => readFileSync(`${repositoryRoot}/${path}`, "utf8");

describe("Sparkle macOS updates", () => {
  it("bundles the pinned Sparkle bridge and starts it only on macOS", () => {
    const cargo = readRepositoryFile("apps/desktop/src-tauri/Cargo.toml");
    const config = JSON.parse(readRepositoryFile("apps/desktop/src-tauri/tauri.conf.json"));
    const buildScript = readRepositoryFile("apps/desktop/src-tauri/build.rs");
    const rust = readRepositoryFile("apps/desktop/src-tauri/src/lib.rs");

    expect(cargo).toContain("tauri-plugin-sparkle-updater = \"=0.2.4\"");
    expect(config.bundle.macOS.frameworks).toContain("./Sparkle.framework");
    expect(buildScript).toContain("stage_sparkle_framework_for_cargo_executables");
    expect(rust).toContain("builder.plugin(tauri_plugin_sparkle_updater::init())");
    expect(rust).toContain('#[cfg(target_os = "macos")]');
  });

  it("checks automatically, offers rather than silently installs, and exposes the File command", () => {
    const infoPlist = readRepositoryFile("apps/desktop/src-tauri/Info.plist");
    const rust = readRepositoryFile("apps/desktop/src-tauri/src/lib.rs");
    const menuCommandBlock = rust.slice(
      rust.indexOf("const MENU_COMMAND_IDS"),
      rust.indexOf("];", rust.indexOf("const MENU_COMMAND_IDS"))
    );

    expect(infoPlist).toMatch(/<key>SUEnableAutomaticChecks<\/key>\s*<true\/>/);
    expect(infoPlist).toMatch(/<key>SUAutomaticallyUpdate<\/key>\s*<false\/>/);
    expect(infoPlist).toContain("https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast.xml");
    expect(infoPlist).toMatch(/<key>SUPublicEDKey<\/key>\s*<string>[^<]+<\/string>/);
    expect(rust).toContain('const CHECK_FOR_UPDATES_COMMAND_ID: &str = "app.checkForUpdates";');
    expect(rust).toContain('"Check for Updates…"');
    expect(rust).toContain("updater.check_for_updates()");
    expect(menuCommandBlock).not.toContain("app.checkForUpdates");
  });

  it("signs the framework-root Sparkle helpers for notarization in both provisioning paths", () => {
    const prepareScript = readRepositoryFile("scripts/prepare-sparkle.sh");

    // The helpers live at the framework version root, so neither `codesign --deep` nor the
    // bundler's framework signing reaches them; notarization rejects the app unless the prepare
    // script signs them itself whenever a Developer ID identity is configured.
    expect(prepareScript).toContain('if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then');
    expect(prepareScript).toContain(
      "codesign --force --options runtime --timestamp \\\n      --sign \"$APPLE_SIGNING_IDENTITY\" \"$sparkle_executable\""
    );
    expect(prepareScript).toContain('"$FRAMEWORK_DIR/Versions/B/Updater.app/Contents/MacOS/Updater"');
    expect(prepareScript).toContain('"$FRAMEWORK_DIR/Versions/B/Updater.app"');
    expect(prepareScript).toContain('"$FRAMEWORK_DIR/Versions/B/Autoupdate"');
    // Both the already-provisioned early exit and a fresh download must sign before reporting ready.
    const readyMessages = prepareScript.split("sign_sparkle_helper_executables\n  echo \"Sparkle ${SPARKLE_VERSION} is ready.\"").length - 1;
    const freshPathSigning = prepareScript.includes(
      "sign_sparkle_helper_executables\necho \"Sparkle ${SPARKLE_VERSION} is ready.\""
    );
    expect(readyMessages).toBe(1);
    expect(freshPathSigning).toBe(true);
  });

  it("keeps installed plugins in Application Support outside the replaceable app bundle", () => {
    const installedPlugins = readRepositoryFile("apps/desktop/src-tauri/src/installed_plugins.rs");

    expect(installedPlugins).toContain(".app_data_dir()");
    expect(installedPlugins).toContain("dir.join(INSTALLED_PLUGINS_DIR)");
    expect(installedPlugins).toContain('pub const INSTALLED_PLUGINS_DIR: &str = "installed-plugins";');
  });
});
