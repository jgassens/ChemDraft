# Compound layouts

Focused layout-only slice developed from current main. **Compound layout tools** is an off-by-default
user preference in Settings/Preferences, stored using the existing localStorage policy and synced
through DOM/Tauri events (plus browser storage events). It is not document metadata.

When disabled, layout toolbar buttons, flyout/context items and customization entries are hidden.
Registered layout commands refuse with a message explaining which setting enables them. When
enabled, Circle, Oval, Grid left/center/right, Row and Column translate the selection using visible
bounds and ring-system anchors. Circle/oval preserve clockwise spatial order; grid reads by row,
and incomplete rows use the selected justification. Default edge clearance is 48 document pixels.
No generated arrows, reaction annotations or wavy-line settings are included.

Groups and anchored marks move together; selecting a group with its descendants cannot move them
twice. Unselected objects/pages stay unchanged. Molecule dimensions, styles, SMILES, stereochemistry,
atom/bond counts and all internal coordinates relative to one another remain unchanged.
Layouts refuse page overflow rather than shrinking molecules; each action is one named Undo step
and keeps the compounds selected. Native save/reopen persists the resulting positions.
Row and Column first tighten their default 48-pixel gaps as needed, with a minimum clearance of
12 document pixels. They still refuse a page that cannot hold the compounds at that clearance.
Explicit spacing supplied through the layout API is honored without automatic tightening.
Grouped captions use their rotated frames for clearance, page-fit checks and spacing previews;
the caption's angle, size and position relative to its compound remain unchanged.

**Adjust spacing…** in the toolbar flyout or selection context menu’s **Arrange ›** submenu opens a local preview at the selected
page index, including page two. Smaller percentages bring item anchors closer about their centroid
while retaining original object dimensions; larger percentages spread them. The slider stops at
selected-item clearance and page bounds, within 25–150% of the original spacing. The preview shows
the entire selected page with a gray surround and an outlined white page boundary; its scale stays
fixed while the slider moves so the available page space remains visible. Cancel/Escape leaves the drawing untouched; Save commits
one Undo step. Disabling the preference closes the dialog and native popovers.
An overlapping starting selection can still be spread into a valid range. The original 100%
position remains available; intermediate values that still overlap show an error and cannot Save.
Carried charge marks retain their original atom attachment when arranging compounds or adjusting spacing,
including sticky marks positioned nearer another atom. Moving a charge mark independently still
allows intentional reassociation.

Limitations: this is a spatial layout, not a chemistry/reaction-order inference. Unselected objects
are not obstacles. Layouts are translation-only; existing object rotation is preserved. Users should
group captions with compounds before arranging. Very dense or large drawings may require a different
layout or a larger page. macOS/Windows native verification is recorded separately in the PR.

The desktop spacing preview uses the shared native dialog host: a movable, resizable window
owned by its originating drawing, with no Windows taskbar entry or utility-window menu.
Invoking the command while its window is still open retains the local slider draft. Switching tabs does not change the target: Save
applies once to the originating tab and records its undo there. A changed/replaced/closed
drawing cannot receive an old preview's Save; disabling the feature closes spacing windows.
The browser-only fallback shares the same form. Native creation errors never fall back
to a desktop overlay.

The document owner renders the selected page. SVG previews travel over authenticated
channels as bounded base64 chunks; the existing 4096-byte delivery limit remains intact.
Only the latest complete preview enables Save. Preview requests never reserve a terminal
Save, and rapid slider changes coalesce. Previews above 1,536,000 bytes of SVG report a size error.
