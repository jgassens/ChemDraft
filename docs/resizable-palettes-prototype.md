# Resizable floating toolbar prototype

Local design prototype based on upstream `8a3781e`, on `resizable-palettes-prototype`.
This is awaiting review, not a shipped slice.

- All native floating toolbars can resize. Untouched toolbars keep main's content-fit sizing and
  layout; toolbars without a declared/grid size keep their native opening frame.
- A genuine resize switches to a constrained viewport. Button grids wrap within the available
  width; saved orientation controls their direction rather than the frame's aspect ratio.
  Customize mode retains the existing explicit slots and drag/drop behavior.
- Control widgets stay together as readable sections. Their minimum frame width is the smaller
  of 320 logical points and the original frame width, with a 96-point floor. Smaller viewports
  scroll instead of squeezing or hiding slider/input rows. Minimum height is 56 points.
- The bottom-right grip uses native resize dragging on Windows. Tauri's macOS backend does not
  support that API, so macOS uses captured pointer deltas in logical points. Native window edges
  remain resizable on both platforms.
- User frames persist per toolbar under `chemdraft.palette.frame.v1.<toolsetId>` in the dev app's
  local storage. Legacy prototype frame keys do not change fresh defaults. Invalid frames fall
  back to the original layout; restored dimensions are limited to the available screen size.
- Programmatic content-fit requests never save a user frame. Native eligibility rejects unknown
  callers, suspension, quitting, and minimized palette frames, including owner minimization on
  Windows. Main's shared suspension, native ownership, and offscreen recovery are retained.

The standing [manual checklist](manual-stress-checklist.md) includes the resizing pass, control
usability, customization, mixed DPI, monitor loss, dialogs, restart, minimize, and quit.
Native macOS verification and a complete hands-on pass on both platforms remain necessary.
