# Windows installer signing in CI

`.github/workflows/windows-release.yml` builds ChemDraft's x64 NSIS installer on a GitHub-hosted
Windows runner. SignPath Foundation can Authenticode-sign that CI artifact after the owner completes
the account setup below. The existing [Windows VM release path](windows-updates.md#existing-windows-vm-path)
remains available.

There are two independent signatures, in this order:

1. Build the stable installer with `CHEMDRAFT_STABLE_BUILD=1` and
   `CHEMDRAFT_SKIP_UPDATER_SIGNING=1`.
2. Upload the unsigned installer as `windows-nsis-unsigned`, submit its artifact ID to SignPath,
   wait for approval/completion, and download the signed installer. Require
   `Get-AuthenticodeSignature` to report `Valid` before replacing the unsigned copy.
3. Use `tauri signer sign` to create the updater `.exe.sig` over that **final** installer.
4. Verify the updater signature against `plugins.updater.pubkey` in
   `apps/desktop/src-tauri/tauri.windows.conf.json`, then generate `latest.json` with
   `pnpm -s release:windows-manifest` and the optional Windows notes.

Authenticode changes the installer's bytes. Never Authenticode-sign, rebuild, or otherwise modify the
installer after creating its updater `.sig`; recreate and verify the `.sig` and manifest if it changes.
The opt-out is explicit: without it, VM builds retain their existing automatic updater signing.

## Owner setup for SignPath Foundation

The **repository owner must personally** complete these account and trust steps. No account, token,
certificate, or approval is supplied by the workflow.

1. Read the [Foundation conditions](https://signpath.org/terms) and
   [apply for free open-source signing](https://signpath.org/apply). ChemDraft's core uses the
   OSI-approved Apache-2.0 licence. Supply the public `jgassens/ChemDraft` repository, project and
   download pages, release history, and the CI build workflow. All bundled components must meet
   the Foundation's licensing conditions; core licensing alone does not establish eligibility.
   Approval is the Foundation's decision.
2. After acceptance, create the ChemDraft project in the supplied SignPath organization. Publish the
   required code signing policy, attribution, named committers/reviewers/approvers and accurate
   privacy policy on the project/download pages. Enable MFA and nominate the people who will approve
   release signing requests.
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

6. Add the **existing updater key** as repository secret `TAURI_SIGNING_PRIVATE_KEY`. The owner
   copies the contents of `%USERPROFILE%\.tauri\chemdraft-updater.key` (or its protected backup)
   directly into the secret field. Never print it, paste it into a workflow, commit it, upload it
   as an artifact, or place its value on a command line. Keep the same public key: replacing the
   pair would strand installed apps. The current key has an empty password; the workflow passes
   that explicitly to the signer and trims surrounding whitespace from the secret.

The official SignPath action is pinned to its `v2` release tag with its release commit recorded in a
workflow comment. Review action updates and trust policy changes as release infrastructure changes.

## Run a release

Use a reviewed commit that has landed on the public repository's `main` branch, with the workflow
and signing tools present. Both platform artifacts must use the same commit and version. The release
body must include `## macOS` and `## Windows`; this workflow supplies the Windows artifacts only.

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
   worktree label, frontend commit stamp, `Authenticode: Valid`, updater verification, and final
   SHA-256 hashes and byte sizes. Build-time label checks inspect the native build output and built
   frontend assets. Install and launch the artifact on Windows to confirm its actual title and app
   identity and complete the update/session-preservation checks in [windows-updates.md](windows-updates.md#verification).
5. Download **`windows-release`**, which contains the final installer, its `.exe.sig`, `latest.json`,
   and `SHA256SUMS.txt`. **`windows-nsis-unsigned` is input to SignPath, not the release installer.**
   For a local updater signature check, from the repository root run:

   ```text
   pnpm exec tsx tools/release/verify-windows-updater.ts path/to/ChemDraft_X.Y.Z_x64-setup.exe
   ```

6. If `upload_to_release` was supplied, a separate job downloads only the final artifact and uses
   `gh release upload --clobber`. It refuses a missing or already published release, and requires
   `v<app version>` because the generated feed points to that URL. Only this job has
   `contents: write`; the build/signing job has read access. Leave the release draft while testing.
   If uploading manually, upload the same final artifacts, without rebuilding or re-signing.
7. After both platform artifacts pass review, publish the joint release. Only **after** the installer
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
