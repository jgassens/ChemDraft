import { useEffect, useRef } from "react";

/**
 * Content-fit sizing for native dialogs whose host spec opts in (`fit_content` in dialog_windows.rs).
 * The form measures its rendered height after fonts are ready and whenever its content changes.
 * The host fits the inner height on `ready`, clamped to the work area. The form itself is a
 * `.cd-dialog-fit` column (or Export's grid) whose `.cd-dialog-fit-body` scrolls above a pinned footer, so
 * content that grows after the measurement, or a window clamped shorter, never hides the buttons.
 */
export interface DialogContentFit {
  /** Rendered content height in CSS pixels, rounded up. */
  contentHeight: number;
  /** Intrinsic minimum CSS width, including any live horizontal overflow. */
  contentWidth?: number;
  /** `devicePixelRatio` at measurement: CSS px × ratio = physical px, so WebView zoom and text scaling are covered. */
  pixelRatio: number;
}

/** Same caps as `ContentFit` in dialog_windows.rs: a payload outside them is not a dialog's height. */
export const DIALOG_CONTENT_MAX_HEIGHT = 4096;
export const DIALOG_CONTENT_MAX_WIDTH = 4096;
export const DIALOG_PIXEL_RATIO_MIN = 0.5;
export const DIALOG_PIXEL_RATIO_MAX = 8;
export const DIALOG_FONTS_READY_TIMEOUT_MS = 1000;

export function validDialogContentFit(v: unknown): v is DialogContentFit {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const value = v as Record<string, unknown>;
  return Object.keys(value).every(key => ["contentHeight", "contentWidth", "pixelRatio"].includes(key)) &&
    typeof value.contentHeight === "number" && Number.isFinite(value.contentHeight) &&
    value.contentHeight > 0 && value.contentHeight <= DIALOG_CONTENT_MAX_HEIGHT &&
    (value.contentWidth === undefined || (typeof value.contentWidth === "number" && Number.isFinite(value.contentWidth) &&
      value.contentWidth > 0 && value.contentWidth <= DIALOG_CONTENT_MAX_WIDTH)) &&
    typeof value.pixelRatio === "number" && Number.isFinite(value.pixelRatio) &&
    value.pixelRatio >= DIALOG_PIXEL_RATIO_MIN && value.pixelRatio <= DIALOG_PIXEL_RATIO_MAX;
}

/** Set inline `!important` overrides; the returned function restores the `style` attribute verbatim. */
function overrideStyles(element: HTMLElement, overrides: Record<string, string>): () => void {
  const saved = element.getAttribute("style");
  for (const [name, value] of Object.entries(overrides)) element.style.setProperty(name, value, "important");
  return () => {
    if (saved === null) element.removeAttribute("style");
    else element.setAttribute("style", saved);
  };
}

const unconstrainedRootStyles = { height: "auto", "min-height": "0px", "max-height": "none" };
const gridProbeStyles = { display: "grid", "grid-template-columns": "minmax(0, 1fr)", "grid-template-rows": "none", "grid-auto-rows": "max-content", "align-content": "start", ...unconstrainedRootStyles };
const unconstrainedBodyStyles = { height: "max-content", "max-height": "none", "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto", "min-height": "0px", overflow: "visible" };
// Diagnostic probes must not turn their temporary style writes into content-change notifications.
const pauseContentMutations = new WeakMap<HTMLElement, (read: () => void) => void>();

/** DIAGNOSTIC ONLY: neither probe here supplies a fit or changes the native window size. */
export function readDialogFitDomTrace(element: HTMLElement, contentHeight: number | undefined, phase: "resize" | "settled") {
  const read = () => {
    const document = element.ownerDocument;
    const view = document.defaultView!;
    const bodies = Array.from(element.querySelectorAll<HTMLElement>(".cd-dialog-fit-body"));
    const rect = element.getBoundingClientRect();
    // Export's inline-styled footer is the last direct child; other fit forms mark theirs.
    const footer = element.querySelector<HTMLElement>(".cd-dialog-fit-footer, footer") ??
      (element.matches(".cd-export-fit") ? element.lastElementChild as HTMLElement | null : null);
    const footerBottom = footer?.getBoundingClientRect().bottom ?? null;
    const live = {
      phase, innerWidth: view.innerWidth, innerHeight: view.innerHeight, devicePixelRatio: view.devicePixelRatio,
      documentElementClientHeight: document.documentElement.clientHeight,
      root: { top: rect.top, height: rect.height, bottom: rect.bottom, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight },
      scrollingBodies: bodies.map(body => ({ scrollHeight: body.scrollHeight, clientHeight: body.clientHeight })),
      footer: { bottom: footerBottom, innerHeight: view.innerHeight, bottomMinusInnerHeight: footerBottom === null ? null : footerBottom - view.innerHeight },
      contentHeight: contentHeight ?? null
    };
    const probe = (rootStyles: Record<string, string>) => {
      const restores = [overrideStyles(element, rootStyles), ...bodies.map(body => overrideStyles(body, unconstrainedBodyStyles))];
      try {
        const probeRect = element.getBoundingClientRect();
        const marginBottom = Number.parseFloat(view.getComputedStyle(element).marginBottom) || 0;
        return Math.ceil(probeRect.top + view.scrollY + Math.max(probeRect.height, element.scrollHeight) + marginBottom);
      } finally { for (const restore of restores.reverse()) restore(); }
    };
    return { ...live, gridProbeHeight: probe(gridProbeStyles), originalLayoutHeight: probe(unconstrainedRootStyles) };
  };
  let trace: ReturnType<typeof read> | undefined;
  const capture = () => { trace = read(); };
  const pause = pauseContentMutations.get(element);
  if (pause) pause(capture); else capture();
  return trace!;
}

