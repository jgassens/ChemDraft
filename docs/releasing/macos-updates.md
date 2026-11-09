# macOS Updates with Sparkle

ChemDraft uses Sparkle 2 for macOS app updates. A packaged app checks the signed appcast once per
day and presents Sparkle's native update offer when a newer version is available. The app does not
silently install updates. A user can start the same visible check at any time from
**File > Check for Updates…**.

- [ ] Run `node scripts/pin-external-tools.mjs --check` before a release; refresh pins if it differs.
- [ ] For any pin bump, run that check on both macOS and Windows; each run checks only its host platform.
- [ ] Inspect every Mach-O in the packaged bundle, including helpers, frameworks, sidecars and
  runtime libraries, with `otool -l`. Each architecture's `LC_BUILD_VERSION` minos or
  `LC_VERSION_MIN_MACOSX` version must be no greater than `bundle.macOS.minimumSystemVersion`
  in `apps/desktop/src-tauri/tauri.conf.json`.

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
   directory. Keep the release-notes file at `release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`
   in the repository as well. Copy the current root `appcast.xml` into that directory so prior releases
   remain in the feed.
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
6. Copy the generated appcast back to the repository root. Set the new entry’s release-notes link to
   `https://raw.githubusercontent.com/jgassens/ChemDraft/main/release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`.
   Commit and push the appcast and notes to `main` only after the release asset is reachable. Do not
   change the generated signature, length, or DMG URL.

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

## Intel macOS: a second DMG and a separate feed

Ship arm64 and x86_64 DMGs from **the same commit and version**, together with the
Windows installer under that version. Build both macOS artifacts locally on the
Apple-silicon release Mac; keep Developer ID, notarization and Sparkle credentials
in the existing local flow. No signing credentials go into GitHub Actions.

The Intel overlay `apps/desktop/src-tauri/tauri.intel.conf.json` selects
`Info.intel.plist` using `bundle.macOS.infoPlist`. The base config does not set
that option: Tauri automatically reads the adjacent `Info.plist`. The Intel
plist repeats the same Sparkle key and settings, changing only `SUFeedURL` to
`https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast-intel.xml`.
arm64 keeps `appcast.xml`. Keep the other plist settings synchronized.

### Intel OPSIN runtime: JDK source and architecture checks

Build locally from the repository root on the owner's Apple-silicon Mac:

```bash
./run-app -t x86_64-apple-darwin
```

`-t` and `--target` select the same packaged build. Before packaging Intel,
the launcher runs `node scripts/build-opsin-runtime.mjs --target x86_64-apple-darwin`.
That builder also accepts `--arch x86_64` or `OPSIN_TARGET_ARCH=x86_64`; an explicit
flag takes precedence over the environment. It builds the trimmed runtime into
`apps/desktop/src-tauri/resources/opsin/jre`, replacing the shared staging image.

When `JAVA_HOME` is unset, an Intel macOS runtime build obtains **Eclipse Temurin
25 LTS, version 25.0.5+8**, x64 macOS HotSpot, from this pinned Adoptium release asset:

- [JDK tarball](https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_mac_hotspot_25.0.5_8.tar.gz)
- [Published SHA-256](https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_mac_hotspot_25.0.5_8.tar.gz.sha256.txt):
  `32cd4d2151c91aa00d0fc911edfd05245ed40fa6b1aa894d5f35c928cd67a59d`

The pin lives in `scripts/opsin-jdk.mjs`. The archive is cached outside the repository
at `~/Library/Caches/ChemDraft/opsin-jdk/OpenJDK25U-jdk_x64_mac_hotspot_25.0.5_8.tar.gz`.
Both fresh downloads and cache hits must match the pinned SHA-256 **before extraction**;
a mismatch stops the build without extracting or using the archive. Remove a corrupt
cached archive and retry. Each build extracts a fresh JDK into a temporary directory
under that cache, runs its `bin/jlink`, and removes the extracted JDK afterwards.
The cached tarball remains for future builds. Never commit the JDK or generated JRE.

An explicit JDK still works and bypasses the download:

```bash
JAVA_HOME=/absolute/path/to/x86_64-jdk/Contents/Home ./run-app -t x86_64-apple-darwin
# Or stage only the runtime:
JAVA_HOME=/absolute/path/to/x86_64-jdk/Contents/Home node scripts/build-opsin-runtime.mjs --arch x86_64
```

