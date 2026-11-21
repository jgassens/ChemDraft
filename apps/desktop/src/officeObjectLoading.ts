// The Office editor's loading state. It must stay light: App.tsx imports it, and
// OfficeObjectLoadingState.tsx, statically so the state renders while the MainWindow chunk (the
// whole editor and its engines) is still loading. index.html paints the same state before any
// script module runs; keep the two in step.

/** `--cd-bg-app`; the native window (`office_ole/bridge.rs`) paints the same color first. */
export const OFFICE_OBJECT_LOADING_BACKGROUND = "#d8dee3";
export const OFFICE_OBJECT_LOADING_HTML_CLASS = "office-object-loading-html";
/**
 * The Office editor window is built hidden. index.html sends this event through
 * `office_toolset_emit` once its loading screen has painted, and the window is shown then
 * (`EDITOR_PAINTED` in `office_ole/bridge.rs`; Rust shows it after 1.5 s regardless).
 */
export const OFFICE_OBJECT_PAINTED_COMMAND = "office_toolset_emit";
export const OFFICE_OBJECT_PAINTED_EVENT = "chemdraft://office-object-painted";
/** Matches `MAX_CONTAINER_APP_CHARS` in `office_ole/bridge.rs`. */
const MAX_CONTAINER_APP_CHARS = 80;

export interface OfficeObjectLoadingRoute {
  objectId: string;
  containerApp: string;
}

export function officeObjectLoadingRoute(search: string): OfficeObjectLoadingRoute | undefined {
  const params = new URLSearchParams(search);
  const objectId = params.get("officeObject");
  if (!objectId) return undefined;
  return { objectId, containerApp: officeObjectContainerLabel(params.get("officeApp")) };
}

export function officeObjectContainerLabel(name: string | null | undefined): string {
  const label = [...(name ?? "").replace(/\s+/g, " ").trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, "")]
    .slice(0, MAX_CONTAINER_APP_CHARS).join("").trim();
  return label || "Office";
}

export function officeObjectLoadingMessage(containerApp: string): string {
  return `Opening structure from ${containerApp}…`;
}