/** Arm before ready IPC: the resize may arrive before that IPC resolves. One pair per ready. */
export function observeDialogFitDomTrace(
  element: HTMLElement,
  getContentHeight: () => number | undefined,
  send: (trace: ReturnType<typeof readDialogFitDomTrace>) => void
): () => void {
  const view = element.ownerDocument.defaultView;
  let captured = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capture = (phase: "resize" | "settled") => {
    if (element.isConnected) send(readDialogFitDomTrace(element, getContentHeight(), phase));
  };
  const resized = () => {
    if (captured) return;
    captured = true;
    view?.removeEventListener("resize", resized);
    capture("resize");
    timer = setTimeout(() => capture("settled"), 500);
  };
  view?.addEventListener("resize", resized);
  return () => { view?.removeEventListener("resize", resized); clearTimeout(timer); };
}

/**
 * The element's natural height, from the top of the viewport: its CSS height and minimum height
 * (`100vh`) are lifted while measuring, so a window taller than the content does not measure as
 * content, and its scrolling bodies are unclipped, so content they would scroll counts too;
 * overflowing children count through `scrollHeight`. Also check the live scrolling layout:
 * WebKit can give the temporary intrinsic grid less height than the restored flex/grid needs.
 * A nested scrollport's overflow does not contribute to the root's `scrollHeight`.
 */
