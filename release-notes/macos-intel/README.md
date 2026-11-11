# Intel macOS release notes

Keep Intel release notes here as `ChemDraft_X.Y.Z_x86_64.md`, matching the final DMG's basename.
Do not put Apple-silicon notes in this folder.

After the final Intel DMG is signed, notarized and stapled, stage it by itself and run from the repository root:

```sh
node tools/release/generate-macos-appcast.mjs --target x86_64-apple-darwin --version X.Y.Z --staging /absolute/path/release-intel
node tools/release/verify-macos-feed.mjs /absolute/path/release-intel/appcast-intel.xml --dmg /absolute/path/release-intel/ChemDraft_X.Y.Z_x86_64.dmg
```

The generator reads notes from this folder and preserves previously published entries. For Apple silicon,
use `--target aarch64-apple-darwin`, a separate staging folder, and `release-notes/macos/`.
The empty root Intel feed is intentional until the first Intel release; it offers no update.
Publish both feeds only after the matching DMGs and Windows x64 installer from the same commit are uploaded.
