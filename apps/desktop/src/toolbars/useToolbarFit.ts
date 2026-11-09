import { useLayoutEffect, useState, type RefObject } from "react";
import type { ToolbarPaletteGroupModel } from "../toolsets";
import type { ToolbarGroupFootprint } from "./toolbarFit";
import { toolbarAxisInsets } from "./toolbarMeasurements";

export interface ToolbarFitMeasurement {
  available: number;
  gap: number;
  overflow: number;
  groups: ToolbarGroupFootprint[];
}

/** The viewport and intrinsic probe are separate observations: clipping never changes the probe. */
export function useToolbarFit(root: RefObject<HTMLElement | null>, enabled: boolean,
  orientation: "horizontal" | "vertical", groups: readonly ToolbarPaletteGroupModel[]) {
  const [measurement, setMeasurement] = useState<ToolbarFitMeasurement>();
  useLayoutEffect(() => {
    const element = root.current;
    const natural = element?.querySelector<HTMLElement>(":scope > .toolbar-natural-size > .tool-palette");
    if (!enabled || !element || !natural) { setMeasurement(undefined); return; }
    const horizontal = orientation === "horizontal";
    const measure = () => {
      const style = getComputedStyle(natural);
      const px = (value: string) => Number.parseFloat(value) || 0;
      const padding = horizontal ? px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
        : px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
      const axisGap = horizontal ? style.columnGap : style.rowGap;
      const gap = px(!axisGap || axisGap === "normal" ? style.gap : axisGap);
      const grip = natural.querySelector<HTMLElement>(":scope > .palette-content-drag-grip")?.getBoundingClientRect();
      const gripLength = grip ? (horizontal ? grip.width : grip.height) + gap : 0;
      const bounds = element.getBoundingClientRect();
      const available = (horizontal ? bounds.width : bounds.height) - padding - gripLength;
      if (available <= 0) return; // A hidden/prewarmed webview has no viewport yet.
      // Fold and overflow buttons share the icon-button dimensions; measure that CSS footprint.
      const overflowRect = element.querySelector<HTMLElement>(":scope > .toolbar-overflow-measure")?.getBoundingClientRect();
      const overflow = (horizontal ? overflowRect?.width : overflowRect?.height) || 24;
      const footprints = Array.from(natural.querySelectorAll<HTMLElement>(":scope > .tool-group")).map((group, index) => {
        const rect = group.getBoundingClientRect();
        const groupStyle = getComputedStyle(group);
        const { start, end } = toolbarAxisInsets(groupStyle, orientation);
        let extent = 0;
        const prefixes = Array.from(group.children).map(child => {
          const item = child.getBoundingClientRect();
          extent = Math.max(extent, horizontal ? item.right - rect.left : item.bottom - rect.top);
          return extent + end;
        });
        return { id: group.dataset.toolbarGroupId ?? groups[index]?.id, length: horizontal ? rect.width : rect.height, prefixes, foldedLength: start + overflow + end };
      });
      const next = { available, gap, overflow, groups: footprints };
      setMeasurement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const viewportObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    viewportObserver?.observe(element);
    const contentObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    contentObserver?.observe(natural);
    natural.querySelectorAll(":scope > .tool-group").forEach(group => contentObserver?.observe(group));
    window.addEventListener("resize", measure);
    // Rust emits after user resize, restore and monitor/DPI changes, including unchanged CSS bounds.
    window.addEventListener("chemdraft:toolbar-viewport", measure);
    window.addEventListener("chemdraft:toolbar-dpi", measure);
    return () => {
      viewportObserver?.disconnect(); contentObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("chemdraft:toolbar-viewport", measure);
      window.removeEventListener("chemdraft:toolbar-dpi", measure);
    };
  }, [enabled, groups, orientation, root]);
  return measurement;
}
