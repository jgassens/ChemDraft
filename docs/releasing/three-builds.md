# Check and publish a joint release

Every release ships exactly one Apple-silicon DMG, one Intel DMG and one Windows x64 NSIS
installer, built from the same commit and version. Keep the GitHub release **draft** throughout
verification. Both the release body check and the final attached-asset gate below must pass.

## Record the final bytes

After signing, notarization and stapling have finished, collect the two DMGs, Windows installer,
its `.exe.sig`, `latest.json`, and both generated appcasts in one staging directory. Include:

- `ChemDraft_X.Y.Z_aarch64.dmg.build.json`
- `ChemDraft_X.Y.Z_x86_64.dmg.build.json`
- `ChemDraft_X.Y.Z_x64-setup.exe.build.json`

Every record contains `commit` (full 40-character SHA), `version`, `target` (target triple),
`clean: true`, `sha256` (lowercase hexadecimal SHA-256 of the artifact), and `size` (byte count).
For each Mac DMG, run `node tools/release/record-build.mjs --artifact <final.dmg> --target <triple>`
**after the final staple**, as shown in [macos-updates.md](macos-updates.md). Recording refuses a
dirty source tree, including staged changes and untracked files; keep staging outside the source tree.
Recording a DMG mounts it read-only and refuses an app whose embedded `ChemDraftSourceCommit`
differs from the checkout's HEAD. This requires macOS; an adjacent record cannot establish payload provenance.
Recording, feed verification, appcast generation, release body drafting and the final Mac publishing
gates also refuse an unsigned stamp (`ChemDraftUnsignedBuild` present with a value other than `false`), from
the [local-only unsigned stable escape](macos-updates.md#local-unsigned-stable-rebuilds-never-publish).
Those builds must never be published, even if subsequently signed or given matching build records.
The Windows workflow records source identity in the clean checkout and updates the hash and size
**after Authenticode signing**, retaining the recorded source identity. Any later byte change requires
a new record and new updater signatures/feeds.

## Draft the body on macOS

Prepare `release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`,
`release-notes/macos-intel/ChemDraft_X.Y.Z_x86_64.md`, and `release-notes/windows-X.Y.Z.md`.
From the repository root on the release Mac run:

```text
node tools/release/draft-release-body.mjs --version X.Y.Z --tag vX.Y.Z --assets path/to/staging --no-gaps --out release-body.md
```

Use `--no-gaps` only after explicitly checking feature parity. Otherwise replace it with one or
more `--gap "macos:feature and reason"`, `--gap "macos-intel:feature and reason"`, or
`--gap "windows:feature and reason"`. Neither choice, or both choices together, is an error.
Review the resulting body; each platform has its own notes and any declared gaps.
Without `--assets`, the current directory is checked; without `--out`, the body goes to stdout.

The body command requires all three records to name the same commit, the requested version,
`clean: true`, and the appropriate target (`aarch64-apple-darwin`, `x86_64-apple-darwin`, or
`x86_64-pc-windows-msvc`). It recomputes SHA-256 and byte size for every artifact. It mounts each
DMG read-only, reads each app's `Info.plist`, and requires `ChemDraftSourceCommit` to match the
expected source commit. Release DMGs must embed this key before signing; only non-release app
builds may omit it. This command therefore needs macOS, `hdiutil` and `plutil`.

The default tag is `vX.Y.Z`. The command always fetches the tag from `origin`, even if it exists
locally, and peels the fetched `FETCH_HEAD` to its commit. A fetch or resolution failure (including a
conflicting local tag) is fatal. `--commit <full-sha>` adds an
explicit assertion and **never overrides** the tag. If both are present they must agree. No artifact
record can substitute for an expected commit. Complete the production signature checks in
[macos-updates.md](macos-updates.md) and [windows-signing.md](windows-signing.md) too.

## Last step before un-drafting

1. Upload the final artifacts, their three records, updater signatures and generated feeds to the
   existing draft release. Run the platform acceptance checks in the platform guides.
2. Set the reviewed release body. Immediately before un-drafting, **on a Mac**, from a checkout of
   the release source with `gh` authenticated to read drafts and `APPLE_TEAM_ID` exported, download
   the final assets to a new, empty folder. All three verification commands below are mandatory:

   ```text
   gh release download vX.Y.Z --dir path/to/final-download
   node tools/release/verify-macos-app.mjs --target aarch64-apple-darwin --release --dmg path/to/final-download/ChemDraft_X.Y.Z_aarch64.dmg --commit <full-sha>
   node tools/release/verify-macos-app.mjs --target x86_64-apple-darwin --release --dmg path/to/final-download/ChemDraft_X.Y.Z_x86_64.dmg --commit <full-sha>
   node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>
   ```

   The two release verifiers mount the downloaded DMGs read-only, verify the apps inside, and check
   each DMG's staple and Gatekeeper assessment. The process staples only the DMG, never requiring
   an app staple. The final asset command downloads all assets again to a temporary directory and cleans it up.
   It requires exactly the three expected builds and their records, refuses extra builds or records,
   including unexpected `.sig`, `.msi`, `.zip`, `.pkg` and `.tar.gz` files (only the expected Windows
   `.exe.sig` and `latest.json` are allowed updater assets). It requires both Windows updater files,
   checks the manifest version, exact `windows-x86_64-nsis` platform key and release download URL,
   and requires the manifest signature to match the `.exe.sig`. It verifies that signature against
   the final installer bytes, including the Minisign key ID and authenticated comment, using
   `plugins.updater.pubkey` from the checked-in `apps/desktop/src-tauri/tauri.windows.conf.json`.
   These updater checks run offline on both platforms. It recomputes hashes and sizes, mounts
   every DMG to compare its embedded commit with its record and the expected commit, and checks common
   source identity against the freshly fetched origin tag. It needs macOS, `hdiutil` and `plutil`, but
   no npm dependencies. For an already-downloaded complete folder, add `--assets path/to/downloaded`; without
   a tag, folder checks require `--version X.Y.Z --commit <full-sha>` and cannot attest tag identity.
3. **Un-draft only after both release verifiers succeed and the strict attached-asset command reports PASS.** Do not change assets
   between that pass and publishing; rerun it after any replacement. Then land generated feeds
   through the normal PR flow once their artifact URLs are publicly reachable.

The Windows workflow runs this checker **inside the upload job after uploading**, with its existing
`contents: write` token so draft assets are visible. Other jobs retain read access. Its
`--allow-incomplete` mode permits wholly missing artifact/record pairs and lists the missing filenames,
while fully checking every supplied build. A supplied Windows installer still requires its verified
`.exe.sig` and matching `latest.json`; only a wholly absent Windows build and updater files may be deferred.
Partial pairs, invalid records, hashes, sizes, extra builds
and tag mismatches fail even in incomplete mode. INCOMPLETE is **not permission to un-draft**.

On Linux and Windows, the checker prints that embedded DMG provenance was skipped and requires
`--skip-dmg-provenance` to proceed; the Windows workflow passes it. macOS always mounts each DMG.
The final manual publishing gate above must run on a Mac **without `--allow-incomplete` or
`--skip-dmg-provenance`**, including when Mac assets arrive after the Windows upload.
