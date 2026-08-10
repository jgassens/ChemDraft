# macOS Updates with Sparkle

ChemDraft uses Sparkle 2 for macOS app updates. A packaged app checks the signed appcast once per
day and presents Sparkle's native update offer when a newer version is available. The app does not
silently install updates. A user can start the same visible check at any time from
**File > Check for Updates…**.

## Why installed plugins survive

Sparkle replaces `ChemDraft.app`. Installed plugin packages are not stored inside that bundle; the
desktop shell stages them under the app's Application Support data directory at
`$APPDATA/installed-plugins/`. Keeping the bundle identifier `org.chemdraft.desktop` stable keeps
that data directory stable across updates.

An app update therefore does not delete, reinstall, or rewrite plugins. On the next launch the
normal plugin installer/runtime validation runs against the packages already on disk. If a plugin
author has not kept a plugin compatible with a newer ChemDraft plugin API, that compatibility failure
belongs to the plugin; the app updater must not mutate the package to hide it.

## Checked-in configuration

- Sparkle bridge: `tauri-plugin-sparkle-updater` 0.2.4 (MIT).
- Framework: Sparkle 2.9.4 (MIT), downloaded from the official GitHub release by
  `scripts/prepare-sparkle.sh` and verified against the pinned SHA-256 before extraction.
- Feed: `https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast.xml`.
- Public Ed25519 key: `SUPublicEDKey` in `apps/desktop/src-tauri/Info.plist`.
- Private Ed25519 key: macOS login Keychain only; never commit or print it.

The downloaded `Sparkle.framework` and `sparkle-bin` tools are ignored by Git. `./run-app`,
`pnpm --filter @chemdraft/desktop build`, and `pnpm --filter @chemdraft/desktop dev:tauri` prepare
the pinned dependency automatically. A developer can also run:

```bash
pnpm --filter @chemdraft/desktop prepare:sparkle
```

When `APPLE_SIGNING_IDENTITY` is set (any signed release build), `prepare-sparkle.sh` also signs
the framework-root Sparkle helpers — `Versions/B/Updater.app` (and its `MacOS/Updater` binary) and
`Versions/B/Autoupdate` — with that Developer ID identity, the hardened runtime, and a secure
timestamp. Those helpers sit outside every standard nested-code location, so no other signing step
reaches them, and Apple notarization rejects the app without this. Unsigned dev builds skip it.

## The bundled OPSIN Java runtime

Same class of problem, thirty-one files wider. `tauri.conf.json` ships `resources/opsin/jre` as a
bundle resource, and that jlink'd runtime contains **31 Mach-O files** — `bin/java`,
`lib/jspawnhelper`, and ~29 `.dylib`s — all of them code, all under `Contents/Resources/`, which is
not a standard nested-code location. The outer `codesign` does not reach them (and Apple deprecates
`--deep` for signing), so the notary service finds each one unsigned and rejects the submission.

`pnpm --filter @chemdraft/desktop build` runs `scripts/sign-opsin-runtime.sh` before `tauri build`,
which signs all 31 innermost-first with the hardened runtime, a secure timestamp, and
`src-tauri/chemdraft.entitlements`. Ordering matters: a signature covers what it encloses, so the
JRE must be signed **before** the `.app` is sealed around it. With no `APPLE_SIGNING_IDENTITY` set
the script prints a notice and exits 0, which is right for dev and wrong for a release.

Two entitlements ride along, and they are for the JVM specifically:
`com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`. A
JVM writes native code at run time and then executes it, which the hardened runtime forbids by
default. **This failure mode appears only in a signed build** — `tauri dev` and an unsigned Release
both work fine, so an unentitled JVM is discovered after notarization has already succeeded.

> Not yet exercised against the notary service. This follows the documented flow and the files do
> sign and verify locally, but no submission has been made with it. The first release build is what
> proves it — if notarytool rejects, its log names the exact path, and that path is the fix.

## Publishing an update

Sparkle compares the packaged app's `CFBundleVersion`. Tauri derives the macOS version fields from
`apps/desktop/src-tauri/tauri.conf.json`, so every published update must increase that `version`.
Do not reuse a published version.

1. Increase `version` in `apps/desktop/src-tauri/tauri.conf.json` and run the normal tests/build.
2. Produce a Developer ID signed release app/DMG, notarize it, staple it, and pass the validation
   steps in `/Users/jeremiahgassensmith/programming/.notary/NOTORIZE.md`.
3. Put the final DMG and an optional same-basename `.md` release-notes file into a clean staging
   directory. Copy the current root `appcast.xml` into that directory so prior releases remain in the
   feed.
4. Generate signed feed entries with the Keychain-held Sparkle key. For version `X.Y.Z`:

```bash
apps/desktop/src-tauri/sparkle-bin/generate_appcast \
  --download-url-prefix "https://github.com/jgassens/ChemDraft/releases/download/vX.Y.Z/" \
  --link "https://github.com/jgassens/ChemDraft" \
  --maximum-deltas 0 \
  --maximum-versions 3 \
  -o appcast.xml \
  /absolute/path/to/staging-directory
```

5. Create GitHub release `vX.Y.Z` and upload the exact notarized DMG named in the generated appcast.
6. Copy the generated appcast back to the repository root, then commit and push it to `main` only
   after the release asset is reachable. Do not hand-edit a generated signed entry.

Back up the Sparkle private key before the first public release. Use
`apps/desktop/src-tauri/sparkle-bin/generate_keys -x <private-key-file>`, store that file in an
approved secret store outside this repository, and delete any temporary plaintext copy.

## Verification

For a real end-to-end update test, use two Developer ID signed/notarized builds with increasing
versions. Install the older build, publish the newer build plus appcast entry, clear Sparkle's last
check time if an immediate automatic check is needed, then launch the older app. Success is:

- the native Sparkle offer names the newer version;
- **File > Check for Updates…** finds the same release;
- installation relaunches the new `ChemDraft.app`;
- a plugin installed before the update still exists in Application Support and loads through the
  normal runtime after relaunch.

An ad-hoc `./run-app` bundle can prove framework/config/menu integration, but it cannot prove the
production trust chain. The final update acceptance test must use the same Developer ID identity and
Sparkle key as the published release.
