import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type RefObject } from "react";
import type { PluginCanvasOverlayContribution, PluginOverlayTranscriptEntry, PluginOverlayContentSection } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

import { PluginPromptSection, PluginReportRenderer } from "./PluginReportRenderer";
import { isBrowserReloadChord } from "../keyboardShortcuts";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";
import { isScrolledToBottom } from "./pluginPanelAutoscroll";

type Position = { x: number; y: number };
type Mode = "collapsed" | "expanded";
type Positions = Record<Mode, Position | null>;
const ICON_SIZE = 36;
const DRAG_THRESHOLD = 4;
const MIN_CHAT_HEIGHT = 220;

function readHeight(key: string): number {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (typeof saved === "number" && Number.isFinite(saved) && saved >= MIN_CHAT_HEIGHT) return saved;
  } catch { /* Optional persistence. */ }
  return MIN_CHAT_HEIGHT;
}

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
const emptyTranscript: readonly PluginOverlayTranscriptEntry[] = Object.freeze([]);
const emptyContent: readonly PluginOverlayContentSection[] = Object.freeze([]);
type CanvasOverlayContentSource = {
  getCanvasOverlayContents: () => ReadonlyMap<string, readonly PluginOverlayContentSection[]>;
  subscribeCanvasOverlayContent: (listener: () => void) => () => void;
};
type CanvasOverlayOpenSource = {
  getCanvasOverlayOpenRequests: () => ReadonlyMap<string, { readonly focus: boolean }>;
  subscribeCanvasOverlayOpen: (listener: () => void) => () => void;
};
type CanvasOverlayTranscriptSource = {
  getCanvasOverlayTranscripts: () => ReadonlyMap<string, readonly PluginOverlayTranscriptEntry[]>;
  subscribeCanvasOverlayTranscript: (listener: () => void) => () => void;
};

