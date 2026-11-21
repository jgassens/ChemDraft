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

The add-in fetches Office.js from Microsoft's CDN. The desktop editor and drawing assets
are bundled locally. Older PowerPoint hosts with PowerPointApi 1.5 can read pictures
through the file fallback. Updates need PowerPointApi 1.8, and rotated pictures require 1.10.
PowerPoint's insert, stacking and delete operations have separate undo steps. See
[Microsoft's Office.js undo support documentation](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model#undo-support).
