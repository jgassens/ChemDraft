# ChemDraft Edit Structure task pane

Run the Office build from the workspace.

    pnpm --filter @chemdraft/desktop build:office

If you also build the desktop web app, run its build first. The task pane build writes
only to apps/desktop/dist/office. It fills the manifest URL and version from the desktop
package version and includes the ChemDraft ribbon icons.

Publish the contents of that directory under https://chemdraft.ai/office/<app-version>/.
Serve taskpane.html at the extensionless /office/<app-version>/taskpane URL with an
HTML content type and no trailing slash. Keep the assets directory beside that route.
Sideload the generated manifest.xml in Word and PowerPoint for Mac to add **Edit Structure**
to the Home tab.

On macOS, **Help > Install Office Add-in…** in ChemDraft installs the manifest for Word and
PowerPoint after confirmation. Restart the apps and look for **Edit Structure** on the Home
tab. **Help > Remove Office Add-in** removes the manifest for the current ChemDraft build.

Cargo embeds the manifest from this directory into each macOS app before linking. The build
script fills the same fields as `build:office`, using the matching Cargo package version, so
the desktop build does not depend on a prior task pane build. Development builds use a separate
file and Office ID with the display name **ChemDraft (dev)**. They load the same versioned
editor URL as the release.

To verify byte-for-byte parity with the generated Office manifest, run `build:office` first,
then run the Rust test below from the workspace root on macOS.

    CHEMDRAFT_TEST_OFFICE_MANIFEST="$PWD/apps/desktop/dist/office/manifest.xml" cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml embedded_manifest_matches_the_versioned_office_build

The add-in fetches Office.js from Microsoft's CDN. The desktop editor and drawing assets
are bundled locally. Older PowerPoint hosts with PowerPointApi 1.5 can read pictures
through the file fallback. Updates need PowerPointApi 1.8, and rotated pictures require 1.10.
PowerPoint's insert, stacking and delete operations have separate undo steps. See
[Microsoft's Office.js undo support documentation](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#undo-support).