export function measureDialogContent(element: HTMLElement): DialogContentFit | undefined {
  const view = element.ownerDocument.defaultView;
  const bodies = Array.from(element.querySelectorAll<HTMLElement>(".cd-dialog-fit-body"));
  const liveRect = element.getBoundingClientRect();
  const marginBottom = view ? Number.parseFloat(view.getComputedStyle(element).marginBottom) || 0 : 0;
  const top = liveRect.top + (view?.scrollY ?? 0);
  // Only use the live viewport as a floor when it actually clips content. Otherwise a large
  // remembered window would be mistaken for intrinsic content and could never shrink to fit.
  const overflow = bodies.reduce((total, body) => total + Math.max(0, body.scrollHeight - body.clientHeight), 0);
  const liveContentHeight = overflow > 0 ? top + liveRect.height + overflow + marginBottom : 0;
  const overflowWidth = Math.max(0, element.scrollWidth - element.clientWidth,
    ...bodies.map(body => body.scrollWidth - body.clientWidth));
  // Read before lifting the body's overflow constraint. Ellipsis is a deliberate choice to
  // clip text, not a request to fit all of it. Keep its declared minimum (including percentages)
  // and a small width floor during the intrinsic probe, without affecting height measurement.
  const clippedText = view ? Array.from(element.querySelectorAll<HTMLElement>("*")).flatMap(child => {
    const css = view.getComputedStyle(child);
    const overflowX = css.overflowX || css.overflow.split(" ")[0];
    return /\bellipsis\b/.test(css.textOverflow) && ["hidden", "clip"].includes(overflowX)
      ? [{ child, minWidth: css.minWidth && css.minWidth !== "auto" ? css.minWidth : "32px" }] : [];
  }) : [];
  const restores = [
    // Intrinsic grid rows avoid WebKit's viewport-constrained flex cross/track sizes, including
    // nested labels and native closed selects. Keep the actual width, gaps, margins and padding.
    overrideStyles(element, gridProbeStyles),
    ...bodies.map(body => overrideStyles(body, unconstrainedBodyStyles))
  ];
  try {
    const rect = element.getBoundingClientRect();
    const contentHeight = Math.ceil(Math.max(liveContentHeight,
      rect.top + (view?.scrollY ?? 0) + Math.max(rect.height, element.scrollHeight) + marginBottom));
    // Measure width independently of the viewport. Reporting overflow alone loses the minimum
    // as soon as a successful native fit removes that overflow, allowing the next drag to clip.
    // min-content keeps wrapping available and does not turn a larger user window into a minimum.
    const restoreWidth = overrideStyles(element, { width: "min-content", "min-width": "0px", "max-width": "none", "grid-template-columns": "min-content" });
    const restoreClippedText = clippedText.map(({ child, minWidth }) => overrideStyles(child, {
      width: "32px", "min-width": minWidth
    }));
    let minimumWidth: number;
    try { minimumWidth = element.getBoundingClientRect().width; }
    finally {
      for (const restore of restoreClippedText.reverse()) restore();
      restoreWidth();
    }
    const width = Math.ceil(Math.max(minimumWidth || 0, overflowWidth > 0 ? liveRect.width + overflowWidth : 0));
    // Keep valid height/DPI data even when unwrapped content exceeds the protocol bound.
    // Native placement further caps this width to the destination work area and decorations.
    const contentWidth = width > 0 ? Math.min(width, DIALOG_CONTENT_MAX_WIDTH) : undefined;
    const pixelRatio = view?.devicePixelRatio || 1;
    const fit = { contentHeight, ...(contentWidth === undefined ? {} : { contentWidth }), pixelRatio };
    if (validDialogContentFit(fit)) return fit;
    const reason = !Number.isFinite(contentHeight) || contentHeight <= 0 || contentHeight > DIALOG_CONTENT_MAX_HEIGHT
      ? `contentHeight must be finite and in (0, ${DIALOG_CONTENT_MAX_HEIGHT}]`
      : contentWidth !== undefined && !Number.isFinite(contentWidth)
        ? "contentWidth must be finite"
        : `pixelRatio must be finite and in [${DIALOG_PIXEL_RATIO_MIN}, ${DIALOG_PIXEL_RATIO_MAX}]`;
    console.warn(`[dialog-fit] measureDialogContent returned undefined: ${reason}; contentHeight=${contentHeight} contentWidth=${contentWidth} pixelRatio=${pixelRatio} connected=${element.isConnected}`);
    return undefined;
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

/** Measure after web fonts settle, bounded: a hidden webview must still report ready promptly. */
export async function measureDialogContentWhenFontsReady(
  element: HTMLElement,
  fonts: { ready: Promise<unknown> } | undefined = element.ownerDocument.fonts,
  timeoutMs = DIALOG_FONTS_READY_TIMEOUT_MS
): Promise<DialogContentFit | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts?.ready.catch(() => undefined) ?? Promise.resolve(),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (element.isConnected) return measureDialogContent(element);
  console.warn("[dialog-fit] measureDialogContentWhenFontsReady returned undefined: content element disconnected while waiting for fonts");
  return undefined;
}

/** Watch descendants too: the root and scrolling body can stay viewport-sized as text grows. */
export function observeDialogContent(
  element: HTMLElement,
  initial: DialogContentFit | undefined,
  onChange: (fit: DialogContentFit) => void
): () => void {
  let last = initial;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    // Hidden webviews suspend animation frames; a task also coalesces a React commit's mutations.
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !element.isConnected) return;
      mutations?.disconnect(); // Measurement's temporary style overrides are not content changes.
      const fit = measureDialogContent(element);
      watch();
      if (fit && (fit.contentHeight !== last?.contentHeight || fit.contentWidth !== last?.contentWidth || fit.pixelRatio !== last?.pixelRatio)) {
        last = fit;
        onChange(fit);
      }
    }, 0);
  };
  const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
  const observed = new Set<Element>();
  const watch = () => {
    for (const child of observed) {
      if (child !== element && !element.contains(child)) { sizes?.unobserve(child); observed.delete(child); }
    }
    for (const child of [element, ...element.querySelectorAll<HTMLElement>("*")]) {
      if (!observed.has(child)) { sizes?.observe(child); observed.add(child); }
    }
    mutations?.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  watch();
  pauseContentMutations.set(element, read => {
    // Preserve any real content change queued before the diagnostic probe.
    if (mutations?.takeRecords().length) schedule();
    mutations?.disconnect();
    try { read(); } finally { if (!stopped) watch(); }
  });
  element.ownerDocument.defaultView?.addEventListener("resize", schedule);
  // Covers changes committed while the initial ready IPC was in flight.
  schedule();
  return () => {
    stopped = true;
    pauseContentMutations.delete(element);
    clearTimeout(timer);
    sizes?.disconnect();
    mutations?.disconnect();
    element.ownerDocument.defaultView?.removeEventListener("resize", schedule);
  };
}

/** One committed root per form; hidden webviews must not wait for animation frames. */
export function useDialogContentReady<T extends HTMLElement>(onReady?: (element: T) => void) {
  const root = useRef<T>(null);
  const reported = useRef(false);
  useEffect(() => {
    if (!reported.current && root.current && onReady) {
      reported.current = true;
      onReady(root.current);
    }
  }, [onReady]);
  return root;
}
