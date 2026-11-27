import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEventHandler, type ReactNode } from "react";
import { webFloatingPalettePosition } from "./webFloatingPaletteFrame";

function subscribeToViewportSize(onChange: () => void): () => void {
  globalThis.addEventListener("resize", onChange);
  return () => globalThis.removeEventListener("resize", onChange);
}

const viewportWidth = () => globalThis.innerWidth;
const viewportHeight = () => globalThis.innerHeight;

/**
 * The browser's floating palette frame (`.web-floating-palette`). The frame keeps its natural width
 * and may run past the viewport's edges; it is drawn where webFloatingPalettePosition puts the user's
 * position, so a grab margin of its title bar stays inside the viewport, including after a resize.
 * The user's stored position is not changed, so a palette moved in by a narrow window goes back where
 * it was when the window widens again. `data-palette-x`, `-y` and `-width` give the drawn frame, which
 * is where a drag starts from.
 */
export function WebFloatingPaletteSection({
  toolsetId,
  title,
  naturalWidth,
  position,
  children,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: {
  toolsetId: string;
  title: string;
  naturalWidth: number;
  position: { x: number; y: number };
  children: ReactNode;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
}) {
  const width = useSyncExternalStore(subscribeToViewportSize, viewportWidth, viewportWidth);
  const height = useSyncExternalStore(subscribeToViewportSize, viewportHeight, viewportHeight);
  const frameRef = useRef<HTMLElement>(null);
  // The width the frame is actually drawn at: CSS may size it otherwise than `naturalWidth` (the
  // Rings inspector is max-content). 0 means no layout yet, so the passed width stands in.
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setMeasured(frame.getBoundingClientRect().width || frame.offsetWidth || 0);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  });
  const renderedWidth = measured > 0 ? measured : naturalWidth;
  const drawn = webFloatingPalettePosition(renderedWidth, position, { width, height });

  return (
    <section
      ref={frameRef}
      className="web-floating-palette"
      aria-label={`Floating ${title}`}
      data-floating-palette="web-preview"
      data-toolset-id={toolsetId}
      data-palette-x={drawn.x}
      data-palette-y={drawn.y}
      data-palette-width={renderedWidth}
      style={
        {
          "--palette-x": `${drawn.x}px`,
          "--palette-y": `${drawn.y}px`,
          "--palette-width": `${naturalWidth}px`
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {children}
    </section>
  );
}
