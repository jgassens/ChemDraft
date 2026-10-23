import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PluginCanvasOverlayContribution } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

import { PluginPromptSection } from "./PluginReportRenderer";
import { isBrowserReloadChord } from "../keyboardShortcuts";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";

type Position = { x: number; y: number };

/** Host chrome only: actions carry control data; MainWindow resolves the live command declaration. */
export function PluginCanvasOverlay({ overlay, viewportRef, gestureActive, status, onAction,
  onOpenPanel, onFocusDrawing, shortcutPlatform, windowId = window.name || "main" }: {
  overlay: PluginCanvasOverlayContribution;
  viewportRef: RefObject<HTMLElement | null>;
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
  const clampPosition = (point: Position): Position => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    const widget = elementRef.current?.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(point.x, Math.max(0, (viewport?.width ?? 0) - (widget?.width ?? 36)))),
      y: Math.max(0, Math.min(point.y, Math.max(0, (viewport?.height ?? 0) - (widget?.height ?? 36))))
    };
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const element = elementRef.current;
    if (!viewport || !element || gestureActive) return;
    const fit = () => setPosition(current => {
      const bounds = viewport.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      const next = clampPosition(current ?? {
        x: overlay.defaultCorner.endsWith("right") ? bounds.width - size.width - 12 : 12,
        y: overlay.defaultCorner.startsWith("bottom") ? bounds.height - size.height - 12 : 12
      });
      return current?.x === next.x && current.y === next.y ? current : next;
    });
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(viewport);
    observer?.observe(element);
    window.addEventListener("resize", fit);
    if (expanded && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      element.querySelector("textarea")?.focus({ preventScroll: true });
    }
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [expanded, gestureActive, overlay.defaultCorner, viewportRef]);

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
