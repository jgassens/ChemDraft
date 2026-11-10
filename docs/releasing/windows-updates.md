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

## Choose an installer

Both NSIS installers ship the same ChemDraft version from the same commit:

| Installer | Use | Default program location | Update feed |
| --- | --- | --- | --- |
| `ChemDraft_<ver>_x64-setup.exe` | Personal installation, no admin required | `%LOCALAPPDATA%\ChemDraft` | `latest.json` |
| `ChemDraft_<ver>_x64-allusers-setup.exe` | Managed or shared machines; available to every account | `C:\Program Files\ChemDraft` | `latest-allusers.json` |

The all-users installer creates an all-users Start Menu shortcut and requires administrator rights
for installation, uninstallation, and **every update**, including updates accepted inside ChemDraft.
On a normal unelevated launch it requests UAC elevation; a standard user sees an **admin-credentials
UAC prompt** and needs an administrator to supply credentials. Passive mode does not suppress UAC.
If credentials are unavailable, choose Later and ask the machine administrator to deploy the update.

For silent deployment, run this from an **elevated prompt**:

```text
ChemDraft_<ver>_x64-allusers-setup.exe /S
```

The all-users build reads its own feed, which always points at the all-users installer. The existing
per-user installer, filename and `latest.json` channel are unchanged. Installing both on one machine
gives **two copies**; uninstall one first before switching scope. The installers do not migrate or
remove the other copy. Both register `.chemdraft` only; a retained per-user association can override
the machine association. See the [scope audit](../architecture/windows-installer-scope.md).

## Why installed plugins and settings survive

The installer replaces the program files in `%LOCALAPPDATA%\ChemDraft` (per-user) or
`C:\Program Files\ChemDraft` (all-users). Plugins, settings, and the
document session live in the app data directory, which is keyed by the identifier and never touched
by a normal update. These remain per Windows account even when program files are shared. They are
there on the next launch, as on macOS.

## Checked-in configuration

The shared NSIS installer hook quotes both the executable path and `.chemdraft` document argument
for both installation scopes, so paths containing spaces remain openable.

- **Crate:** `tauri-plugin-updater` 2.12.0, `cfg(windows)` only (Apache-2.0 OR MIT).
- **Frontend package:** `@tauri-apps/plugin-updater` 2.12.0 (Apache-2.0 OR MIT).
- **Per-user feed:** `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest.json`.
- **All-users feed:** `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest-allusers.json`.
  Both sit next to the macOS `appcast.xml` and `appcast-intel.xml`; joint releases use the same
  commit and version for both DMGs and both Windows installers.
- **All-users overlay:** `apps/desktop/src-tauri/tauri.allusers.conf.json`, passed with `--config`
  in the release workflow. It sets NSIS `installMode: "perMachine"` and the separate feed. Both
  installers use the association quoting hook at `windows/installer-hooks.nsh` from the Windows
  config, along with its updater public key and passive update mode.
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

This is the only release path (owner rule, 2026-10-22). The manual-dispatch [Windows release workflow](../../.github/workflows/windows-release.yml) builds
both installers on `windows-latest`, optionally Authenticode-signs the CI artifacts through SignPath
Foundation, then signs each installer's **final bytes** for the Tauri updater and generates
`latest.json` and `latest-allusers.json` with the existing `release:windows-manifest` generator.
The [signing guide](windows-signing.md) covers the owner's SignPath application, trusted build setup,
repository secrets/variables, workflow inputs and release checks.

Dispatch on the release tag with the same tag in `ref`; optionally provide a tracked Windows notes
file and an existing draft release tag in `upload_to_release`. The final `windows-release` artifact
contains both installers, each `.exe.build.json` and `.exe.sig`, both feeds, and checksums. Missing signing secrets produce
explicit warnings and dry-run output. Optional uploads refuse published releases; the workflow never
publishes a release or commits the feeds. Collect both DMGs and both Windows installers with their
`.build.json` records
and run the [joint release body check](three-builds.md) against the release tag, declaring gaps or
`--no-gaps`. As the last step before un-drafting on a Mac, run both DMG verifiers with
`--release --dmg` as listed in [the final checklist](three-builds.md#last-step-before-un-drafting), and require
`node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>` to report PASS
over the attached GitHub assets without skip or incomplete flags. The workflow runs the asset
checker after upload inside the same draft-visible job, explicitly skipping mounted DMG provenance
on Windows. Wholly missing build pairs produce INCOMPLETE; every supplied build is still checked.
A Windows-only upload is not a publishing pass.
Publish the joint release only after the strict gate passes, then **commit `latest-allusers.json`
together with `latest.json` to `main` at each release**, only after both installer URLs work.
Never point an all-users feed entry at the per-user installer. Build records bind SHA-256 and size
to the final signed bytes.

The workflow's variant list shares build/rename, identity and license checks, build records,
signing, verification and upload.
Tauri initially names each installer `ChemDraft_<ver>_x64-setup.exe`; the workflow stages it with
the variant suffix before the next build overwrites that output. Adding a future variant with no
feed requires a variant entry and config; it still goes through signing and upload.

To regenerate the all-users feed from its already signed CI artifact:

```text
pnpm -s release:windows-manifest --version X.Y.Z --installer "release-assets/ChemDraft_X.Y.Z_x64-allusers-setup.exe" --out release-assets/latest-allusers.json --notes release-notes.md
```

The same version, branch-build, and missing/empty-signature guards apply to both installers. The
signature is verified against the inherited updater public key before either generated feed is
included in the signed workflow output.

### Windows VM path (retired)

Retired for all installer builds (owner rule, 2026-10-22): use only installers built by the GitHub
Actions path above, including for Windows testing. The historical commands below explain the
per-user artifact and feed; do not run installer builds locally or in a VM. An updater signature
does not provide Authenticode signing. If Authenticode
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

4. Commit `latest.json` and `latest-allusers.json` together to `main` **only after** both release assets are downloadable. An app that sees
   the feed first would fail its download. Do not hand-edit a generated entry: the signature covers
   the installer bytes, not the file name.

## Verification

An end-to-end test needs two signed stable CI builds with increasing versions and a local feed.
Run it separately for each installer scope; do not install both copies at once:

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
5. Uninstall the test build. The NSIS installer remembers the folder it last installed to, so a
   silent install (`/S`) without `/D=<folder>` reuses that remembered folder instead of the default
   per-user location. After installing a test build into a separate folder with `/D=...`, pass
   `/D=%LOCALAPPDATA%\ChemDraft` explicitly when reinstalling the stable release (or it lands in the
   test folder); `/D` must be the last argument and must not be quoted.

For all-users verification, retain the all-users overlay on both CI builds and override its endpoint
with the local `latest-allusers.json` feed. Check Program Files and the all-users Start Menu shortcut,
then run ChemDraft as a standard user. Verify the quoted HKLM `.chemdraft` command with spaces in the
document path, and use OPSIN, the naming engine, installed plugins and the 3D sidecar without writes
to Program Files. Accept an update with administrator credentials and confirm it replaces the machine
copy, restores the drawing in the original account, and creates no `%LOCALAPPDATA%\ChemDraft` copy.
Also check an administrator's UAC consent, cancellation, silent deployment from an elevated prompt,
and uninstall. These all-users runtime checks remain unverified; the historical run below covered
only the per-user updater.

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