`JAVA_HOME` must contain the target JDK's `bin/jlink` (JDK 21+); an invalid or
wrong-architecture Intel override fails instead of falling back to PATH. Unset an
arm64 `JAVA_HOME` to use the pinned Intel download. arm64 macOS, Windows and Linux
keep their existing native JDK discovery; they do not use this download.

On Apple silicon, the builder first probes Rosetta 2 and runs both jlink and the
generated Java launcher via `/usr/bin/arch -x86_64`. If Rosetta is missing, it stops
before downloading and names the installation command:

```bash
/usr/sbin/softwareupdate --install-rosetta --agree-to-license
```

On Intel, the same JDK and runtime run natively. Before linking, the builder parses
the selected JDK's `bin/java` and `lib/server/libjvm.dylib` Mach-O headers and
requires thin x86_64 binaries.
It repeats those checks on the generated JRE and fails on any mismatch, then
uses that JRE to smoke-test OPSIN's benzene conversion. This checks the actual
native binaries rather than relying on the JDK version or runner architecture.

`tauri.conf.json` includes `resources/opsin/jre` in bundle resources. After
production packaging, run the existing release gate against the built app:

```bash
node tools/release/verify-macos-app.mjs apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/ChemDraft.app --target x86_64-apple-darwin
```

It requires the bundled launcher and JVM at
`Contents/Resources/resources/opsin/jre`, and rejects missing, non-x86_64 or
universal JRE binaries, including the other loose JRE libraries.

macOS release DMGs are built **locally**, on the owner's Apple-silicon Mac, using
`./run-app` for arm64 and `./run-app -t x86_64-apple-darwin` for Intel, followed by
the existing macOS-only release signing/notarization steps. `run-app` itself builds
and launches the worktree `.app`; final production-identity packaging and the DMG
remain part of that local release flow. GitHub Actions does not build macOS release
DMGs. `.github/workflows/macos-intel-smoke.yml` builds only an unsigned `.app` and
provides an advisory smoke check, using its explicitly supplied x64 JDK.

### Build order on the Apple-silicon release Mac

Start at the repository root, on the exact commit being released, with the
normal release prerequisites installed and the local signing/notarization
instructions open. Install Rosetta on Apple silicon and an arm64 JDK (JDK 21+,
with deployment compatibility for the declared minimum macOS 11.0). Intel builds
obtain the pinned JDK automatically unless `JAVA_HOME` explicitly supplies one.

1. Build and validate the Intel sidecar from the pinned sources described in
   `native/avogadro3d-sidecar/README.md`:

   ```bash
   cd native/avogadro3d-sidecar
   cmake --preset protocol-scout-x86_64
   cmake --build --preset protocol-scout-x86_64
   cd ../..
   file native/avogadro3d-sidecar/build/protocol-scout-x86_64/avogadro3d-sidecar
   otool -L native/avogadro3d-sidecar/build/protocol-scout-x86_64/avogadro3d-sidecar
   otool -l native/avogadro3d-sidecar/build/protocol-scout-x86_64/avogadro3d-sidecar
   export CHEMDRAFT_ENGINE3D_SIDECAR="$PWD/native/avogadro3d-sidecar/build/protocol-scout-x86_64/avogadro3d-sidecar"
   pnpm smoke:engine3d-real-structure
   pnpm smoke:engine3d-hold-steady
   pnpm smoke:engine3d-anneal-energy
   cp "$CHEMDRAFT_ENGINE3D_SIDECAR" apps/desktop/src-tauri/binaries/avogadro3d-sidecar-x86_64-apple-darwin
   unset CHEMDRAFT_ENGINE3D_SIDECAR
   ```

   Commit the real sidecar and update its placeholder assertion in
   `apps/desktop/src-tauri/src/lib.rs` and binaries README before selecting the
   final release commit. The tooling change deliberately leaves the placeholder
   in place. Native Intel execution acceptance remains required after Rosetta
   smokes pass. Verify both sidecars' minimum OS, not just the new one.

2. Install the Rust targets for the toolchain pinned in `rust-toolchain.toml`:

   ```bash
   rustup show
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   ```

