import { useEffect, useRef } from "react";

/**
 * Content-fit sizing for native dialogs whose host spec opts in (`fit_content` in dialog_windows.rs).
 * The form measures its rendered height once fonts are ready and sends it with `ready`; the host
 * sets the window's inner height to it at reveal, clamped to the work area. The form itself is a
 * `.cd-dialog-fit` column (or Export's grid) whose `.cd-dialog-fit-body` scrolls above a pinned footer, so
 * content that grows after the measurement, or a window clamped shorter, never hides the buttons.
 */
export interface DialogContentFit {
  /** Rendered content height in CSS pixels, rounded up. */
  contentHeight: number;
  /** `devicePixelRatio` at measurement: CSS px × ratio = physical px, so WebView zoom and text scaling are covered. */
  pixelRatio: number;
}

/** Same caps as `ContentFit` in dialog_windows.rs: a payload outside them is not a dialog's height. */
export const DIALOG_CONTENT_MAX_HEIGHT = 4096;
export const DIALOG_PIXEL_RATIO_MIN = 0.5;
export const DIALOG_PIXEL_RATIO_MAX = 8;
export const DIALOG_FONTS_READY_TIMEOUT_MS = 1000;

export function validDialogContentFit(v: unknown): v is DialogContentFit {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const value = v as Record<string, unknown>;
  return Object.keys(value).length === 2 &&
    typeof value.contentHeight === "number" && Number.isFinite(value.contentHeight) &&
    value.contentHeight > 0 && value.contentHeight <= DIALOG_CONTENT_MAX_HEIGHT &&
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
 * overflowing children count through `scrollHeight`.
 */
export function measureDialogContent(element: HTMLElement): DialogContentFit | undefined {
  const view = element.ownerDocument.defaultView;
  const restores = [
    overrideStyles(element, { height: "auto", "min-height": "0px", "max-height": "none" }),
    ...Array.from(element.querySelectorAll<HTMLElement>(".cd-dialog-fit-body"),
      body => overrideStyles(body, { "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto", "min-height": "0px", overflow: "visible" }))
  ];
  try {
    const rect = element.getBoundingClientRect();
    const marginBottom = view ? Number.parseFloat(view.getComputedStyle(element).marginBottom) || 0 : 0;
    const top = rect.top + (view?.scrollY ?? 0);
    const contentHeight = Math.ceil(top + Math.max(rect.height, element.scrollHeight) + marginBottom);
    const fit = { contentHeight, pixelRatio: view?.devicePixelRatio || 1 };
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
