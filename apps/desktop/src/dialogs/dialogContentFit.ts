/**
 * Content-fit sizing for native dialogs whose host spec opts in (`fit_content` in dialog_windows.rs).
 * The form measures its rendered height once fonts are ready and sends it with `ready`; the host
 * sets the window's inner height to it at reveal, clamped to the work area, and never below it.
 */
export interface DialogContentFit {
  /** Rendered content height in CSS pixels, rounded up. */
  contentHeight: number;
  /** `devicePixelRatio` at measurement: CSS px × ratio = physical px, so WebView zoom and text scaling are covered. */
  pixelRatio: number;
}

export const DIALOG_CONTENT_MAX_HEIGHT = 16384;
export const DIALOG_FONTS_READY_TIMEOUT_MS = 1000;

export function validDialogContentFit(v: unknown): v is DialogContentFit {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const value = v as Record<string, unknown>;
  return Object.keys(value).length === 2 &&
    typeof value.contentHeight === "number" && Number.isFinite(value.contentHeight) &&
    value.contentHeight > 0 && value.contentHeight <= DIALOG_CONTENT_MAX_HEIGHT &&
    typeof value.pixelRatio === "number" && Number.isFinite(value.pixelRatio) && value.pixelRatio > 0 && value.pixelRatio <= 16;
}

/**
 * The element's natural height, from the top of the viewport: its CSS minimum height (for
 * example `100vh`) is lifted while measuring, so a window taller than the content does not
 * measure as content, and overflowing children count through `scrollHeight`.
 */
export function measureDialogContent(element: HTMLElement): DialogContentFit | undefined {
  const view = element.ownerDocument.defaultView;
  const previous = element.style.getPropertyValue("min-height");
  const priority = element.style.getPropertyPriority("min-height");
  element.style.setProperty("min-height", "0px", "important");
  try {
    const rect = element.getBoundingClientRect();
    const marginBottom = view ? Number.parseFloat(view.getComputedStyle(element).marginBottom) || 0 : 0;
    const top = rect.top + (view?.scrollY ?? 0);
    const contentHeight = Math.ceil(top + Math.max(rect.height, element.scrollHeight) + marginBottom);
    const fit = { contentHeight, pixelRatio: view?.devicePixelRatio || 1 };
    return validDialogContentFit(fit) ? fit : undefined;
  } finally {
    if (previous) element.style.setProperty("min-height", previous, priority);
    else element.style.removeProperty("min-height");
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
