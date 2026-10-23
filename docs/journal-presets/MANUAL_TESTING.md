# Beginner testing checklist

Use a copy of a drawing, not the only copy of coursework. The feature branch is
`codex/journal-formatting-presets`. The older bug-fix PR is separate.

## Open the feature

On this prepared computer, open `contribution` in Terminal and use the installed Node runtime
(or install Node 24 and pnpm 10.12.1 if using another computer).

From the repository folder:

1. `pnpm install --frozen-lockfile` — installs the project's existing dependencies.
2. `pnpm dev:web` — starts a browser preview; open the local address printed in Terminal.
3. For the native app on macOS, use `./run-app --dev` instead. Rust/Cargo is required.
4. For Windows, follow the prerequisites in the root README, then `pnpm dev`.

The macOS native launcher and Windows launcher have NOT been verified for this feature.
The browser is useful for the controls, SVG and PDF checks; desktop raster export needs the native app.
Look for build stamp `10.22.20.00-codex` and branch `codex/journal-formatting-presets`.

## Check the controls and the five journals

- [ ] Start editing an atom label, then try Journal Presets: finish-editing guidance should appear.
      Finish with Enter, then open the dialog normally.
- [ ] Draw two molecules and add a text label. Add a reaction arrow if you like.
- [ ] Select one molecule and choose **Edit > Journal Presets…**.
- [ ] Confirm five journal entries: JACS, Organic Letters, Analytical Methods, RSC Advances,
      Nature Chemistry. ACS, RSC and Nature Portfolio must appear beside their journals.
- [ ] Search for `JACS`, then `17599660`, then `Nature Portfolio`; confirm relevant results.
- [ ] Choose RSC Advances. Read the checked date, partial-coverage notice, official link,
      drawing settings, figure limits, and preview.
- [ ] Change Figure type to TOC: confirm 80 × 40 mm and TIFF requirements.
- [ ] Switch to Organic Letters: try single column, double column and TOC.
- [ ] Confirm Resize is unavailable for ACS presets because a bond length was not sourced.
- [ ] Choose Custom preset. Change the font size to 9 pt; confirm the preview updates.
- [ ] Enter 0 for font size: Apply must be unavailable. Correct it.
- [ ] Click Reset: the form returns to its initial journal and scope.

## Check safety and saving

- [ ] Click Cancel: neither molecule should have changed.
- [ ] Reopen, choose RSC Advances, choose Selected objects and leave Resize unchecked.
      Apply. Only the selected molecule's appearance changes; its position and shape stay fixed.
- [ ] Undo once: the old appearance returns. Redo once: the preset returns.
- [ ] Reopen and choose Whole document. Apply: both molecules and plain text are included.
      The arrow remains editable and is not silently restyled.
- [ ] Save with File > Save As under a new name, close, and reopen. Appearance is retained.
      Close/reopen also works without an internet connection.
- [ ] Open another tab before applying from the native dialog. Apply must target its original tab.
- [ ] Edit the originating drawing while its native dialog is open. Applying must show a
      drawing-changed message instead of overwriting the newer drawing. Reopen to refresh.
- [ ] Close the originating tab: its native dialog closes too.
- [ ] Open the command twice: reuse the same native window, draft and position.
- [ ] Try Resize with Nature Chemistry on a copy. Molecules can become smaller, but atom labels,
      charges and wedge/dash directions must still describe the same chemistry. Review spacing.

## Check export

- [ ] Apply Nature Chemistry, then open Export. Try SVG and PDF.
- [ ] Inspect width in millimetres. Oversized output should produce a journal warning.
- [ ] If resizing the export reduces fonts or lines below saved rules, inspect the warning.
- [ ] Open the exported file. Compare labels, bond widths and spacing against the drawing.
- [ ] On desktop, try RSC TOC as TIFF at 600 dpi and at a lower DPI; the latter must warn.
- [ ] Do not submit a figure solely because the app applied a preset. Follow its official instructions.

## Native platform checks required before merging

Repeat the controls, keyboard close (Escape; Cmd+W on Mac, Ctrl+W on Windows), native source links,
window dragging to another monitor, saved window placement, inactive-tab Apply and owner-close checks
on BOTH platforms. Confirm Windows has no taskbar entry for the dialog and toolbars stay usable.
Also run the existing `docs/manual-stress-checklist.md` and `pnpm smoke:windows-menu-churn` on Windows.
Record each actual outcome. These native checks were not run in the development environment.

## Expanded pack and strict verification

1. Open Edit > Journal Presets. Click Load additional journal pack (15 journals). Confirm 20 journals.
2. Search Advanced Materials, then its ISSN 1521-4095. Read the official source link, date and partial label.
3. Select its vector then raster figure types. Confirm PDF/PS/EPS versus TIFF with 1200 dpi guidance.
4. Confirm the style proposal has 12 pt Arial and 17 pt target bonds; coordinates resize only when checked.
5. Select Chemical Reviews and its TOC option. Confirm 50 × 50 mm, rather than an RSC TOC size.
6. Select Angewandte. Read the conflict warning; confirm the wide TOC option is absent.
7. Select Cell. Confirm partial coverage, version 1.0.1, source-check date and the official links.
   Choose a research/review or preview/commentary width; confirm 85/114/174 mm versus 55/114/174 mm.
   Confirm Arial 7 pt, 0.45 cm bonds and 0.015 cm lines. Apply should enable after the preview.
   Review the stereo-width and line-width caveats. This profile does not cover graphical abstracts.
   Search each omitted journal named in EXPANDED_CATALOG.md; it must not appear in the picker.
8. Search Applied Catalysis B: Environmental. Confirm it has no selectable entry in this contribution.
9. Select Molecules. Confirm appearance is retained and the 600 dpi recommendation is labelled as guidance.
10. Apply a partial additional profile to a sample drawing. Undo, Redo, save, close and reopen it offline.
    Confirm the appearance and saved settings remain; loading a newer catalog must not restyle it.
11. On both native platforms, repeat source-link opening, window ownership/focus and the full repository
    manual-stress checklist. A browser test does not verify native raster or PDF rendering.
