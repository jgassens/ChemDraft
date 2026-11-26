# Check and publish three required builds and optional Linux beta packages

Every release ships an Apple-silicon DMG, an Intel DMG, and a Windows x64 NSIS installer. The
Windows build comes as three installers from the same workflow run: per-user, all-users, and
all-users offline (WebView2 bundled); all three are required.
Linux is an optional, community-tested beta indefinitely; macOS and Windows releases never wait on
Linux. Its `.deb` and AppImage may be attached when available. If either package or build record is
attached, the release must include both Linux packages and both records. Every supplied build is
validated against the same commit and version. Keep the GitHub release **draft** throughout
verification. Both the release body check and the final attached-asset gate below must pass.

## Record the final bytes

After signing, notarization and stapling have finished, collect the three required packages and their
records, the Windows `.exe.sig` files, `latest.json`, `latest-allusers.json`, and both generated
appcasts in one staging directory.

- `ChemDraft_X.Y.Z_aarch64.dmg` and `ChemDraft_X.Y.Z_aarch64.dmg.build.json`
- `ChemDraft_X.Y.Z_x86_64.dmg` and `ChemDraft_X.Y.Z_x86_64.dmg.build.json`
- `ChemDraft_X.Y.Z_x64-setup.exe` and `ChemDraft_X.Y.Z_x64-setup.exe.build.json`
- `ChemDraft_X.Y.Z_x64-allusers-setup.exe` and `ChemDraft_X.Y.Z_x64-allusers-setup.exe.build.json`
- `ChemDraft_X.Y.Z_x64-allusers-offline-setup.exe` and
  `ChemDraft_X.Y.Z_x64-allusers-offline-setup.exe.build.json` (no `.exe.sig` and no feed)

For a release that includes the Linux beta (`X.Y.Zβ`, under the same `vX.Y.Z` tag), add both pairs.
The `.deb`'s package version is `X.Y.Z~beta`.

