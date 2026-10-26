import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type RefObject } from "react";
import type { PluginCanvasOverlayContribution, PluginOverlayTranscriptEntry, PluginOverlayContentSection } from "@chemdraft/plugin-api";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";

import { PluginPromptSection, PluginReportRenderer } from "./PluginReportRenderer";
import { isBrowserReloadChord } from "../keyboardShortcuts";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";
import { isScrolledToBottom } from "./pluginPanelAutoscroll";
import { PluginInlineMarkdown } from "./PluginInlineMarkdown";
import { canvasOverlayPrompt, OVERLAY_BUSY_MESSAGE, type CanvasOverlayContentSection, type CanvasOverlayDraftRestore } from "./pluginCanvasOverlayControls";

type Position = { x: number; y: number };
type Mode = "collapsed" | "expanded";
type Positions = Record<Mode, Position | null>;
const ICON_SIZE = 36;
const DRAG_THRESHOLD = 4;
const MIN_CHAT_HEIGHT = 220;
// Leave about three 16px transcript lines above the composer and primary controls.
const DEFAULT_CHAT_HEIGHT = 280;
const PALETTE_CLEARANCE = 72;

function readHeight(key: string): number {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (typeof saved === "number" && Number.isFinite(saved) && saved >= 0) return saved;
  } catch { /* Optional persistence. */ }
  return DEFAULT_CHAT_HEIGHT;
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
  getCanvasOverlayContents: () => ReadonlyMap<string, readonly CanvasOverlayContentSection[]>;
  getCanvasOverlayDraftRestore?: (overlayId: string) => CanvasOverlayDraftRestore | undefined;
  clearCanvasOverlayDraftRestore?: (overlayId: string, expected?: CanvasOverlayDraftRestore) => boolean;
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

