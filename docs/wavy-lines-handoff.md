# Adjustable wavy art lines

PR #209, contributed by Emily Osborn, adds Smooth, Height and Width sliders to Object Settings.
Height is peak-to-trough in document pixels. Width requests a wavelength; the renderer fits whole
cycles between fixed endpoints, including short, diagonal and reversed lines. Smoothness blends
angular and rounded quarter-wave geometry.

Only selected graphic paths with `artPathKind: wavy` can change. Molecules, molecular bonds,
non-wave graphics and unselected art remain untouched. Missing wave metadata retains the existing
legacy waveform; inspecting, loading or saving a document does not opt a line into new geometry.
The first explicit adjustment stores all three settings. Canvas and export use the shared art plan.

Commands encode both setting and value: `object.wave.smoothness:0` through `:100` (step 1),
`object.wave.height:0` through `:48` (step 0.5), and `object.wave.width:4` through `:120` (step 1).
All 315 commands have core object-style specs in the shared registry and Customize catalog.
Palette commits use those handlers; previews share the existing style transaction, with one Undo
entry per completed drag and exact rollback on Escape or cancellation.

`apps/desktop/src/testSupport/legacyWavyPaths.json` captures local/page path data directly from
main commit `78f82a1e`, including click-placed, explicit-endpoint, short, diagonal and arrowhead
cases. Treat it as a compatibility lock, not a snapshot to refresh after rendering changes.
The mounted command tests exercise both shortcut platforms, mixed selections, all registered
values, preview/commit/cancel and Undo/Redo. A molecule carrying V2000 stereo=4 source data checks
source, canonical SMILES and native display preservation. Main has no native wavy single-bond
display enum; this feature does not add one.

Native macOS and Windows visual checks remain in `docs/manual-stress-checklist.md`. No native
build or launch verification is claimed here.
