# Windows installer signing in CI

`.github/workflows/windows-release.yml` builds ChemDraft's x64 NSIS installer on a GitHub-hosted
Windows runner. SignPath Foundation can Authenticode-sign that CI artifact after the owner completes
the account setup below. This workflow is the only Windows release path; the
[Windows VM path](windows-updates.md#windows-vm-path-retired) is retired for releases.

There are two independent signatures, in this order:

1. Build the stable installer with `CHEMDRAFT_STABLE_BUILD=1` and
   `CHEMDRAFT_SKIP_UPDATER_SIGNING=1`.
2. Upload the unsigned installer as `windows-nsis-unsigned`, submit its artifact ID to SignPath,
   wait for approval/completion, and download the signed installer. Require
   `Get-AuthenticodeSignature` to report `Valid` and the signer certificate subject to contain
   `EXPECTED_AUTHENTICODE_SUBJECT` before replacing the unsigned copy.
3. Use `tauri signer sign` to create the updater `.exe.sig` over that **final** installer.
4. Verify the updater signature against `plugins.updater.pubkey` in
   `apps/desktop/src-tauri/tauri.windows.conf.json`, then generate `latest.json` with
   `pnpm -s release:windows-manifest` and the optional Windows notes.
5. Update the adjacent build record's `sha256` and `size` to cover the final signed installer,
   preserving the clean-checkout source commit, version and target, then write checksums.

Authenticode changes the installer's bytes. Never Authenticode-sign, rebuild, or otherwise modify the
installer after creating its updater `.sig`; recreate and verify the `.sig` and manifest if it changes.
The opt-out is explicit: without it, VM builds retain their existing automatic updater signing.

## Owner setup for SignPath Foundation

The **repository owner must personally** complete these account and trust steps. No account, token,
certificate, or approval is supplied by the workflow.

1. Read the [Foundation conditions](https://signpath.org/terms) and
   [apply for free open-source signing](https://signpath.org/apply). ChemDraft's core uses the
   OSI-approved Apache-2.0 license. Supply the public `jgassens/ChemDraft` repository, project and
   download pages, release history, and the CI build workflow. All bundled components must meet
   the Foundation's licensing conditions; core licensing alone does not establish eligibility.
   Approval is the Foundation's decision.
2. After acceptance, create the ChemDraft project in the supplied SignPath organization. Publish the
   required code signing policy, attribution, named committers/reviewers/approvers and accurate
   privacy policy on the project/download pages. Enable MFA and nominate the people who will approve
   release signing requests.
   Drafts for owner review are [code signing policy](../../site/code-signing.html) and
   [privacy policy](../../site/privacy.html), supported by the
   [source network audit](code-signing-network-audit.md). Confirm the role names, signing status and
   unresolved privacy details before publishing; these drafts are not linked from the existing site.
3. Add GitHub.com as a trusted build system, install/authorize the SignPath GitHub integration for
   this repository, and link that trusted build system to the SignPath project. Follow the
   [official GitHub integration guide](https://docs.signpath.io/trusted-build-systems/github).
   Foundation signing verifies the artifact's CI origin in the public repository: uploading a
   manually built VM executable to CI does not substitute for building it there.
4. Create the project's default artifact configuration for the ZIP produced by
   `actions/upload-artifact@v4`: a ZIP containing exactly `ChemDraft_*_x64-setup.exe` at its root,
   with that installer selected for Authenticode signing. Set the required ChemDraft product/version
   metadata restrictions. The requested scope is the installer; do not configure signing of bundled
   third-party binaries. Use the Foundation-approved certificate and create a signing policy linked
   to the trusted GitHub build system, the repository and reviewed release refs. Require the
   Foundation's manual release approval. The workflow waits up to one hour for completion; failures
   fail the run rather than falling back to an unsigned installer.
5. Create a restricted submitter API token for that project/policy. Under GitHub **Settings → Secrets
   and variables → Actions**, add:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `SIGNPATH_API_TOKEN` | SignPath submitter API token |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | SignPath organization ID |
   | Variable | `SIGNPATH_PROJECT_SLUG` | ChemDraft project slug |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | Approved signing policy slug |
   | Variable | `EXPECTED_AUTHENTICODE_SUBJECT` | Required, case-sensitive substring of the expected signer certificate subject |

   SignPath Foundation certificates name the foundation as publisher. After the first signed run,
   inspect the logged certificate subject, confirm it matches the Foundation-approved certificate,
   and set `EXPECTED_AUTHENTICODE_SUBJECT` to the exact expected subject (or an identifying substring).
   That first run fails verification if the variable is unset; rerun after setting it. An unset or
   whitespace-only variable, invalid signature, or mismatched subject always fails the job.

6. Add the **existing updater key** as repository secret `TAURI_SIGNING_PRIVATE_KEY`. The owner
   copies the contents of `%USERPROFILE%\.tauri\chemdraft-updater.key` (or its protected backup)
   directly into the secret field. Never print it, paste it into a workflow, commit it, upload it
   as an artifact, or place its value on a command line. Keep the same public key: replacing the
   pair would strand installed apps. The current key has an empty password; the workflow passes
   that explicitly to the signer and trims surrounding whitespace from the secret.

The official SignPath action is pinned to the full commit SHA of its `v2` release.
Review action updates and trust policy changes as release infrastructure changes.

Set the GitHub repository variable `AUTHENTICODE_SIGNING` to `off` (case-insensitive) while the
release certificate is pending to skip Authenticode and keep `SIGNPATH_API_TOKEN` in place.
Once the release certificate is active, delete the variable or set it to `on` to resume signing.

## Run a release

Use a reviewed commit that has landed on the public repository's `main` branch, with the workflow
and signing tools present. Every release requires the Apple-silicon DMG, Intel DMG, and Windows
installer. Linux is an optional, community-tested beta indefinitely; macOS and Windows releases never
wait on Linux. Its `.deb` and AppImage may be attached when available. When included, both packages
and their records must pass the same checks for the commit, version and artifact bytes as the required
builds. The release body includes `## macOS (Apple silicon)`, `## macOS (Intel)`, and `## Windows`,
plus `## Linux` when the Linux packages are included. The Platform differences note names each feature
gap and its reason or says there are none. This workflow supplies the Windows artifacts only.

1. Set the app version before tagging, and prepare tracked Windows release notes if needed. Create
   the release tag and an **existing draft** GitHub release, for example `vX.Y.Z`.
2. In **Actions → Windows release → Run workflow**, select that tag as the workflow ref, enter the
   same tag in the required `ref` input, optionally enter `vX.Y.Z` in `upload_to_release`, and
   optionally enter a tracked repository notes path in `notes_file`. The CLI equivalent is:

   ```text
   gh workflow run windows-release.yml --ref vX.Y.Z -f ref=vX.Y.Z -f upload_to_release=vX.Y.Z -f notes_file=release-notes/windows-X.Y.Z.md
   ```

   Omit optional inputs when unused. A full commit SHA is also accepted for `ref`, provided the
   selected workflow branch/tag resolves to that same commit. Matching the dispatched workflow
   commit and checked-out source keeps SignPath's GitHub provenance accurate. Fork runs and mismatched
   source commits are refused before signing secrets are used. For a pre-merge dry run, select the
   reviewed workflow branch and pass its full SHA as `ref`, leaving `upload_to_release` empty.
3. Approve the signing request in SignPath when prompted. The runner installs Node 24, the repository
   pnpm version, the Rust version from `rust-toolchain.toml`, and Temurin JDK 21. It builds and
   smoke-tests OPSIN's host-native `jlink` runtime; the 3D sidecar is already committed.
4. Review the logs: stable identifier `org.chemdraft.desktop`, product `ChemDraft`, empty native
   worktree label, frontend commit stamp, `Authenticode: Valid` when Authenticode runs, updater
   verification, and final SHA-256 hashes and byte sizes. Build-time label checks inspect the native
   build output and built frontend assets. Install and launch the artifact on Windows to confirm its
   actual title and app identity and complete the update/session-preservation checks in [windows-updates.md](windows-updates.md#verification).
5. Download **`windows-release`**, which contains the final installer, its `.exe.build.json`,
   `.exe.sig`, `latest.json`, and `SHA256SUMS.txt`. The build record uses `git rev-parse HEAD`
   from the checked-out source and refuses a dirty tree; its SHA-256 and byte size cover the
   final installer. Keep it beside the installer.
   **`windows-nsis-unsigned` is input to SignPath, not the release installer.**
   For a local updater signature check, from the repository root run:

   ```text
   pnpm exec tsx tools/release/verify-windows-updater.ts path/to/ChemDraft_X.Y.Z_x64-setup.exe
   ```

6. If `upload_to_release` was supplied, a separate job downloads the final artifact and uses
   `gh release upload --clobber`. It verifies the staged Windows sums and excludes that local
   `SHA256SUMS.txt` from the upload so a rerun cannot overwrite combined sums with Windows-only entries.
   It refuses a missing or already published release, and requires
   `v<app version>` because the generated feed points to that URL. Before uploading it fetches
   and peels the destination tag and requires it to resolve to the built commit. A release upload
   requires a verified updater `.exe.sig` and generated `latest.json`, and it requires verified
   Authenticode unless `AUTHENTICODE_SIGNING` is `off`. The boolean input `allow_unsigned_upload`
   defaults to false. Setting it to true explicitly permits an upload with missing signatures and
   prints a loud workflow warning. Use it only for draft dry runs. Only this job has
   `contents: write`. The build/signing job retains read access. Leave the release draft while testing.
   If uploading manually, upload the same final artifacts, without rebuilding or re-signing.
7. After uploading, the same upload job runs `node tools/release/release-checksums.mjs --tag vX.Y.Z`
   with its draft-visible token to download every attached asset and upload a freshly computed
   combined `SHA256SUMS.txt`. This preserves coverage of Mac assets already attached to the draft.
   It then downloads all attached release assets again and runs the
   [asset checker](three-builds.md#last-step-before-un-drafting). Every supplied build must pass
   the hash, size and tag/commit checks. The checker lists wholly missing macOS or Windows build
   pairs and rejects partial pairs or an incomplete Linux set. The Windows-only
   result is INCOMPLETE, not a publishing pass. Windows passes `--skip-dmg-provenance` explicitly
   because it cannot mount DMGs; the final Mac gate must check their embedded commits.
8. Collect both DMGs and the installer with their adjacent `.build.json` files. If you are including
   Linux, also collect `ChemDraft_X.Y.Z_amd64.deb`, `ChemDraft_X.Y.Z_amd64.AppImage`, and their
   records. The [Linux workflow](linux.md#releasing) builds and records both packages and uploads
   them to the existing draft after smoke tests pass when `upload_to_release` is supplied. For a manual
   Linux upload, download `linux-release-amd64` and upload the packages, records, and `SHA256SUMS-linux.txt`.

   After all planned manual uploads and release upload workflows for the tag have finished, refresh the
   combined checksums from the assets attached to the draft. Do not change the draft's assets between this refresh and publication. From the repository
   root, with `gh` authenticated for the draft, run (replace the tag and commit and use a fresh output path):

   ```text
   node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha> --skip-dmg-provenance --write-checksums path/to/SHA256SUMS.txt && gh release upload vX.Y.Z path/to/SHA256SUMS.txt --clobber
   ```

   Then pass the
   [joint release body check](three-builds.md) with the tag and explicit gaps or `--no-gaps`.
   The generator adds a Linux section when those packages and records are present. Use
   `--gap "linux:feature and reason"` for any Linux feature gaps. After the attached artifacts pass review,
   **as the last step before un-drafting on a Mac** run
   `node tools/release/release-checksums.mjs --tag vX.Y.Z` to upload the final combined sums, both
   `verify-macos-app.mjs --release --dmg` checks and
   `node tools/release/check-release-assets.mjs --tag vX.Y.Z --commit <full-sha>` against GitHub,
   as listed in [the final checklist](three-builds.md#last-step-before-un-drafting).
   It must report PASS without skip or incomplete flags; then publish the joint release. Only **after** the installer
   URL is publicly downloadable, commit the generated `latest.json` to `main` through the normal PR
   path. This workflow neither publishes the release nor updates the feed on `main`.

## Dry runs before credentials exist

- Missing `SIGNPATH_API_TOKEN`: a loud workflow warning, Authenticode skipped, installer retained.
  If the updater key is available it still signs those final unsigned bytes and generates the feed.
- Missing `TAURI_SIGNING_PRIVATE_KEY`: a loud warning, no `.sig` or `latest.json`; the installer and
  checksums are still uploaded. Authenticode can run independently.
- A SignPath token with missing organization/project/policy variables is an error. A configured
  signing operation or verification that fails is an error, never a silent dry run.

Use dry runs with `upload_to_release` empty. Do not publish their output as a signed production
update. Repository secrets are scoped to signing steps, not the build; the workflow never runs on
pull requests and its jobs are disabled in forks.
