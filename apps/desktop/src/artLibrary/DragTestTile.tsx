// DEV-ONLY drag harness (see dragTestHarness.ts). Remove in phase 3.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { describeDragEnd, nativeDragTestBridge, passedDragThreshold, type DragTestBridge } from "./dragTestHarness";
import "./DragTestTile.css";

/**
 * One tile that starts a real operating-system file drag of a fixed SVG. It renders nothing until
 * Rust has written the file and returned its path, so a stable build (Rust answers `null`) shows
 * nothing at all.
 */
export function DragTestTile({ bridge = nativeDragTestBridge }: { bridge?: DragTestBridge }) {
  const [path, setPath] = useState<string | null>(null);
  const [status, setStatus] = useState("Press and drag onto a document, the desktop, or another app.");
  const dragging = useRef(false);
  /** Stops following a pending press; set while one is pending. */
  const stopPress = useRef<(() => void) | null>(null);
  useEffect(() => () => stopPress.current?.(), []);
  useEffect(() => {
    let cancelled = false;
    bridge.prepare().then(prepared => { if (!cancelled) setPath(prepared); })
      .catch((error: unknown) => console.warn("Drag test unavailable:", error));
    return () => { cancelled = true; };
  }, [bridge]);
  if (!path) return null;
  // A pending press is followed on the whole window, so moving out of the tile still starts the
  // drag and a release or cancel anywhere ends the press (a mouse has no implicit pointer capture).
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragging.current) return;
    stopPress.current?.();
    const start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    const view = event.currentTarget.ownerDocument.defaultView ?? window;
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== start.pointerId) return;
      // Releasing the primary button while another is held reports a move, not a pointerup.
      if ((moved.buttons & 1) === 0) { stop(); return; }
      if (!passedDragThreshold(start, { x: moved.clientX, y: moved.clientY })) return;
      stop();
      dragging.current = true;
      setStatus("Dragging…");
      bridge.startDrag(path, ended => { dragging.current = false; setStatus(describeDragEnd(ended)); })
        .catch((error: unknown) => { dragging.current = false; setStatus(error instanceof Error ? error.message : String(error)); });
    };
    const end = (ended: PointerEvent) => { if (ended.pointerId === start.pointerId) stop(); };
    const stop = () => {
      view.removeEventListener("pointermove", move, true);
      view.removeEventListener("pointerup", end, true);
      view.removeEventListener("pointercancel", end, true);
      stopPress.current = null;
    };
    view.addEventListener("pointermove", move, true);
    view.addEventListener("pointerup", end, true);
    view.addEventListener("pointercancel", end, true);
    stopPress.current = stop;
  };
  return <section className="cd-drag-test" aria-label="Drag test (development build only)">
    <h3>Drag test <span>development build only</span></h3>
    <div className="cd-drag-test-tile" data-drag-test-path={path} title={path}
      onPointerDown={down}
      onDragStart={event => event.preventDefault()}>
      <svg viewBox="0 0 96 96" aria-hidden="true"><rect x="4" y="4" width="88" height="88" rx="14" fill="#eef4fb" stroke="#2f6db5" strokeWidth="4" />
        <path d="M38 20h20M42 20v20L26 72a6 6 0 0 0 5 8h34a6 6 0 0 0 5-8L54 40V20" fill="#cfe2f7" stroke="#2f6db5" strokeWidth="4" strokeLinejoin="round" />
        <circle cx="48" cy="64" r="6" fill="#2f6db5" /></svg>
      <span>drag-test.svg</span>
    </div>
    <p role="status">{status}</p>
  </section>;
}
