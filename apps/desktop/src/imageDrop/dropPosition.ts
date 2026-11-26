export interface DropClientPoint { x: number; y: number }

/**
 * One native drop on the document window, measured by `file_drop.rs` in place of Tauri's own
 * `tauri://drag-drop` and drained from Rust's drop queue (`pendingDrops.ts`); see
 * `DocumentFileDropPayload` in `file_drop.rs`.
 */
export interface DocumentFileDropPayload {
  paths: string[];
  position?: { x?: unknown; y?: unknown } | null;
  /** `css`: CSS pixels relative to the page (macOS, Linux). `physical`: device pixels (Windows). */
  units?: unknown;
  /**
   * The macOS title-bar inset already taken off `y` in Rust, read from the window at drop time (0
   * elsewhere). Never applied again here.
   */
  topInsetRemoved?: unknown;
  /**
   * The window's scale factor when the drop happened (physical pixels per CSS pixel), or null when
   * Rust could not read it. A `physical` position is divided by this, so a drop drained after the
   * window moved to a display with another scale keeps its point.
   */
  scaleFactor?: unknown;
}

/**
 * The native drop position in the page's CSS pixels. Rust has already made it relative to the page:
 *
 * - macOS: wry measures `y` from the top of the WKWebView's frame, which extends under the title bar
 *   (a full-size content view), while the page starts below WebKit's inset. Rust removes the inset
 *   it reads from the window at drop time and sends points, which are CSS pixels.
 * - Linux: GTK's drag coordinates, logical pixels relative to the webview widget.
 * - Windows: `ScreenToClient` on the webview's own container window, so physical pixels relative to
 *   the page. The container sits below a window menu bar (which is in the frame's non-client area),
 *   so no menu offset applies; dividing by the scale factor gives CSS pixels.
 *
 * A physical position is divided by the scale the window had at the drop (`payload.scaleFactor`),
 * read by Rust with the position: the drop may be drained after the window moved to another display.
 * Only when Rust could not read it is `fallbackScale` used, which should be the webview's
 * `devicePixelRatio` now. The webview's zoom is off (Tauri's `zoomHotkeysEnabled` defaults to false),
 * so the two agree while the window stays on one display.
 */
export function nativeDropClientPoint(
  payload: Omit<DocumentFileDropPayload, "paths"> | null | undefined,
  fallbackScale: number
): DropClientPoint | undefined {
  const x = payload?.position?.x;
  const y = payload?.position?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (payload?.units !== "css" && payload?.units !== "physical") return undefined;
  if (payload.units === "css") return { x, y };
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const scale = positive(payload.scaleFactor) ? payload.scaleFactor : positive(fallbackScale) ? fallbackScale : 1;
  return { x: x / scale, y: y / scale };
}

/** A browser drop event's point; synthetic events without coordinates have none. */
export function browserDropClientPoint(event: { clientX?: unknown; clientY?: unknown }): DropClientPoint | undefined {
  const { clientX: x, clientY: y } = event;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

export interface ClientRectLike { left: number; top: number; right: number; bottom: number }

export interface CanvasBoxLike {
  getBoundingClientRect(): ClientRectLike;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * The canvas area a picture can be dropped onto, in client pixels: the border box less its borders,
 * native scrollbars (`clientWidth`/`clientHeight` exclude them, a leading-edge one included through
 * `clientLeft`) and the ruler strips, which are pointer-transparent and lie over the canvas. The same
 * area the canvas pointer check accepts.
 */
export function drawableCanvasRect(canvas: CanvasBoxLike, rulerInset: number): ClientRectLike {
  const rect = canvas.getBoundingClientRect();
  const left = rect.left + canvas.clientLeft;
  const top = rect.top + canvas.clientTop;
  const inset = Number.isFinite(rulerInset) && rulerInset > 0 ? rulerInset : 0;
  return { left: left + inset, top: top + inset, right: left + canvas.clientWidth, bottom: top + canvas.clientHeight };
}

/**
 * Where a drop lands on the page. A point outside the drawable canvas (over a toolbar, the tab
 * strip, the rulers or a scrollbar; see `drawableCanvasRect`) is first pulled to the nearest drawable
 * canvas point, then mapped to page units and
 * clamped to the page: the picture goes to the nearest point of the visible page. Without a point
 * the caller uses the visible centre, as Paste Picture does.
 */
export function dropPagePoint(
  client: DropClientPoint,
  canvas: ClientRectLike,
  pageOrigin: { left: number; top: number },
  scale: number,
  page: { width: number; height: number }
): DropClientPoint {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const visible = { x: clamp(client.x, canvas.left, canvas.right), y: clamp(client.y, canvas.top, canvas.bottom) };
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: clamp((visible.x - pageOrigin.left) / safeScale, 0, page.width),
    y: clamp((visible.y - pageOrigin.top) / safeScale, 0, page.height)
  };
}