function OverlayTranscript({ overlayId, source, expanded }: {
  overlayId: string; source: CanvasOverlayTranscriptSource | undefined; expanded: boolean;
}) {
  const entries = useSyncExternalStore(source?.subscribeCanvasOverlayTranscript ?? subscribeNever,
    () => source?.getCanvasOverlayTranscripts().get(overlayId) ?? emptyTranscript,
    () => emptyTranscript);
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (expanded && atBottom.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries, expanded]);
  return <div className="plugin-canvas-overlay-transcript" role="log" aria-label="Conversation"
    ref={ref} onScroll={() => { if (ref.current) atBottom.current = isScrolledToBottom(ref.current); }}>
    {entries.map((entry, index) => <div key={index} data-role={entry.role}
      className={`plugin-canvas-overlay-entry${entry.role === "error" ? " plugin-report-composer-error" : ""}`}>
      <strong>{entry.role === "user" ? "You" : entry.role[0]!.toUpperCase() + entry.role.slice(1)}</strong>
      <span>{entry.text}</span>
    </div>)}
  </div>;
}

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
  overlayLayerRef, statusRowRef, statusSource, transcriptSource, contentSource, openSource, onOpenPanel, panelTitle, onFocusDrawing, shortcutPlatform, windowId = window.name || "main" }: {
  overlay: PluginCanvasOverlayContribution;
  viewportRef: RefObject<HTMLElement | null>;
  /** The positioned layer and bottom workspace chrome define the visible drawing area. */
  overlayLayerRef?: RefObject<HTMLElement | null>;
  statusRowRef?: RefObject<HTMLElement | null>;
  gestureActive: boolean;
  status?: string;
  /** Status updates subscribe inside the overlay, never through MainWindow's toolset synchronizer. */
  statusSource?: CanvasOverlayStatusSource;
  /** Transcript updates likewise bypass contribution/toolset synchronization. */
  transcriptSource?: CanvasOverlayTranscriptSource;
  contentSource?: CanvasOverlayContentSource;
  openSource?: CanvasOverlayOpenSource;
  onAction: PluginPanelActionHandler;
  onOpenPanel?: () => void;
  /** The contributed panel's live title, supplied by the document window. */
  panelTitle?: string;
  onFocusDrawing: () => void;
  windowId?: string;
  shortcutPlatform?: ShortcutPlatform;
}) {
  const storageKey = `chemdraft:canvas-overlay:${windowId}:${overlay.id}`;
  const [height, setHeight] = useState(() => readHeight(`${storageKey}:height`));
  const [displayHeight, setDisplayHeight] = useState(height);
  const content = useSyncExternalStore(contentSource?.subscribeCanvasOverlayContent ?? subscribeNever,
    () => contentSource?.getCanvasOverlayContents().get(overlay.id) ?? emptyContent, () => emptyContent);
  const openRequest = useSyncExternalStore(openSource?.subscribeCanvasOverlayOpen ?? subscribeNever,
    () => openSource?.getCanvasOverlayOpenRequests().get(overlay.id), () => undefined);
  const [expanded, setExpanded] = useState(false);
  const [positions, setPositions] = useState<Positions>(() => ({
    collapsed: readPosition(`${storageKey}:collapsed`),
    // The old shared key was written only by header drags, so migrate it to the box, never the icon.
    expanded: readPosition(`${storageKey}:expanded`) ?? readPosition(storageKey)
  }));
  const mode: Mode = expanded ? "expanded" : "collapsed";
  const position = positions[mode];
  const elementRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusOnExpandRef = useRef(false);
  const expandedSizeRef = useRef({ width: 300, height: 220 });
  const anchorNextExpansionRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; start: Position; origin: Position; mode: Mode; moved: boolean } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startY: number; height: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!openRequest) return;
    focusOnExpandRef.current = openRequest.focus;
    setExpanded(true);
  }, [openRequest]);
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
      const available = Math.max(0, bounds.bottom - bounds.top);
      const contentHeight = contentRef.current?.firstElementChild?.scrollHeight ?? 0;
      const fittedHeight = Math.min(available, content.length > 0
        ? Math.max(height, Math.min(MIN_CHAT_HEIGHT + contentHeight, Math.floor(available * 0.7)))
        : height);
      setDisplayHeight(fittedHeight);
      if (expanded) element.style.height = `${fittedHeight}px`;
      const size = element.getBoundingClientRect();
      if (expanded) expandedSizeRef.current = {
        width: Math.min(size.width || 300, Math.max(0, bounds.right - bounds.left)),
        height: fittedHeight
      };
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
    if (contentRef.current?.firstElementChild) observer?.observe(contentRef.current.firstElementChild);
    if (overlayLayerRef?.current) observer?.observe(overlayLayerRef.current);
    if (statusRowRef?.current) observer?.observe(statusRowRef.current);
    for (const ruler of viewport.querySelectorAll<HTMLElement>(".ruler-left, .ruler-top, .ruler-corner")) observer?.observe(ruler);
    window.addEventListener("resize", fit);
    if (expanded && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      element.querySelector("textarea")?.focus({ preventScroll: true });
    }
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [expanded, gestureActive, height, content, openRequest, overlay.defaultCorner, overlayLayerRef, statusRowRef, viewportRef]);

  useEffect(() => {
    try { window.localStorage.setItem(`${storageKey}:height`, JSON.stringify(height)); } catch { /* Optional persistence. */ }
  }, [height, storageKey]);

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
  const startResize = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    const currentHeight = expandedSizeRef.current.height;
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, height: currentHeight,
      bottom: (position?.y ?? drawingArea().top) + currentHeight };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const bounds = drawingArea();
    const bottom = Math.min(resize.bottom, bounds.bottom);
    const available = Math.max(0, bottom - bounds.top);
    const nextHeight = Math.min(available, Math.max(MIN_CHAT_HEIGHT, resize.height + resize.startY - event.clientY));
    expandedSizeRef.current.height = nextHeight;
    setHeight(Math.max(MIN_CHAT_HEIGHT, nextHeight));
    setPositions(current => ({ ...current, expanded: clampPosition({
      x: current.expanded?.x ?? bounds.left, y: bottom - nextHeight
    }, "expanded") }));
  };
  const stopResize = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div
    ref={elementRef}
    className="plugin-canvas-overlay"
    data-expanded={expanded}
    hidden={gestureActive}
    style={{ ...(position ? { left: position.x, top: position.y } : { right: 12, bottom: 12 }),
      height: expanded ? displayHeight : undefined }}
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
    <div className="plugin-canvas-overlay-chat" hidden={!expanded}>
      <div className="plugin-canvas-overlay-resize" aria-label="Resize conversation"
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize}
        onPointerCancel={stopResize} onLostPointerCapture={stopResize} />
      <div className="plugin-canvas-overlay-header"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag}
        onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
        <span>{overlay.title}</span>
        <button type="button" aria-label={`Collapse ${overlay.title}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => { setExpanded(false); onFocusDrawing(); }}>−</button>
      </div>
      <PluginPromptSection section={{ ...overlay.prompt, rows: 1 }} onAction={onAction} includeSelected />
      {content.length > 0 ? <div className="plugin-canvas-overlay-content" ref={contentRef}>
        <PluginReportRenderer report={{ title: overlay.title, sections: [...content] }} onAction={onAction} />
      </div> : null}
      <OverlayTranscript overlayId={overlay.id} source={transcriptSource} expanded={expanded} />
      <OverlayStatus overlayId={overlay.id} status={status} statusSource={statusSource} />
      {onOpenPanel && overlay.showPanelLink !== false ? <button type="button" className="plugin-canvas-overlay-panel" onClick={onOpenPanel}>
        {panelTitle ? `Open ${panelTitle}` : "Open panel"}
      </button> : null}
    </div>
  </div>;
}
