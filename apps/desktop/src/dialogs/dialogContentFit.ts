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
  /** Minimum CSS width, only when the live layout has horizontal overflow. */
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
  const contentWidth = overflowWidth > 0 ? Math.ceil(liveRect.width + overflowWidth) : undefined;
  const restores = [
    // Intrinsic grid rows avoid WebKit's viewport-constrained flex cross/track sizes, including
    // nested labels and native closed selects. Keep the actual width, gaps, margins and padding.
    overrideStyles(element, { display: "grid", "grid-template-columns": "minmax(0, 1fr)", "grid-template-rows": "none", "grid-auto-rows": "max-content", "align-content": "start", height: "auto", "min-height": "0px", "max-height": "none" }),
    ...bodies.map(body => overrideStyles(body, { height: "max-content", "max-height": "none", "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto", "min-height": "0px", overflow: "visible" }))
  ];
  try {
    const rect = element.getBoundingClientRect();
    const contentHeight = Math.ceil(Math.max(liveContentHeight,
      rect.top + (view?.scrollY ?? 0) + Math.max(rect.height, element.scrollHeight) + marginBottom));
    const fit = { contentHeight, ...(contentWidth === undefined ? {} : { contentWidth }), pixelRatio: view?.devicePixelRatio || 1 };
    return validDialogContentFit(fit) ? fit : undefined;
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
  return element.isConnected ? measureDialogContent(element) : undefined;
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
  element.ownerDocument.defaultView?.addEventListener("resize", schedule);
  // Covers changes committed while the initial ready IPC was in flight.
  schedule();
  return () => {
    stopped = true;
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
