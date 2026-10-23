import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PluginCanvasOverlayContribution } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

import { PluginPromptSection } from "./PluginReportRenderer";
import { isBrowserReloadChord } from "../keyboardShortcuts";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";

type Position = { x: number; y: number };

/** Host chrome only: actions carry control data; MainWindow resolves the live command declaration. */
export function PluginCanvasOverlay({ overlay, viewportRef, gestureActive, status, onAction,
  overlayLayerRef, statusRowRef, onOpenPanel, onFocusDrawing, shortcutPlatform, windowId = window.name || "main" }: {
  overlay: PluginCanvasOverlayContribution;
  viewportRef: RefObject<HTMLElement | null>;
  /** The positioned layer and bottom workspace chrome define the visible drawing area. */
  overlayLayerRef?: RefObject<HTMLElement | null>;
  statusRowRef?: RefObject<HTMLElement | null>;
  gestureActive: boolean;
  status?: string;
  onAction: PluginPanelActionHandler;
  onOpenPanel?: () => void;
  onFocusDrawing: () => void;
  windowId?: string;
  shortcutPlatform?: ShortcutPlatform;
}) {
  const storageKey = `chemdraft:canvas-overlay:${windowId}:${overlay.id}`;
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<Position | null>(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved === "object" && "x" in saved && "y" in saved
        && typeof saved.x === "number" && typeof saved.y === "number"
        && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
    } catch { /* Storage may be unavailable in a webview. */ }
    return null;
  });
  const elementRef = useRef<HTMLDivElement>(null);
  const focusOnExpandRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; start: Position; origin: Position } | null>(null);
  const drawingArea = () => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    const layer = overlayLayerRef?.current?.getBoundingClientRect() ?? viewport;
    const viewportElement = viewportRef.current;
    if (!viewport || !layer || !viewportElement) return { left: 0, top: 0, right: 0, bottom: 0 };

    // client dimensions exclude classic scrollbars; on platforms with overlay scrollbars they
    // naturally remain available. clientLeft/clientTop also preserve a scrollbar on the leading edge.
    let left = viewport.left + viewportElement.clientLeft;
    let top = viewport.top + viewportElement.clientTop;
    let right = left + (viewportElement.clientWidth || viewport.width);
    let bottom = top + (viewportElement.clientHeight || viewport.height);
    for (const ruler of viewportElement.querySelectorAll<HTMLElement>(".ruler-left, .ruler-top, .ruler-corner")) {
      const rect = ruler.getBoundingClientRect();
      if ((ruler.classList.contains("ruler-left") || ruler.classList.contains("ruler-corner"))
        && rect.right > left && rect.left <= left && rect.top < bottom && rect.bottom > top) left = Math.min(right, rect.right);
      if ((ruler.classList.contains("ruler-top") || ruler.classList.contains("ruler-corner"))
        && rect.bottom > top && rect.top <= top && rect.left < right && rect.right > left) top = Math.min(bottom, rect.bottom);
    }
    const status = statusRowRef?.current?.getBoundingClientRect();
    if (status && status.top > top && status.top < bottom && status.right > left && status.left < right) bottom = status.top;
    return { left: left - layer.left, top: top - layer.top, right: right - layer.left, bottom: bottom - layer.top };
  };
  const clampPosition = (point: Position): Position => {
    const bounds = drawingArea();
    const widget = elementRef.current?.getBoundingClientRect();
    const width = widget?.width || 36;
    const height = widget?.height || 36;
    return {
      x: Math.max(bounds.left, Math.min(point.x, Math.max(bounds.left, bounds.right - width))),
      y: Math.max(bounds.top, Math.min(point.y, Math.max(bounds.top, bounds.bottom - height)))
    };
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const element = elementRef.current;
    if (!viewport || !element || gestureActive) return;
    const fit = () => setPosition(current => {
      const bounds = drawingArea();
      const size = element.getBoundingClientRect();
      const next = clampPosition(current ?? {
        x: overlay.defaultCorner.endsWith("right") ? bounds.right - (size.width || 36) - 12 : bounds.left + 12,
        y: overlay.defaultCorner.startsWith("bottom") ? bounds.bottom - (size.height || 36) - 12 : bounds.top + 12
      });
      return current?.x === next.x && current.y === next.y ? current : next;
    });
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(viewport);
    observer?.observe(element);
    if (overlayLayerRef?.current) observer?.observe(overlayLayerRef.current);
    if (statusRowRef?.current) observer?.observe(statusRowRef.current);
    for (const ruler of viewport.querySelectorAll<HTMLElement>(".ruler-left, .ruler-top, .ruler-corner")) observer?.observe(ruler);
    window.addEventListener("resize", fit);
    if (expanded && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      element.querySelector("textarea")?.focus({ preventScroll: true });
    }
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [expanded, gestureActive, overlay.defaultCorner, overlayLayerRef, statusRowRef, viewportRef]);

  const remember = (point: Position) => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(point)); } catch { /* Optional persistence. */ }
  };
  return <div
    ref={elementRef}
    className="plugin-canvas-overlay"
    data-expanded={expanded}
    hidden={gestureActive}
    style={position ? { left: position.x, top: position.y } : { right: 12, bottom: 12 }}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onPointerCancel={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => event.stopPropagation()}
    onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (isBrowserReloadChord(event, shortcutPlatform)) event.preventDefault();
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      setExpanded(false);
      onFocusDrawing();
    }}
  >
    <button type="button" className="plugin-canvas-overlay-icon" hidden={expanded}
      aria-label={overlay.title} aria-expanded={expanded}
      onClick={() => { focusOnExpandRef.current = true; setExpanded(true); }}>
      <img src={overlay.icon} alt="" draggable={false} />
    </button>
    <div hidden={!expanded}>
      <div className="plugin-canvas-overlay-header"
        onPointerDown={event => {
          event.stopPropagation();
          if (event.button !== 0) return;
          event.preventDefault();
          dragRef.current = { pointerId: event.pointerId,
            start: { x: event.clientX, y: event.clientY }, origin: position ?? { x: 0, y: 0 } };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={event => {
          event.stopPropagation();
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = clampPosition({ x: drag.origin.x + event.clientX - drag.start.x,
            y: drag.origin.y + event.clientY - drag.start.y });
          setPosition(next);
          remember(next);
        }}
        onPointerUp={event => {
          event.stopPropagation();
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; }}
        onLostPointerCapture={() => { dragRef.current = null; }}>
        <span>{overlay.title}</span>
        <button type="button" aria-label={`Collapse ${overlay.title}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => { setExpanded(false); onFocusDrawing(); }}>−</button>
      </div>
      <PluginPromptSection section={overlay.prompt} onAction={onAction} includeSelected />
      <p className="plugin-canvas-overlay-status" role="status">{status}</p>
      {onOpenPanel ? <button type="button" className="plugin-canvas-overlay-panel" onClick={onOpenPanel}>Open assistant panel</button> : null}
    </div>
  </div>;
}
