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

The default tag is `vX.Y.Z`. The command peels annotated tags to their commit and fetches an absent
local tag from `origin`; a fetch or resolution failure is fatal. `--commit <full-sha>` adds an
explicit assertion and **never overrides** the tag. If both are present they must agree. No artifact
record can substitute for an expected commit. Complete the production signature checks in
[macos-updates.md](macos-updates.md) and [windows-signing.md](windows-signing.md) too.

## Last step before un-drafting

1. Upload the final artifacts, their three records, updater signatures and generated feeds to the
   existing draft release. Run the platform acceptance checks in the platform guides.
2. Set the reviewed release body. Immediately before un-drafting, from a checkout of the release
   source with `gh` authenticated, run the strict gate over **the assets attached to GitHub**:

   ```text
   node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>
   ```

   This downloads all assets with `gh release download` to a temporary directory and cleans it up.
   It requires exactly the three expected builds and their records, refuses extra builds or records,
   recomputes hashes and sizes, and checks common source identity against the tag's commit.
   An absent local tag is fetched or the command fails. No npm dependencies or native tools are
   needed. For an already-downloaded complete folder, add `--assets path/to/downloaded`; without
   a tag, folder checks require `--version X.Y.Z --commit <full-sha>` and cannot attest tag identity.
3. **Un-draft only after the strict attached-asset command reports PASS.** Do not change assets
   between that pass and publishing; rerun it after any replacement. Then land generated feeds
   through the normal PR flow once their artifact URLs are publicly reachable.

The Windows upload workflow runs this checker in a final job. If any platform's artifact or record
is absent, its `--allow-incomplete` mode lists missing filenames and does not fail a Windows-only
upload. That result explicitly says INCOMPLETE and is **not permission to un-draft**. When all six
files exist, any invalid record, hash, size, extra build or tag mismatch fails the job. If Mac assets
arrive later, run the strict command above; the prior incomplete job is not a publishing pass.
The final checker verifies bytes and source identity on Linux, Windows and macOS; mounted app
provenance and production signing/notarization remain mandatory macOS checks before uploading.
