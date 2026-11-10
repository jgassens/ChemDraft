# Draft the joint release body

After the final signed artifacts and both appcasts are generated, and before publishing the joint
release, collect the two DMGs, Windows installer, its `.exe.sig`, `latest.json`, and both generated
appcasts in one staging directory. Include each artifact's adjacent `.build.json` file:
`ChemDraft_X.Y.Z_aarch64.dmg.build.json`, `ChemDraft_X.Y.Z_x86_64.dmg.build.json`, and
`ChemDraft_X.Y.Z_x64-setup.exe.build.json`. Prepare `release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`,
`release-notes/macos-intel/ChemDraft_X.Y.Z_x86_64.md`, and `release-notes/windows-X.Y.Z.md`.
From the repository root run:

```text
node tools/release/draft-release-body.mjs --version X.Y.Z --assets path/to/staging --out release-body.md
```

Without `--assets`, the current directory is checked; without `--out`, the body goes to stdout.
Each build record contains `commit` (full 40-character SHA), `version`, `target` (target triple),
and `clean` (boolean). The Windows workflow records the checked-out commit automatically. For each
Mac DMG, run `node tools/release/record-build.mjs --artifact <dmg> --target <triple>` immediately
after building, as shown in [macos-updates.md](macos-updates.md). Recording refuses a dirty source
tree, including staged changes and untracked files; keep staging outside the source tree.

The body command requires all three records to name the same commit, the requested version,
`clean: true`, and the appropriate target (`aarch64-apple-darwin`, `x86_64-apple-darwin`, or
`x86_64-pc-windows-msvc`). If local tag `vX.Y.Z` exists, it also checks that tag's commit.
Use `--commit <full-sha>` to specify the expected commit explicitly (overrides the tag lookup),
including when checking a release whose tag is unavailable locally. Mismatches name the build
record and exit 1.

For each feature gap, supply `--gap "macos:feature and reason"`, `--gap "macos-intel:feature and reason"`,
or `--gap "windows:feature and reason"`; the flag may be repeated. Review the resulting body.
This checks filenames, feed entries and recorded common source commit. Records are build metadata;
complete the separate signature and artifact-content verification in the release guides.