3. With `APPLE_SIGNING_IDENTITY` and the existing local notarization setup
   configured, build the arm64 runtime and app first:

   ```bash
   JAVA_HOME=/absolute/path/to/arm64-jdk/Contents/Home node scripts/build-opsin-runtime.mjs --arch arm64
   ./run-app
   CHEMDRAFT_STABLE_BUILD=1 pnpm --filter @chemdraft/desktop build --target aarch64-apple-darwin --bundles app,dmg
   node tools/release/verify-macos-app.mjs apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ChemDraft.app --target aarch64-apple-darwin
   ```

   Complete signing, notarization, stapling and validation using the existing
   local flow above. Save the final arm64 DMG in its own clean staging folder,
   e.g. `/absolute/path/release-arm64`, retaining its architecture-specific name.

4. Only after packaging arm64, replace the shared staging runtime with Intel:

   ```bash
   # Leave JAVA_HOME unset to use the pinned, checksum-verified Intel JDK download.
   ./run-app -t x86_64-apple-darwin
   CHEMDRAFT_STABLE_BUILD=1 pnpm --filter @chemdraft/desktop build --target x86_64-apple-darwin --bundles app,dmg
   node tools/release/verify-macos-app.mjs apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/ChemDraft.app --target x86_64-apple-darwin
   ```

   `run-app` creates and verifies the staged Intel JRE before building its worktree
   app. The subsequent production package build above signs that staged JRE through
   `scripts/sign-opsin-runtime.sh` before sealing the app. Finish the same local
   signing/notarization/stapling validation independently for Intel. Save its final
   DMG in `/absolute/path/release-intel` with a distinct
   architecture-specific name. Neither architecture may overwrite the other's
   artifact. The JRE output `resources/opsin/jre` is shared: never build these in
   parallel in one checkout. Rebuild arm64's runtime before another arm64 build.

The desktop build wrapper leaves macOS builds on Tauri's host-native default
when no target is supplied; on Apple silicon this writes arm64 artifacts under
`src-tauri/target/release`. An explicit target passes through to Tauri and
writes under `src-tauri/target/<triple>/release`. `./run-app` with no arguments
retains its existing host-native build and `target/release` paths;
`./run-app -t x86_64-apple-darwin` stages its matching JRE automatically and
exercises the Intel packaged dev app. `--dev` stays host-native. The launcher still
moves the bundle into this worktree's `app/`, uses the shared dev identity, keeps
the worktree label, and removes the production feed; it cannot prove update
acceptance. The stable app is never replaced by that launcher.

The release checker reads the built app's `LSMinimumSystemVersion`, requires
the target's feed, app, sidecar and OPSIN launcher/JVM, and checks every loose
Mach-O, including all JRE libraries and Sparkle helpers. Each file must contain
the target architecture. Universal frameworks/helpers are allowed, with every
slice's minimum OS checked; app, sidecar and JRE must be thin. Parsing handles
`LC_BUILD_VERSION`, legacy `LC_VERSION_MIN_MACOSX`, and fat headers. Upstream
architecture-specific libraries inside the OPSIN JAR remain packaged as-is.
Run this gate on the final signed app too; it performs no signing or mutation.

### Publish two appcasts

Run `generate_appcast` **separately**, against separate staging directories.
Never put both same-version DMGs in one generator input folder. Copy the
previous `appcast.xml` into the arm64 folder and the previous
`appcast-intel.xml` into the Intel folder. For the first Intel publication there
is no previous Intel feed: generate it from the final Intel artifact.

```bash
apps/desktop/src-tauri/sparkle-bin/generate_appcast \
  --download-url-prefix "https://github.com/jgassens/ChemDraft/releases/download/vX.Y.Z/" \
  --link "https://github.com/jgassens/ChemDraft" \
  --maximum-deltas 0 --maximum-versions 3 \
  -o /absolute/path/release-arm64/appcast.xml /absolute/path/release-arm64

apps/desktop/src-tauri/sparkle-bin/generate_appcast \
  --download-url-prefix "https://github.com/jgassens/ChemDraft/releases/download/vX.Y.Z/" \
  --link "https://github.com/jgassens/ChemDraft" \
  --maximum-deltas 0 --maximum-versions 3 \
  -o /absolute/path/release-intel/appcast-intel.xml /absolute/path/release-intel
```

