# Draft the joint release body

After the final signed artifacts and both appcasts are generated, and before publishing the joint
release, collect the two DMGs, Windows installer, its `.exe.sig`, `latest.json`, and both generated
appcasts in one staging directory. Prepare `release-notes/macos/ChemDraft_X.Y.Z_aarch64.md`,
`release-notes/macos-intel/ChemDraft_X.Y.Z_x86_64.md`, and `release-notes/windows-X.Y.Z.md`.
From the repository root run:

```text
node tools/release/draft-release-body.mjs --version X.Y.Z --assets path/to/staging --out release-body.md
```

Without `--assets`, the current directory is checked; without `--out`, the body goes to stdout.
For each feature gap, supply `--gap "macos:feature and reason"`, `--gap "macos-intel:feature and reason"`,
or `--gap "windows:feature and reason"`; the flag may be repeated. Review the resulting body.
This checks filenames and feed entries, not signatures, artifact contents, or common source commit.
Complete the separate signing, feed verification, and same-commit checks in the release guides.
