# Windows Updates

- [ ] Run `node scripts/pin-external-tools.mjs --check` before a release; refresh pins if it differs.
- [ ] For any pin bump, run that check on both Windows and macOS; each run checks only its host platform.

ChemDraft on Windows updates itself with Tauri's updater (`tauri-plugin-updater`). It behaves like
the macOS Sparkle updater ([`macos-updates.md`](macos-updates.md)):

- A released app checks the signed update feed **at most once a day**, 15 seconds after launch.
- It **asks before installing**. It never installs silently.
- **File > Check for Updates…** starts the same check at any time, and reports "up to date" or any
  failure.

When the user accepts, ChemDraft downloads the installer and verifies its signature. It then **saves
the open document** and runs the installer in passive mode, which shows only a progress bar. The
installer closes ChemDraft and reopens it on the new version, with the document restored from the
session.

The save must come first, because on Windows the updater ends the process itself (`exit(0)`) and
skips the normal quit path. If the save fails, the update stops and the app stays open. See
`apps/desktop/src/appUpdates.ts`.

## Which builds update

- **Only the released app.** It is built from `main`, or with `CHEMDRAFT_STABLE_BUILD=1`, and has
  the identifier `org.chemdraft.desktop`.
- A branch build ("ChemDraft (dev)", with its own identifier) and a `pnpm dev` session never check.
  Choosing File > Check for Updates… in one says so in the status bar.

## Why installed plugins and settings survive

The installer replaces the program files in `%LOCALAPPDATA%\ChemDraft`. Plugins, settings, and the
document session live in the app data directory, which is keyed by the identifier and never touched
by the installer. They are there on the next launch, as on macOS.

## Checked-in configuration

- **Crate:** `tauri-plugin-updater` 2.12.0, `cfg(windows)` only (Apache-2.0 OR MIT).
- **Frontend package:** `@tauri-apps/plugin-updater` 2.12.0 (Apache-2.0 OR MIT).
- **Feed:** `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest.json`. It sits next to
  the macOS `appcast.xml`; joint releases use the same commit and version for both platforms.
- **Public key:** `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.windows.conf.json`.
- **Private key:** `%USERPROFILE%\.tauri\chemdraft-updater.key`.
  - It is outside the repository. Never commit it, and never print it.
  - It has no password, so the Windows account protects it, the way the login Keychain protects the
    Sparkle key.
  - Override its location with `CHEMDRAFT_UPDATER_KEY_PATH`. `TAURI_SIGNING_PRIVATE_KEY`, if set,
    wins over both.
  - CI uses the repository secret `TAURI_SIGNING_PRIVATE_KEY`, populated by the owner from this
    same key. See [Windows installer signing](windows-signing.md) for SignPath setup and secret handling.
- **Permission:** the document window alone gets `updater:default`, from
  `capabilities/app-updates.json`. That capability is marked `"platforms": ["windows"]`: the
  updater plugin exists only in Windows builds, and Tauri skips a capability for another platform
  before it resolves any permission name, so macOS builds never look `updater:default` up.

**Back up the private key.** Put the key file in your password manager, or another store you trust.
Without it, installed copies can never be updated again, and every user would have to download the
next installer by hand once.

## Publishing an update

The updater compares the installed app's version with the feed's `version`. Every Windows release
must therefore raise `version` in `apps/desktop/src-tauri/tauri.conf.json`, and must never reuse a
published version.

### GitHub Actions path

The manual-dispatch [Windows release workflow](../../.github/workflows/windows-release.yml) builds
the installer on `windows-latest`, optionally Authenticode-signs the CI artifact through SignPath
Foundation, then signs the **final installer bytes** for the Tauri updater and generates `latest.json`.
The [signing guide](windows-signing.md) covers the owner's SignPath application, trusted build setup,
repository secrets/variables, workflow inputs and release checks.

Dispatch on the release tag with the same tag in `ref`; optionally provide a tracked Windows notes
file and an existing draft release tag in `upload_to_release`. The final `windows-release` artifact
contains the installer, `.exe.sig`, `latest.json`, and checksums. Missing signing secrets produce
explicit warnings and dry-run output. Optional uploads refuse published releases; the workflow never
publishes a release or commits the feed. Review both platform artifacts from the same commit/version,
publish the joint release, then commit the generated feed to `main` only after its installer URL works.

### Existing Windows VM path

This path stays valid. Its updater signature does not provide Authenticode signing. If Authenticode
is applied separately, do it **before** the final `tauri signer sign` and manifest generation: an
existing `.sig` is invalid once any installer bytes change. SignPath Foundation requires verifiable
CI builds; submitting a VM-built installer through the workflow is not supported.

1. On `main` (or with `CHEMDRAFT_STABLE_BUILD=1`), with the key on this machine, build the installer:

   ```bash
   pnpm --filter @chemdraft/desktop build --bundles nsis
   ```

   The build prints `Stable build: signing the installer for the in-app updater.` and writes
   `ChemDraft_X.Y.Z_x64-setup.exe` plus `ChemDraft_X.Y.Z_x64-setup.exe.sig` to
   `apps/desktop/src-tauri/target/release/bundle/nsis/`. If it prints "without the updater key", the
   key was not found, and this installer cannot be published as an update.

2. Create GitHub release `vX.Y.Z` (it may already exist from the macOS release). Upload the exact
   `ChemDraft_X.Y.Z_x64-setup.exe`. The `.sig` does not need uploading, because its contents go into
   the feed.

3. Write the feed:

   ```bash
   pnpm release:windows-manifest --version X.Y.Z --installer "apps/desktop/src-tauri/target/release/bundle/nsis/ChemDraft_X.Y.Z_x64-setup.exe" --notes release-notes.md
   ```

   The script refuses a version with a leading `v`, an installer from a different version, a branch
   ("dev") installer, and a missing or empty signature.

4. Commit `latest.json` to `main` **only after** the release asset is downloadable. An app that sees
   the feed first would fail its download. Do not hand-edit a generated entry: the signature covers
   the installer bytes, not the file name.

## Verification

An end-to-end test needs two signed stable builds with increasing versions and a local feed:

1. Build the older version with an extra `--config` that points `plugins.updater.endpoints` at
   `http://127.0.0.1:<port>/latest.json` and sets `dangerousInsecureTransportProtocol: true`.
   Test builds only.
2. Build the newer version the same way, adding a `--config` that raises `version`.
3. Serve the newer installer, plus a `latest.json` from step 3 above whose URL points at the local
   server.
4. Install the older build and launch it. Success means:
   - the automatic check (or the menu item) offers the newer version;
   - accepting it downloads, saves the session, shows the passive installer, and reopens ChemDraft
     on the newer version;
   - a drawing made before the update is still there after the relaunch.
5. Uninstall the test build.

To drive the prompt from a script: it is a Windows task dialog, and on Windows 11 its buttons are
exposed to UI Automation as bare panes with no Invoke pattern. Find the window instead
(`FindWindow("#32770", "ChemDraft Update")`) and send it `TDM_CLICK_BUTTON` (`0x466`) with `IDOK`
(1) for "Install and Restart" or `IDCANCEL` (2) for "Later".

This was run on 2026-09-25 with signed 0.3.5 → 0.3.6 builds. The 0.3.5 app fetched the feed,
prompted with both versions and the notes, and downloaded and verified the installer. It then saved
the session and exited. ChemDraft 0.3.6 reopened 11 seconds later with the drawing intact, and its
own launch check found it up to date.

A tampered installer, or a manifest signed with another key, must fail the check with a signature
error and leave the app running. `appUpdates.test.ts` covers that path.
