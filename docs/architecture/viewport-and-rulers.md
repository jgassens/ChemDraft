# Viewport And Rulers

Status: ruler renderer spike connected to the desktop viewport.

ChemDraft has a small `@chemdraft/viewport-engine` package that owns viewport state, coordinate math, and ruler render parameters. The desktop UI renders rulers with `@scena/react-ruler`, but the ruler renderer consumes ChemDraft viewport state rather than owning document geometry.

Page size and paper layout are native document data in `@chemdraft/chem-core`. The viewport, rulers, crosshairs, object positioning, and exports consume the active page layout; React canvas constants are not the geometry source of truth.

Ruler units follow the active paper family. US presets such as Letter and Legal use inch rulers and inch-based grid/crosshair ticks. ISO A presets use centimeter rulers and centimeter-based grid/crosshair ticks. Page size switching is exposed through command-backed File > Page Setup menu items.

## Current Viewport State

The viewport boundary tracks:

- `scale`
- `translateX`
- `translateY`
- `scrollOriginX`
- `scrollOriginY`
- `pageOriginX`
- `pageOriginY`
- `rulerUnit`
- `minZoom`
- `maxZoom`

It exposes:

- `screenToPage`
- `pageToScreen`
- `zoomViewportAtPoint`
- `zoomViewportBy`
- `viewportCssVars`

The goal is to keep document geometry, rulers, wheel zoom, pinch zoom, and future pointer editing in one coordinate system.

## Dependency Candidates

### `@scena/ruler`

Purpose: ruler rendering.

License: MIT.

Pros:

- Purpose-built ruler component.
- Supports horizontal and vertical rulers.
- Documents inch calibration with `1in = 96px`, matching CSS inches.
- Has explicit `unit`, `zoom`, `scroll`, and `resize` concepts.

Cons:

- Imperative component API, so React integration needs a thin wrapper.
- Last GitHub release appears older than the other viewport candidates.
- Should be spiked before committing because rulers must sync cleanly with scroll and zoom.

### `d3-zoom`

Purpose: low-level pan and zoom transform behavior.

License: ISC.

Pros:

- Mature transform model.
- DOM-agnostic across SVG, HTML, and Canvas.
- Strong fit for a document editor where ChemDraft owns rendering and coordinate math.

Cons:

- Not React-specific.
- Needs an adapter layer so it does not become app state.
- Gesture polish and platform-specific trackpad behavior must be tested on macOS.

### `@use-gesture/react`

Purpose: low-level React gesture binding.

License: MIT.

Pros:

- Good fit for component-tied mouse/touch gesture handlers.
- Keeps transform math in ChemDraft rather than in a black-box zoom component.
- Can support custom pinch/wheel/pan routing for editor tools.

Cons:

- Does not provide a viewport model by itself.
- Often paired with animation libraries; ChemDraft should avoid adding an animation dependency unless needed.
- More implementation work than a ready-made zoom wrapper.

### `react-zoom-pan-pinch`

Purpose: fast React zoom/pan/pinch prototype.

License: MIT.

Pros:

- React-first.
- Provides ready-made wrapper/components and controls.
- Good for a quick prototype to evaluate expected desktop gestures.

Cons:

- Owns more transform behavior than ChemDraft should delegate long term.
- Could fight a chemistry editor's selection, drag, and tool event routing.
- Better as a prototype comparison than the production viewport core.

## Recommendation

Recommended path:

1. Keep `@chemdraft/viewport-engine` as the native state and coordinate-conversion source of truth.
2. Keep `@scena/react-ruler` behind the desktop ruler component for rendered rulers only.
3. Spike `d3-zoom` for wheel/pan/pinch transform input, feeding transforms into `viewport-engine`.
4. Use `@use-gesture/react` only if `d3-zoom` cannot satisfy macOS trackpad/pinch behavior cleanly.
5. Use `react-zoom-pan-pinch` only as a throwaway prototype comparison.

Do not add any further viewport dependencies without updating `docs/architecture/dependency-inventory.md`, recording license/distribution impact, and adding a minimal usage test or spike.
