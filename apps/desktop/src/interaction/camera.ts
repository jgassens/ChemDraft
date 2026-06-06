/**
 * The single source of truth for converting between client/screen coordinates and
 * page/world coordinates.
 *
 * Historically this math (`(client - pageRect.topLeft) / scale`) was copy-pasted in
 * several places in MainWindow (the wheel/gesture focal math and the pointer hit-test
 * path), which let the implementations drift. Everything now routes through here.
 *
 * The `Camera` interface is deliberately shaped as a `project` / `unproject` pair so a
 * future 3D camera (perspective/orthographic, backed by a 4x4 matrix) can implement the
 * same contract and be swapped in without touching any call site — the seam toward a
 * unified 2D/3D viewport.
 *
 * NOTE: today the live pan transform is native scroll on `.canvas-region`, so we read
 * the page element's current bounding rect (which already bakes in scroll) rather than a
 * translate offset. The rect is passed in as data — never read from the DOM in here — so
 * these functions stay pure and testable.
 */

export interface Point {
  x: number;
  y: number;
}

/** The minimal slice of a DOMRect we need: the rendered page's top-left in client space. */
export interface RectOffset {
  left: number;
  top: number;
}

export interface CameraTransform {
  /** Current bounding rect offset of the rendered page in client coordinates. */
  pageRect: RectOffset;
  /** Current zoom factor. */
  scale: number;
}

function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Convert a client/screen point to page/world coordinates. */
export function clientToPage(client: Point, transform: CameraTransform): Point {
  const scale = safeScale(transform.scale);
  return {
    x: (client.x - transform.pageRect.left) / scale,
    y: (client.y - transform.pageRect.top) / scale
  };
}

/** Convert a page/world point back to client/screen coordinates. */
export function pageToClient(page: Point, transform: CameraTransform): Point {
  const scale = safeScale(transform.scale);
  return {
    x: page.x * scale + transform.pageRect.left,
    y: page.y * scale + transform.pageRect.top
  };
}

/**
 * A camera projects world coordinates to the screen and unprojects screen coordinates
 * back to the world. `camera2d` is the only implementation today; a 3D camera will
 * implement the same interface later.
 */
export interface Camera {
  unproject(client: Point, transform: CameraTransform): Point;
  project(world: Point, transform: CameraTransform): Point;
}

export const camera2d: Camera = {
  unproject: clientToPage,
  project: pageToClient
};
