import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type PointerEventHandler, type ReactNode } from "react";
import { scrollPaletteGridHorizontally, webFloatingPaletteFrame } from "./webFloatingPaletteFrame";

function subscribeToViewportWidth(onChange: () => void): () => void {
  globalThis.addEventListener("resize", onChange);
  return () => globalThis.removeEventListener("resize", onChange);
}

const viewportWidth = () => globalThis.innerWidth;

/**
 * The browser's floating palette frame (`.web-floating-palette`). The frame is clamped into the
 * viewport, and re-clamped whenever the viewport resizes; a palette wider than the viewport gets
 * `data-palette-horizontal-scroll` and its item grid scrolls sideways inside the frame (App.css), by
 * scrollbar, keyboard focus, or the vertical wheel. The user's stored position is not changed, so
 * a palette pulled in by a narrow window goes back where it was when the window widens again.
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
  const sectionRef = useRef<HTMLElement | null>(null);
  const width = useSyncExternalStore(subscribeToViewportWidth, viewportWidth, viewportWidth);
  const frame = webFloatingPaletteFrame(naturalWidth, position.x, width);
  const scrolls = frame.scrollsHorizontally;

  useEffect(() => {
    const section = sectionRef.current;
    if (!scrolls || !section) return;
    // Not React's onWheel: React registers wheel listeners as passive, so it could not keep the page
    // from also handling a wheel that scrolled the palette.
    const onWheel = (event: WheelEvent) => {
      const scroller = section.querySelector<HTMLElement>(":scope > .tool-palette");
      if (scroller && scrollPaletteGridHorizontally(scroller, event)) event.preventDefault();
    };
    section.addEventListener("wheel", onWheel, { passive: false });
    return () => section.removeEventListener("wheel", onWheel);
  }, [scrolls]);

  return (
    <section
      ref={sectionRef}
      className="web-floating-palette"
      aria-label={`Floating ${title}`}
      data-floating-palette="web-preview"
      data-toolset-id={toolsetId}
      data-palette-x={frame.x}
      data-palette-horizontal-scroll={scrolls ? "true" : undefined}
      style={
        {
          "--palette-x": `${frame.x}px`,
          "--palette-y": `${position.y}px`,
          "--palette-width": `${frame.width}px`
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