Inspect each generated feed's enclosure, version, minimum OS and hardware
requirements. Both feeds must name their own exact final DMG. Publish both DMGs
in the same GitHub release and version as Windows (release body has `## macOS`
and `## Windows`). Only once both assets are reachable, copy the generated feeds
to repository-root `appcast.xml` and `appcast-intel.xml` and land them through
the normal PR flow. Do not hand-edit signed entries or generate signatures
before notarization/stapling has finalized the DMG bytes.

### Hosted Intel smoke and native acceptance

`.github/workflows/macos-intel-smoke.yml` is an advisory, unsigned job on
`macos-15-intel`, dispatched manually or for relevant PRs. It asserts x86_64,
uses the pinned Rust toolchain and x64 Temurin 21, builds/smokes OPSIN, runs the
three engine3d smokes only when the committed Intel sidecar is Mach-O, builds an
app without a DMG, and runs the release gate. While the sidecar is a placeholder,
it prints a notice and uses `--allow-sidecar-placeholder` only for that CI check.
Never use that exception for release approval. The job is not a required check;
branch protection is managed separately. It has no signing/notarization secrets.
Its runner availability and successful full build still need an actual CI run.

Acceptance on a **real Intel Mac**, including the declared minimum OS, remains
mandatory; Rosetta and unsigned hosted CI do not establish it:

- [ ] Quarantined downloaded DMG passes Gatekeeper; notarization and staples
      validate, install, native launch, quit and reopen work.
- [ ] Main app, sidecar, Sparkle helpers and signed JVM run without architecture
      or deployment-target errors; the strict final-app release gate passes.
- [ ] WKWebView runs RDKit/IsoSpec WASM, drawing, properties, stereo and exports
      with the same chemistry preservation as arm64; check WASM exceptions.
- [ ] All three engine3d smokes and interactive conformer/drag/settle behavior
      pass with acceptable performance using the committed Intel binary.
- [ ] Signed OPSIN converts benzene and exercises SMILES, CML and InChI output;
      JVM JIT works under the release entitlements.
- [ ] Intel Sparkle checks only `appcast-intel.xml`; arm64 still checks only
      `appcast.xml`. Test two increasing signed/notarized versions on each:
      offer, correct architecture download, install/relaunch, plugins/settings
      survive. No Intel app should offer an arm64 DMG or vice versa.
- [ ] Optional engines retain their honest unsupported state, with no attempted
      engine download on Intel (details below).
- [ ] Complete the shared `docs/manual-stress-checklist.md` on macOS and Windows;
      Windows installer/release checks remain part of the joint release.

### Existing Intel optional-engine limits (unchanged)

MolScribe and Orthonym plugins can install, but their local engines cannot run
on Intel under the current pins. In Plugin Manager the installed rows read
**“Recognition engine: not supported on this computer”** and
**“Naming engine: not supported on this computer”**, and there is no engine
Install button (`apps/desktop/src/plugins/PluginManagerDialog.tsx:915`, `:920`,
`:941`). The MolScribe install review says **“This plugin needs a local
recognition engine, which this computer doesn’t support yet. The plugin will
install, but it cannot recognize images here.”** (`PluginManagerDialog.tsx:1074`).
Its native reason is **“The recognition engine needs a Mac with Apple silicon.”**
(`apps/desktop/src-tauri/src/ocsr_engine/platform.rs:51`). Recognition returns
the unsupported failure without opening an install dialog
(`apps/desktop/src/plugins/StructureRecognitionController.ts:357`, `:710`).

Orthonym's review says **“This computer cannot run the local naming engine. The
plugin will install, but it cannot name structures here.”** and displays its
native detail (`apps/desktop/src/plugins/PluginManagerDialog.tsx:1056`, `:1062`):
**“The naming engine is unavailable for macos-x86_64; macOS requires Apple
silicon (no Intel RDKit wheel).”**
(`apps/desktop/src-tauri/src/naming_engine/install.rs:39`; status propagation at
`apps/desktop/src-tauri/src/naming_engine/mod.rs:243`). Naming returns
`status: unsupported` with that reason and no install dialog
(`apps/desktop/src/plugins/StructureNamingController.ts:175`). The different
RDKit-version-specific message in `naming_engine/install.rs:18` belongs to the
platform-validation seam; it is not the current Intel `current_platform()` text.