function OverlayTranscript({ overlayId, source, expanded, ownSubmit, height }: {
  overlayId: string; source: CanvasOverlayTranscriptSource | undefined; expanded: boolean; ownSubmit: number; height: number;
}) {
  const entries = useSyncExternalStore(source?.subscribeCanvasOverlayTranscript ?? subscribeNever,
    () => source?.getCanvasOverlayTranscripts().get(overlayId) ?? emptyTranscript,
    () => emptyTranscript);
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => { atBottom.current = true; }, [ownSubmit]);
  useLayoutEffect(() => {
    if (expanded && atBottom.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries, expanded, ownSubmit, height]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!expanded || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return <div className="plugin-canvas-overlay-transcript" role="log" aria-label="Conversation"
    ref={ref} onScroll={() => { if (ref.current) atBottom.current = isScrolledToBottom(ref.current); }}>
    {entries.map((entry, index) => <div key={index} data-role={entry.role}
      className={`plugin-canvas-overlay-entry${entry.role === "error" ? " plugin-report-composer-error" : ""}`}>
      <strong>{entry.role === "user" ? "You" : entry.role[0]!.toUpperCase() + entry.role.slice(1)}</strong>
      <span><PluginInlineMarkdown text={entry.text} /></span>
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
  overlayLayerRef, statusRowRef, statusSource, transcriptSource, contentSource, openSource, onInitialize, onOpenPanel, panelTitle, onFocusDrawing, shortcutPlatform, requestPending = false, documentState, windowId = window.name || "main" }: {
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
  /** Invoke the plugin's declared menu opener when an icon expansion has no live content. */
  onInitialize?: () => Promise<void>;
  onOpenPanel?: () => void;
  /** The contributed panel's live title, supplied by the document window. */
  panelTitle?: string;
  onFocusDrawing: () => void;
  windowId?: string;
  shortcutPlatform?: ShortcutPlatform;
  /** The host acknowledges Send before its command completes. */
  requestPending?: boolean;
  /** A document edit or switch invalidates an earlier busy refusal, without discarding the draft. */
  documentState?: unknown;
}) {
  const storageKey = `chemdraft:canvas-overlay:${windowId}:${overlay.id}`;
  const [height, setHeight] = useState(() => readHeight(`${storageKey}:height`));
  const [displayHeight, setDisplayHeight] = useState(height);
  const [autoFitContent, setAutoFitContent] = useState(true);
  const [initializationError, setInitializationError] = useState<string>();
  const initializing = useRef(false);
  const [ownSubmit, setOwnSubmit] = useState(0);
  const content = useSyncExternalStore(contentSource?.subscribeCanvasOverlayContent ?? subscribeNever,
    () => contentSource?.getCanvasOverlayContents().get(overlay.id) ?? emptyContent, () => emptyContent);
  const draftRestore = useSyncExternalStore(contentSource?.subscribeCanvasOverlayContent ?? subscribeNever,
    () => contentSource?.getCanvasOverlayDraftRestore?.(overlay.id), () => undefined);
  const firstActions = content.find(section => section.kind === "actions");
  const scrollingContent = content.filter(section => section !== firstActions && section.kind !== "prompt");
  const prompt = canvasOverlayPrompt(overlay, content);
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
  useEffect(() => {
    const element = elementRef.current;
    // A cancelled pointerdown suppresses compatibility mousedown in Chromium/WebKit.
    // selectstart is native (React has no corresponding event prop).
    const preventChromeSelection = (event: Event) => {
      const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
      if (target?.closest(".plugin-canvas-overlay-header, .plugin-canvas-overlay-resize")) event.preventDefault();
    };
    element?.addEventListener("selectstart", preventChromeSelection);
    return () => element?.removeEventListener("selectstart", preventChromeSelection);
  }, []);
  const compositionExpiryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composingCanvasRef = useRef<{ element: HTMLElement; tabIndex: string | null } | null>(null);
  const clearComposition = () => {
    if (compositionExpiryRef.current !== undefined) clearTimeout(compositionExpiryRef.current);
    compositionExpiryRef.current = undefined;
    if (elementRef.current) delete elementRef.current.dataset.composing;
    const canvas = composingCanvasRef.current;
    composingCanvasRef.current = null;
    if (canvas && canvas.tabIndex !== null) canvas.element.setAttribute("tabindex", canvas.tabIndex);
  };
  const trackComposition = () => {
    if (compositionExpiryRef.current !== undefined) clearTimeout(compositionExpiryRef.current);
    if (elementRef.current) elementRef.current.dataset.composing = "true";
    const canvas = viewportRef.current;
    if (canvas && !composingCanvasRef.current) {
      composingCanvasRef.current = { element: canvas, tabIndex: canvas.getAttribute("tabindex") };
      // Cancelling pointerdown does not stop every engine's focus default. Prevent
      // the blur itself: refocusing cannot recover a native IME composition.
      canvas.removeAttribute("tabindex");
    }
    // compositionend can be lost even after a real compositionstart. Input and
    // composition updates renew this idle guard; an orphan must not trap focus.
    compositionExpiryRef.current = setTimeout(clearComposition, 10000);
  };
  useEffect(() => {
    const element = elementRef.current;
    // React has no compositioncancel prop; listen to the native cancellation as well.
    element?.addEventListener("compositioncancel", clearComposition, true);
    return () => {
      element?.removeEventListener("compositioncancel", clearComposition, true);
      clearComposition();
    };
  }, []);
  const focusOnExpandRef = useRef(false);
  const clickedActionRef = useRef<Element | null>(null);
  const activatedActionRef = useRef<{ button: Element | null } | null>(null);
  const expandedSizeRef = useRef({ width: 300, height: 220 });
  const anchorNextExpansionRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; start: Position; origin: Position; mode: Mode; moved: boolean } | null>(null);
  const resizeRef = useRef<{ pointerId: number; owner: HTMLElement; startY: number; height: number; bottom: number; cleanup: () => void } | null>(null);
  const endResize = () => {
    const resize = resizeRef.current;
    resizeRef.current = null;
    resize?.cleanup();
    if (resize?.owner.hasPointerCapture?.(resize.pointerId)) resize.owner.releasePointerCapture(resize.pointerId);
  };
  useEffect(() => {
    window.addEventListener("blur", endResize);
    return () => { window.removeEventListener("blur", endResize); endResize(); };
  }, []);
  useLayoutEffect(() => {
    if (!expanded || gestureActive) endResize();
  }, [expanded, gestureActive]);
  useEffect(() => {
    const trackPointer = (event: globalThis.PointerEvent) => {
      // A later click (including on a nonfocusable canvas) is user intent. Native/programmatic
      // focus handbacks are not. A new action will arm its own token after this pointerdown.
      if (event.target !== activatedActionRef.current?.button) activatedActionRef.current = null;
    };
    const trackKeyboard = (event: globalThis.KeyboardEvent) => {
      if (!event.isComposing && ["Tab", "F6", "Escape"].includes(event.key)) activatedActionRef.current = null;
    };
    const trackFocus = () => {
      // Removal can trigger a later host/native canvas focus handback as well as body's fallback.
      // Only an activated, removed control owns this recovery; a merely tabbed-to control does not.
      restoreActionFocus(true);
    };
    document.addEventListener("focusin", trackFocus, true);
    document.addEventListener("pointerdown", trackPointer, true);
    document.addEventListener("keydown", trackKeyboard, true);
    return () => {
      document.removeEventListener("focusin", trackFocus, true);
      document.removeEventListener("pointerdown", trackPointer, true);
      document.removeEventListener("keydown", trackKeyboard, true);
      activatedActionRef.current = null;
    };
  }, []);
  const restoreActionFocus = (replacementOnly = false) => {
    const element = elementRef.current;
    const action = activatedActionRef.current;
    if (action && element?.dataset.expanded === "true" && !element.hidden
      && (!replacementOnly || (action.button && !action.button.isConnected))) {
      const textarea = element.querySelector("textarea");
      if (textarea !== document.activeElement) textarea?.focus({ preventScroll: true });
    }
  };
  // Content updates restore only a removed, activated button; mounted controls retain focus.
  useLayoutEffect(() => restoreActionFocus(true), [content, expanded, gestureActive]);
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
    const viewportLeft = viewport.left + viewportElement.clientLeft;
    const viewportTop = viewport.top + viewportElement.clientTop;
    let left = Math.max(0, viewportLeft, layer.left);
    let top = Math.max(0, viewportTop, layer.top);
    let right = Math.min(window.innerWidth, layer.right, viewportLeft + (viewportElement.clientWidth || viewport.width));
    let bottom = Math.min(window.innerHeight, layer.bottom, viewportTop + (viewportElement.clientHeight || viewport.height));
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
    const top = targetMode === "expanded" ? Math.min(bounds.bottom, bounds.top + PALETTE_CLEARANCE) : bounds.top;
    const { width, height } = targetMode === "expanded" ? expandedSizeRef.current : { width: ICON_SIZE, height: ICON_SIZE };
    return {
      x: Math.max(bounds.left, Math.min(point.x, Math.max(bounds.left, bounds.right - width))),
      y: Math.max(top, Math.min(point.y, Math.max(top, bounds.bottom - height)))
    };
  };

  const fitRef = useRef<() => void>(() => undefined);
  const fitObserverRef = useRef<ResizeObserver | undefined>(undefined);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const element = elementRef.current;
    if (!viewport || !element || gestureActive) { fitRef.current = () => undefined; return; }
    const fit = () => {
      const bounds = drawingArea();
      if (bounds.bottom <= bounds.top) return;
      // Size to the drawing area, not the larger overlay layer behind rulers/status/scrollbars.
      element.style.maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`;
      const available = Math.max(0, bounds.bottom - bounds.top - PALETTE_CLEARANCE);
      element.style.maxHeight = `${expanded ? available : Math.max(0, bounds.bottom - bounds.top)}px`;
      // Fitting changes only the displayed size; the user's height returns when space permits.
      const rememberedHeight = Math.min(height, available);
      const contentHeight = contentRef.current?.firstElementChild?.scrollHeight ?? 0;
      const fittedHeight = Math.min(available, autoFitContent && content.length > 0
        ? Math.max(rememberedHeight, Math.min(MIN_CHAT_HEIGHT + contentHeight, Math.floor((bounds.bottom - bounds.top) * 0.7)))
        : rememberedHeight);
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
    fitRef.current = fit;
    fit();
    if (expanded && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      element.querySelector("textarea")?.focus({ preventScroll: true });
    }
  }, [expanded, gestureActive, height, autoFitContent, content, openRequest, overlay.defaultCorner, overlayLayerRef, statusRowRef, viewportRef]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const element = elementRef.current;
    if (!viewport || !element) return;
    const fit = () => fitRef.current();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    fitObserverRef.current = observer;
    observer?.observe(viewport);
    observer?.observe(element);
    if (overlayLayerRef?.current) observer?.observe(overlayLayerRef.current);
    if (statusRowRef?.current) observer?.observe(statusRowRef.current);
    for (const ruler of viewport.querySelectorAll<HTMLElement>(".ruler-left, .ruler-top, .ruler-corner")) observer?.observe(ruler);
    window.addEventListener("resize", fit);
    let resolution: MediaQueryList | undefined;
    const watchResolution = () => {
      resolution?.removeEventListener("change", onResolutionChange);
      resolution = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolution?.addEventListener("change", onResolutionChange);
    };
    const onResolutionChange = () => { fit(); watchResolution(); };
    watchResolution();
    return () => {
      observer?.disconnect();
      fitObserverRef.current = undefined;
      window.removeEventListener("resize", fit);
      resolution?.removeEventListener("change", onResolutionChange);
    };
  }, [overlayLayerRef, statusRowRef, viewportRef]);

  useLayoutEffect(() => {
    const child = contentRef.current?.firstElementChild;
    const observer = fitObserverRef.current;
    if (!child || !observer) return;
    observer.observe(child);
    return () => observer.unobserve(child);
  }, [content, overlayLayerRef, statusRowRef, viewportRef]);

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
    if (event.button !== 0 || event.isPrimary === false || (event.target as Element).closest("button")) return;
    event.preventDefault();
    const currentHeight = expandedSizeRef.current.height;
    endResize();
    const owner = event.currentTarget;
    // Capture remains on the grip/header. Also cover a fast move delivered to the document
    // before native capture takes effect; never process an owner event twice.
    const outside = (next: globalThis.PointerEvent) => {
      if (resizeRef.current?.pointerId !== next.pointerId || (next.target instanceof Node && owner.contains(next.target))) return;
      next.stopPropagation();
      if (next.type === "pointermove") updateResize(next);
      else endResize();
    };
    const events = ["pointermove", "pointerup", "pointercancel"] as const;
    const cleanup = () => { for (const type of events) document.removeEventListener(type, outside, true); };
    resizeRef.current = { pointerId: event.pointerId, owner, cleanup, startY: event.clientY, height: currentHeight,
      bottom: (position?.y ?? drawingArea().top) + currentHeight };
    for (const type of events) document.addEventListener(type, outside, true);
    owner.setPointerCapture?.(event.pointerId);
  };
  const updateResize = (event: Pick<PointerEvent<HTMLElement>, "pointerId" | "buttons" | "clientY">) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    // A missed release (for example on leaving the native window) must not keep resizing on hover.
    if (event.buttons === 0) { endResize(); return; }
    const bounds = drawingArea();
    const bottom = Math.min(resize.bottom, bounds.bottom);
    const available = Math.max(0, bottom - bounds.top - PALETTE_CLEARANCE);
    const nextHeight = Math.min(available, Math.max(MIN_CHAT_HEIGHT, resize.height + resize.startY - event.clientY));
    expandedSizeRef.current.height = nextHeight;
    setAutoFitContent(false);
    setHeight(nextHeight);
    setPositions(current => ({ ...current, expanded: clampPosition({
      x: current.expanded?.x ?? bounds.left, y: bottom - nextHeight
    }, "expanded") }));
  };
  const moveResize = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    updateResize(event);
  };
  const stopResize = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    endResize();
  };
  const clearChromeSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const selectable = elementRef.current?.querySelectorAll("textarea, .plugin-canvas-overlay-transcript");
    // Preserve deliberate text selections, including reverse/multi-range selections.
    const insideText = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
      .every(range => Array.from(selectable ?? []).some(element =>
        element.contains(range.startContainer) && element.contains(range.endContainer)));
    if (!insideText) selection.removeAllRanges();
  };
  const resetHeight = () => {
    const bounds = drawingArea();
    const nextHeight = Math.min(DEFAULT_CHAT_HEIGHT, Math.max(0, bounds.bottom - bounds.top - PALETTE_CLEARANCE));
    const bottom = Math.min(bounds.bottom, (position?.y ?? bounds.top) + expandedSizeRef.current.height);
    expandedSizeRef.current.height = nextHeight;
    setAutoFitContent(false);
    setHeight(nextHeight);
    setPositions(current => ({ ...current, expanded: clampPosition({
      x: current.expanded?.x ?? bounds.left, y: bottom - nextHeight
    }, "expanded") }));
  };
  const initialize = async () => {
    if (content.length || !onInitialize || initializing.current) return;
    initializing.current = true;
    setInitializationError(undefined);
    try { await onInitialize(); }
    catch { setInitializationError("The assistant could not be opened. Collapse and reopen it to try again."); }
    finally { initializing.current = false; }
  };
  const runAction: PluginPanelActionHandler = async request => {
    // Click capture identifies the activated control even on macOS, where pointer activation
    // need not focus a button. Each invocation owns its token, so older completions cannot steal it.
    const action = request.control === "button" || request.control === "prompt"
      ? { button: clickedActionRef.current } : null;
    clickedActionRef.current = null;
    if (action) activatedActionRef.current = action;
    try { return await onAction(request); }
    finally {
      if (action && activatedActionRef.current === action) {
        restoreActionFocus();
        activatedActionRef.current = null;
      }
    }
  };
  return <div
    ref={elementRef}
    className="plugin-canvas-overlay"
    data-expanded={expanded}
    onCompositionStartCapture={trackComposition}
    onCompositionUpdateCapture={trackComposition}
    onCompositionEndCapture={clearComposition}
    onInputCapture={event => {
      if ((event.nativeEvent as InputEvent).isComposing || event.currentTarget.dataset.composing === "true") trackComposition();
    }}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || event.currentTarget.dataset.composing === "true") trackComposition();
    }}
    onFocusCapture={event => {
      if (event.target instanceof HTMLTextAreaElement && event.currentTarget.dataset.composing === "true") trackComposition();
    }}
    onBlurCapture={event => {
      if (event.target instanceof HTMLTextAreaElement
        || !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearComposition();
    }}
    hidden={gestureActive}
    style={{ ...(position ? { left: position.x, top: position.y } : { right: 12, bottom: 12 }),
      height: expanded ? displayHeight : undefined }}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onPointerCancel={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onClickCapture={event => {
      clickedActionRef.current = event.target instanceof Element
        ? event.target.closest("button.plugin-report-action") : null;
    }}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => event.stopPropagation()}
    onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (isBrowserReloadChord(event, shortcutPlatform)) event.preventDefault();
      if (event.key !== "Escape" || event.nativeEvent.isComposing || event.currentTarget.dataset.composing === "true") return;
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
        void initialize();
      }}>
      <img src={overlay.icon} alt="" draggable={false} />
    </button>
    <div className="plugin-canvas-overlay-chat" hidden={!expanded}>
      <div className="plugin-canvas-overlay-resize" aria-label="Resize conversation"
        onDoubleClick={clearChromeSelection}
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize}
        onPointerCancel={stopResize} onLostPointerCapture={stopResize} />
      <div className="plugin-canvas-overlay-header"
        title="Drag to resize; double-click to reset height"
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize}
        onPointerCancel={stopResize} onLostPointerCapture={stopResize}
        onDoubleClick={event => { clearChromeSelection(); if (!(event.target as Element).closest("button")) resetHeight(); }}>
        <span>{overlay.title}</span>
        <button type="button" aria-label={`Collapse ${overlay.title}`}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => { setExpanded(false); onFocusDrawing(); }}>−</button>
      </div>
      {firstActions ? <div className="plugin-canvas-overlay-primary-actions">
        <PluginReportRenderer report={{ title: overlay.title, sections: [firstActions] }} onAction={runAction} />
      </div> : null}
      {content.length > 0 ? <div className="plugin-canvas-overlay-content" ref={contentRef}>
        <PluginReportRenderer report={{ title: overlay.title, sections: scrollingContent }} onAction={runAction} />
      </div> : null}
      <OverlayTranscript overlayId={overlay.id} source={transcriptSource} expanded={expanded} ownSubmit={ownSubmit} height={displayHeight} />
      <PluginPromptSection section={{ ...prompt, rows: 1 }} onAction={request => {
        if (request.control === "prompt") setOwnSubmit(value => value + 1);
        return runAction(request);
      }} includeSelected busyMessage={OVERLAY_BUSY_MESSAGE} messageResetKey={documentState} requestPending={requestPending}
        draftRestore={draftRestore}
        onConsumeDraftRestore={restore => contentSource?.clearCanvasOverlayDraftRestore?.(overlay.id, restore) ?? false}
        onDraftChange={() => { contentSource?.clearCanvasOverlayDraftRestore?.(overlay.id); }} />
      <OverlayStatus overlayId={overlay.id} status={status} statusSource={statusSource} />
      {initializationError ? <p role="alert">{initializationError}</p> : null}
      {onOpenPanel && overlay.showPanelLink !== false ? <button type="button" className="plugin-canvas-overlay-panel" onClick={onOpenPanel}>
        {panelTitle ? `Open ${panelTitle}` : "Open panel"}
      </button> : null}
    </div>
  </div>;
}
