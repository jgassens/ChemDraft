import { reportToolsetContentSize, type ToolsetContentSize } from "./index";
import { toolbarAxisInsets } from "../toolbars/toolbarMeasurements";

/** Measure only the unconstrained probe. Rust owns fitting, monitor limits and the chosen length. */
export function measurePaletteContent(shell: HTMLElement, orientation: ToolsetContentSize["orientation"]): ToolsetContentSize {
  const natural = shell.querySelector<HTMLElement>(".toolbar-natural-size > .tool-palette");
  const palette = shell.querySelector<HTMLElement>(".tool-palette");
  const body = shell.querySelector<HTMLElement>(".palette-window-content");
  const source = natural ?? palette ?? body ?? shell;
  const rect = source.getBoundingClientRect();
  const title = shell.querySelector<HTMLElement>(".palette-title")?.getBoundingClientRect().height ?? 0;
  const overflow = shell.querySelector<HTMLElement>(".toolbar-overflow-measure")?.getBoundingClientRect();
  const firstElement = source.querySelector<HTMLElement>("[data-toolbar-item-id]");
  const first = firstElement?.getBoundingClientRect();
  const style = getComputedStyle(source);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const axisGap = orientation === "horizontal" ? style.columnGap : style.rowGap;
  const gap = px(!axisGap || axisGap === "normal" ? style.gap : axisGap);
  const padding = orientation === "horizontal" ? px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
    : px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth) + title;
  const group = firstElement?.closest<HTMLElement>(".tool-group");
  const groupStyle = group ? getComputedStyle(group) : undefined;
  const groupInsets = groupStyle ? toolbarAxisInsets(groupStyle, orientation) : { start: 0, end: 0 };
  const grip = source.querySelector<HTMLElement>(".palette-content-drag-grip")?.getBoundingClientRect();
  const gripLength = grip ? (orientation === "horizontal" ? grip.width : grip.height) + gap : 0;
  const minimum = orientation === "horizontal" ? (overflow?.width ?? 24) + (first?.width ?? 24)
    : (overflow?.height ?? 24) + (first?.height ?? 24);
  // Table-only selections have no ToolPalette. Measure the intrinsic sections, never the body
  // stretched to the viewport. A mixed selection appends these sections below its palette.
  const sections = Array.from(body?.children ?? []).filter(child => child !== palette);
  const sectionRects = sections.map(child => child.getBoundingClientRect());
  const width = Math.max(palette ? rect.width : 0, ...sectionRects.map(section => section.width));
  const height = (palette ? rect.height : 0) + sectionRects.reduce((sum, section) => sum + section.height, 0);
  return { orientation, width: Math.max(1, Math.ceil(body ? width : rect.width)),
    height: Math.max(1, Math.ceil((body ? height : rect.height) + title)),
    minLength: Math.ceil(minimum + gap + padding + gripLength + groupInsets.start + groupInsets.end) };
}

export function observePaletteContentSize(shell: HTMLElement, orientation: ToolsetContentSize["orientation"]): () => void {
  let disposed = false;
  let scheduled: number | undefined;
  let last = "";
  const report = () => {
    scheduled = undefined;
    if (disposed) return;
    const size = measurePaletteContent(shell, orientation);
    const key = JSON.stringify(size);
    if (key === last) return;
    last = key;
    void reportToolsetContentSize(size).catch(() => undefined);
  };
  const schedule = () => { if (scheduled === undefined) scheduled = window.requestAnimationFrame(report); };
  const natural = shell.querySelector<HTMLElement>(".toolbar-natural-size > .tool-palette");
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  resize?.observe(natural ?? shell);
  // Visibility, widget variants and folding can change without changing the probe's outer bounds.
  const mutation = new MutationObserver(schedule);
  mutation.observe(shell, { subtree: true, childList: true, attributes: true, characterData: true });
  const dpi = schedule;
  const reportDpi = () => { last = ""; schedule(); };
  window.addEventListener("resize", dpi);
  window.addEventListener("chemdraft:toolbar-viewport", dpi);
  window.addEventListener("chemdraft:toolbar-dpi", reportDpi);
  report();
  return () => {
    disposed = true; resize?.disconnect(); mutation.disconnect();
    if (scheduled !== undefined) window.cancelAnimationFrame(scheduled);
    window.removeEventListener("resize", dpi);
    window.removeEventListener("chemdraft:toolbar-viewport", dpi);
    window.removeEventListener("chemdraft:toolbar-dpi", reportDpi);
  };
}