- `ChemDraft_X.Y.Z-beta_amd64.deb` and `ChemDraft_X.Y.Z-beta_amd64.deb.build.json`
- `ChemDraft_X.Y.Z-beta_amd64.AppImage` and `ChemDraft_X.Y.Z-beta_amd64.AppImage.build.json`

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
When including Linux, the [Linux workflow](linux.md#releasing) builds and records both packages. After smoke tests
pass, it uploads them to the existing draft when `upload_to_release` is set; otherwise download
`linux-release-amd64` and upload the packages, records, and `SHA256SUMS-linux.txt` to the draft.
After all planned manual uploads and release upload workflows for the tag have finished, refresh the
combined checksums from the assets attached to the draft. Do not change the draft's assets between this refresh and publication. From the repository
root, with `gh` authenticated for the draft, run (replace the tag and commit and use a fresh output path):

```text
node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha> --skip-dmg-provenance --write-checksums path/to/SHA256SUMS.txt && gh release upload vX.Y.Z path/to/SHA256SUMS.txt --clobber
```

The combined `SHA256SUMS.txt` covers all other attached assets. Run the final Mac gate below after refreshing it.
The Windows workflow records source identity in the clean checkout and updates the hash and size
**after Authenticode signing**, retaining the recorded source identity. Any later byte change requires
a new record and new updater signatures/feeds.

## Combined release checksums

The Windows workflow creates and verifies an LF-only `SHA256SUMS.txt` for its staged artifact.
It uploads the Windows files without that local sums file, then downloads every attached asset,
regenerates the combined sums and uploads them with `gh release upload --clobber`. Recomputing from
the attached bytes retains Mac entries on Windows reruns and works in either upload order.
After all Mac and Windows uploads finish, regenerate and upload the final combined file:

```text
node tools/release/release-checksums.mjs --tag vX.Y.Z
node tools/release/release-checksums.mjs --tag vX.Y.Z --verify
```

Tag write mode downloads the complete release into a temporary folder, hashes every regular file
except `SHA256SUMS.txt` itself, and uploads the replacement sums before deleting the folder.
Each line is `lowercase-hash␠␠filename` with LF endings. `--tag ... --verify` only downloads and
checks the existing sums. `--assets path/to/release-assets` writes only a local file; if used instead,
upload it explicitly with `gh release upload vX.Y.Z path/to/release-assets/SHA256SUMS.txt --clobber`.
The final asset checker requires sums to cover exactly all downloaded release files. Keep uploads
idle during checksum generation and verification; after any asset change, regenerate and recheck.
Do not use Windows PowerShell text output to rewrite the combined file.

## Draft the body on macOS

Prepare `release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`,
`release-notes/macos-intel/ChemDraft_X.Y.Z_x86_64.md`, and `release-notes/windows-X.Y.Z.md`.
From the repository root on the release Mac run:

```text
node tools/release/draft-release-body.mjs --version X.Y.Z --tag vX.Y.Z --assets path/to/staging --no-gaps --out release-body.md
```

Use `--no-gaps` only after explicitly checking feature parity. Otherwise replace it with one or
more `--gap "macos:feature and reason"`, `--gap "macos-intel:feature and reason"`, or
`--gap "windows:feature and reason"`. Use `--gap "linux:feature and reason"` when the Linux section
is included. The tool requires at least one valid `--gap` or `--no-gaps` and rejects using both
together. A gap must name a platform and provide single-line text.
The generator includes `## Linux` when both Linux packages and records are present and verified.
Passing `--include-linux` requires that complete verified set. Add any release-specific Linux notes
to that section and review the Platform differences note before setting the body on the draft.
Without `--assets`, the current directory is checked; without `--out`, the body goes to stdout.

The body command checks every supplied record for the same commit, the requested version,
`clean: true`, and the appropriate target (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
`x86_64-pc-windows-msvc`, or `x86_64-unknown-linux-gnu` for both Linux packages). It recomputes
SHA-256 and byte size for every artifact. It mounts each DMG read-only, reads each app's `Info.plist`,
and requires `ChemDraftSourceCommit` to match the expected source commit. Release DMGs must embed
this key before signing. This command therefore needs macOS, `hdiutil` and `plutil`.

The default tag is `vX.Y.Z`. The command always fetches the tag from `origin`, even if it exists
locally, and peels the fetched `FETCH_HEAD` to its commit. A fetch or resolution failure (including a
conflicting local tag) is fatal. `--commit <full-sha>` adds an
explicit assertion and **never overrides** the tag. If both are present they must agree. No artifact
record can substitute for an expected commit. Complete the production signature checks in
[macos-updates.md](macos-updates.md) and [windows-signing.md](windows-signing.md) too.

## Last step before un-drafting

1. Upload the final artifacts, their records, updater signatures and generated feeds to the
   existing draft release. Run the platform acceptance checks in the platform guides.
2. Set the reviewed release body. Immediately before un-drafting, **on a Mac**, from a checkout of
   the release source with `gh` authenticated to read and upload draft assets and `APPLE_TEAM_ID`
   exported, regenerate and upload the combined sums, then download the final assets to a new,
   empty folder. The checksum upload and all three verification commands below are mandatory:

   ```text
   node tools/release/release-checksums.mjs --tag vX.Y.Z
   gh release download vX.Y.Z --dir path/to/final-download
   node tools/release/verify-macos-app.mjs --target aarch64-apple-darwin --release --dmg path/to/final-download/ChemDraft_X.Y.Z_aarch64.dmg --commit <full-sha>
   node tools/release/verify-macos-app.mjs --target x86_64-apple-darwin --release --dmg path/to/final-download/ChemDraft_X.Y.Z_x86_64.dmg --commit <full-sha>
   node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>
   ```

   The checksum command uploads `SHA256SUMS.txt` covering every attached asset before the final
   checker downloads it. The two release verifiers mount the downloaded DMGs read-only, verify the
   apps inside, and check each DMG's staple and Gatekeeper assessment. The process staples only the DMG, never requiring
   an app staple. The final asset command downloads all assets again to a temporary directory and cleans it up.
   It requires both DMGs, the three Windows installers, and their records. It validates the optional Linux
   packages when present and rejects partial Linux sets and extra builds or records, including
   unexpected `.deb`, `.AppImage`, `.sig`, `.msi`, `.zip`, `.pkg` and `.tar.gz` files (only the
   per-user and all-users `.exe.sig` files, `latest.json` and `latest-allusers.json` are allowed
   updater assets; an offline `.exe.sig` is refused). For each of the two updater installers it
   requires its `.exe.sig` and feed (`latest.json` per-user, `latest-allusers.json` all-users),
   checks the manifest version, exact `windows-x86_64-nsis` platform key and that installer's release
   download URL, and requires the manifest signature to match its `.exe.sig`. It verifies that
   signature against the final installer bytes, including the Minisign key ID and authenticated comment, using
   `plugins.updater.pubkey` from the checked-in `apps/desktop/src-tauri/tauri.windows.conf.json`.
   These updater checks run offline on both platforms. It recomputes hashes and sizes, mounts
   every DMG to compare its embedded commit with its record and the expected commit, and checks common
   source identity against the freshly fetched origin tag. It needs macOS, `hdiutil` and `plutil`, but
   no npm dependencies. For an already-downloaded complete folder, add `--assets path/to/downloaded`; without
   a tag, folder checks require `--version X.Y.Z --commit <full-sha>` and cannot attest tag identity.
3. **Un-draft only after both release verifiers succeed and the strict attached-asset command reports PASS.** Do not change assets
   between that pass and publishing; regenerate and upload sums and rerun verification after any
   replacement. Then land generated feeds through the normal PR flow once their artifact URLs are publicly reachable.

The Windows workflow runs this checker **inside the upload job after uploading**, with its existing
`contents: write` token so draft assets are visible. Other jobs retain read access. Its
`--allow-incomplete` mode permits wholly missing macOS or Windows artifact/record pairs and lists
their missing filenames, while fully checking every supplied build. A supplied per-user or all-users installer
still requires its verified `.exe.sig` and matching `latest.json` or `latest-allusers.json`. The
checker can defer Windows when its installers, records and updater assets are all absent.
Partial pairs, invalid records, hashes, sizes, extra builds
and tag mismatches fail even in incomplete mode. INCOMPLETE is **not permission to un-draft**.

On Linux and Windows, the checker prints that embedded DMG provenance was skipped and requires
`--skip-dmg-provenance` to proceed; the Windows workflow passes it. macOS always mounts each DMG.
The final manual publishing gate above must run on a Mac **without `--allow-incomplete` or
`--skip-dmg-provenance`**, including when Mac assets arrive after the Windows upload.
