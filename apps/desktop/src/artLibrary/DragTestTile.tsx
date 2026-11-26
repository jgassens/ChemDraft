// DEV-ONLY drag harness (see dragTestHarness.ts). Remove in phase 3.
import { useEffect, useRef, useState, type PointerEvent } from "react";
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
  const press = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    let cancelled = false;
    bridge.prepare().then(prepared => { if (!cancelled) setPath(prepared); })
      .catch((error: unknown) => console.warn("Drag test unavailable:", error));
    return () => { cancelled = true; };
  }, [bridge]);
  if (!path) return null;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragging.current) return;
    press.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (!start || start.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;
    if (!passedDragThreshold(start, { x: event.clientX, y: event.clientY })) return;
    press.current = null;
    dragging.current = true;
    setStatus("Dragging…");
    bridge.startDrag(path, ended => { dragging.current = false; setStatus(describeDragEnd(ended)); })
      .catch((error: unknown) => { dragging.current = false; setStatus(error instanceof Error ? error.message : String(error)); });
  };
  const release = () => { press.current = null; };
  return <section className="cd-drag-test" aria-label="Drag test (development build only)">
    <h3>Drag test <span>development build only</span></h3>
    <div className="cd-drag-test-tile" data-drag-test-path={path} title={path}
      onPointerDown={down} onPointerMove={move} onPointerUp={release} onPointerCancel={release}
      onDragStart={event => event.preventDefault()}>
      <svg viewBox="0 0 96 96" aria-hidden="true"><rect x="4" y="4" width="88" height="88" rx="14" fill="#eef4fb" stroke="#2f6db5" strokeWidth="4" />
        <path d="M38 20h20M42 20v20L26 72a6 6 0 0 0 5 8h34a6 6 0 0 0 5-8L54 40V20" fill="#cfe2f7" stroke="#2f6db5" strokeWidth="4" strokeLinejoin="round" />
        <circle cx="48" cy="64" r="6" fill="#2f6db5" /></svg>
      <span>drag-test.svg</span>
    </div>
    <p role="status">{status}</p>
  </section>;
}
