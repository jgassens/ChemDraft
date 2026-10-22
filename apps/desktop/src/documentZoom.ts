import type { ViewportState } from "@chemdraft/viewport-engine";
import type { CommandSpec } from "./commands";

export const DOCUMENT_ZOOM_PRESETS = [25, 50, 75, 100, 200, 400] as const;
export const DOCUMENT_ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400, 600, 850] as const;

/** Buttons/shortcuts move to the next stop; smooth wheel values snap in the chosen direction. */
export function documentZoomStepScale(viewport: DocumentZoomState, direction: 1 | -1): number {
  const stops = [viewport.minZoom, ...DOCUMENT_ZOOM_STEPS.map(percent => percent / 100)
    .filter(scale => scale > viewport.minZoom && scale < viewport.maxZoom), viewport.maxZoom];
  return direction === 1
    ? stops.find(scale => scale > viewport.scale + 1e-9) ?? viewport.maxZoom
    : stops.reverse().find(scale => scale < viewport.scale - 1e-9) ?? viewport.minZoom;
}
export function documentZoomCommandId(percent: typeof DOCUMENT_ZOOM_PRESETS[number]): string {
  return `view.zoomPercent.${percent}`;
}
export function documentZoomScaleForCommand(commandId: string): number | undefined {
  const percent = DOCUMENT_ZOOM_PRESETS.find(value => documentZoomCommandId(value) === commandId);
  return percent === undefined ? undefined : percent / 100;
}
export const documentZoomActions: CommandSpec[] = DOCUMENT_ZOOM_PRESETS.map(percent => ({
  id: documentZoomCommandId(percent), title: `Zoom to ${percent}%`, icon: "zoomIn", source: "core", category: "view"
}));

/** Old sessions stored a 50% floor. All document tabs must support the new presets. */
export function normalizeDocumentZoomRange(viewport: ViewportState): ViewportState {
  return { ...viewport, minZoom: Math.min(viewport.minZoom, 0.25), maxZoom: Math.max(viewport.maxZoom, 4) };
}
export type DocumentZoomState = Pick<ViewportState, "scale" | "minZoom" | "maxZoom">;

/** Center of the visible drawing area, excluding borders, scrollbars and visible rulers. */
export function documentZoomClientCenter(
  rect: { left: number; top: number },
  canvas: { clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number },
  rulerInset: number
) {
  const insetX = Math.min(rulerInset, canvas.clientWidth);
  const insetY = Math.min(rulerInset, canvas.clientHeight);
  return {
    x: rect.left + canvas.clientLeft + insetX + (canvas.clientWidth - insetX) / 2,
    y: rect.top + canvas.clientTop + insetY + (canvas.clientHeight - insetY) / 2
  };
}

export function isDocumentZoomState(value: unknown): value is DocumentZoomState {
  if (!value || typeof value !== "object") return false;
  const state = value as DocumentZoomState;
  return [state.scale, state.minZoom, state.maxZoom].every(value => typeof value === "number" && Number.isFinite(value)) &&
    state.minZoom > 0 && state.maxZoom >= state.minZoom && state.scale >= state.minZoom && state.scale <= state.maxZoom;
}
