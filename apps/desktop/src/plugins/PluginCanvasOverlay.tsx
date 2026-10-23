import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type RefObject } from "react";
import type { PluginCanvasOverlayContribution } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

import { PluginPromptSection } from "./PluginReportRenderer";
import { isBrowserReloadChord } from "../keyboardShortcuts";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";

type Position = { x: number; y: number };
type Mode = "collapsed" | "expanded";
type Positions = Record<Mode, Position | null>;
const ICON_SIZE = 36;
const DRAG_THRESHOLD = 4;

function readPosition(key: string): Position | null {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (saved && typeof saved === "object" && "x" in saved && "y" in saved
      && typeof saved.x === "number" && typeof saved.y === "number"
      && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
  } catch { /* Storage may be unavailable in a webview. */ }
  return null;
}
type CanvasOverlayStatusSource = {
  getCanvasOverlayStatuses: () => ReadonlyMap<string, string>;
  subscribeCanvasOverlayStatus: (listener: () => void) => () => void;
};

const subscribeNever = () => () => undefined;

function OverlayStatus({ overlayId, status, statusSource }: {
  overlayId: string;
  status: string | undefined;
  statusSource: CanvasOverlayStatusSource | undefined;
}) {
  const liveStatus = useSyncExternalStore(
    statusSource?.subscribeCanvasOverlayStatus ?? subscribeNever,
    () => statusSource?.getCanvasOverlayStatuses().get(overlayId) ?? status ?? "",
    () => status ?? ""
  );
  return <p className="plugin-canvas-overlay-status" role="status">{liveStatus}</p>;
}

/** Host chrome only: actions carry control data; MainWindow resolves the live command declaration. */
export function PluginCanvasOverlay({ overlay, viewportRef, gestureActive, status, onAction,
  overlayLayerRef, statusRowRef, statusSource, onOpenPanel, panelTitle, onFocusDrawing, shortcutPlatform, windowId = window.name || "main" }: {
  overlay: PluginCanvasOverlayContribution;
  viewportRef: RefObject<HTMLElement | null>;
  /** The positioned layer and bottom workspace chrome define the visible drawing area. */
  overlayLayerRef?: RefObject<HTMLElement | null>;
  statusRowRef?: RefObject<HTMLElement | null>;
  gestureActive: boolean;
  status?: string;
  /** Status updates subscribe inside the overlay, never through MainWindow's toolset synchronizer. */
  statusSource?: CanvasOverlayStatusSource;
  onAction: PluginPanelActionHandler;
  onOpenPanel?: () => void;
  /** The contributed panel's live title, supplied by the document window. */
  panelTitle?: string;
  onFocusDrawing: () => void;
  windowId?: string;
  shortcutPlatform?: ShortcutPlatform;
}) {
  const storageKey = `chemdraft:canvas-overlay:${windowId}:${overlay.id}`;
  const [expanded, setExpanded] = useState(false);
  const [positions, setPositions] = useState<Positions>(() => ({
    collapsed: readPosition(`${storageKey}:collapsed`),
    // The old shared key was written only by header drags, so migrate it to the box, never the icon.
    expanded: readPosition(`${storageKey}:expanded`) ?? readPosition(storageKey)
  }));
  const mode: Mode = expanded ? "expanded" : "collapsed";
  const position = positions[mode];
  const elementRef = useRef<HTMLDivElement>(null);
  const focusOnExpandRef = useRef(false);
  const expandedSizeRef = useRef({ width: 300, height: 220 });
  const anchorNextExpansionRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; start: Position; origin: Position; mode: Mode; moved: boolean } | null>(null);
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
  const clampPosition = (point: Position, targetMode: Mode): Position => {
    const bounds = drawingArea();
    const { width, height } = targetMode === "expanded" ? expandedSizeRef.current : { width: ICON_SIZE, height: ICON_SIZE };
    return {
      x: Math.max(bounds.left, Math.min(point.x, Math.max(bounds.left, bounds.right - width))),
      y: Math.max(bounds.top, Math.min(point.y, Math.max(bounds.top, bounds.bottom - height)))
    };
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const element = elementRef.current;
    if (!viewport || !element || gestureActive) return;
    const fit = () => {
      const bounds = drawingArea();
      // Size to the drawing area, not the larger overlay layer behind rulers/status/scrollbars.
      element.style.maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`;
      element.style.maxHeight = `${Math.max(0, bounds.bottom - bounds.top)}px`;
      const size = element.getBoundingClientRect();
      if (expanded) expandedSizeRef.current = { width: size.width || 300, height: size.height || 220 };
      setPositions(current => {
        const collapsed = clampPosition(current.collapsed ?? {
          x: overlay.defaultCorner.endsWith("right") ? bounds.right - ICON_SIZE - 12 : bounds.left + 12,
          y: overlay.defaultCorner.startsWith("bottom") ? bounds.bottom - ICON_SIZE - 12 : bounds.top + 12
        }, "collapsed");
        const box = current.expanded ?? (expanded ? collapsed : null);
        const next = { collapsed, expanded: box && clampPosition(box, "expanded") };
        return current.collapsed?.x === next.collapsed.x && current.collapsed.y === next.collapsed.y
          && current.expanded?.x === next.expanded?.x && current.expanded?.y === next.expanded?.y ? current : next;
      });
    };
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

  useEffect(() => {
    for (const mode of ["collapsed", "expanded"] as const) {
      if (positions[mode]) {
        try { window.localStorage.setItem(`${storageKey}:${mode}`, JSON.stringify(positions[mode])); } catch { /* Optional persistence. */ }
      }
    }
  }, [positions, storageKey]);

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || event.isPrimary === false) return;
    // Preserve normal button focus/click semantics for the icon; a drag will suppress its click.
    if (expanded) event.preventDefault();
    suppressClickRef.current = false;
    dragRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY },
      origin: position ?? { x: 0, y: 0 }, mode, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    suppressClickRef.current = true;
    if (drag.mode === "collapsed") anchorNextExpansionRef.current = true;
    const next = clampPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, drag.mode);
    setPositions(current => ({ ...current, [drag.mode]: next }));
  };
  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag}
      onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
      onClick={event => {
        if (suppressClickRef.current && event.detail !== 0) { suppressClickRef.current = false; return; }
        suppressClickRef.current = false;
        if (anchorNextExpansionRef.current) {
          setPositions(current => ({ ...current, expanded: current.collapsed }));
          anchorNextExpansionRef.current = false;
        }
        focusOnExpandRef.current = true; setExpanded(true);
      }}>
      <img src={overlay.icon} alt="" draggable={false} />
    </button>
    <div hidden={!expanded}>
      <div className="plugin-canvas-overlay-header"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag}
        onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
        <span>{overlay.title}</span>
        <button type="button" aria-label={`Collapse ${overlay.title}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => { setExpanded(false); onFocusDrawing(); }}>−</button>
      </div>
      <PluginPromptSection section={overlay.prompt} onAction={onAction} includeSelected />
      <OverlayStatus overlayId={overlay.id} status={status} statusSource={statusSource} />
      {onOpenPanel ? <button type="button" className="plugin-canvas-overlay-panel" onClick={onOpenPanel}>
        {panelTitle ? `Open ${panelTitle}` : "Open panel"}
      </button> : null}
    </div>
  </div>;
}
