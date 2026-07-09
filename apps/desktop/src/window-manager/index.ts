import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import type { ArtInspectorModel, ArtInspectorPaintTarget } from "../artInspectorModel";
import type { MoleculeInspectorModel } from "../moleculeInspectorModel";
import { isSpin3dSettings, type Spin3dSettings } from "../spin3dSettings";

export const PALETTE_COMMAND_EVENT = "chemdraft://palette-command";
export const PALETTE_COMMAND_PREVIEW_EVENT = "chemdraft://palette-command-preview";
export const PALETTE_COMMAND_COMMIT_EVENT = "chemdraft://palette-command-commit";
export const PALETTE_COMMAND_CANCEL_EVENT = "chemdraft://palette-command-cancel";
export const DOM_COMMAND_EVENT = "chemdraft:native-command";
export const TOOLSET_WINDOW_STATE_EVENT = "chemdraft://toolset-window-state";
export const TOOLSET_ACTIVE_TOOL_EVENT = "chemdraft://toolset-active-tool";
export const TOOLSET_ACTIVE_TOOL_REQUEST_EVENT = "chemdraft://toolset-active-tool-request";
export const TOOLSET_TEXT_STYLE_EVENT = "chemdraft://toolset-text-style";
export const TOOLSET_TEXT_STYLE_REQUEST_EVENT = "chemdraft://toolset-text-style-request";
export const PALETTE_POINTER_EVENT = "chemdraft://palette-pointer";
export const PALETTE_POINTER_LEAVE_EVENT = "chemdraft://palette-pointer-leave";
export const TOOLSET_LAYOUT_STATE_EVENT = "chemdraft://toolset-layout-state";
export const TOOLSET_LAYOUT_STATE_REQUEST_EVENT = "chemdraft://toolset-layout-state-request";
export const TOOLSET_LAYOUT_EDIT_EVENT = "chemdraft://toolset-layout-edit";
export const TOOLSET_CUSTOMIZE_MODE_EVENT = "chemdraft://toolset-customize-mode";
export const TOOLSET_CUSTOMIZE_MODE_REQUEST_EVENT = "chemdraft://toolset-customize-mode-request";
export const PALETTE_TOOLTIP_SHOW_EVENT = "chemdraft://palette-tooltip-show";
export const PALETTE_TOOLTIP_HIDE_EVENT = "chemdraft://palette-tooltip-hide";
export const TOOLSET_TOOLTIP_WINDOW_KIND = "toolsetTooltip";
export const DEFAULT_TOOLSET_ID = "core.main";

export interface ToolsetWindowPosition {
  x: number;
  y: number;
}

export interface ToolsetWindowSize {
  width: number;
  height: number;
}

export interface ToolsetWindowState {
  toolsetId: string;
  open: boolean;
  focused: boolean;
  position?: ToolsetWindowPosition;
}

export interface ToolsetCommandPayload {
  commandId: string;
}

export type PaletteCommandPayload = ToolsetCommandPayload;
export type ToolsetActiveToolPayload = ToolsetCommandPayload;

export interface ToolsetTextStylePayload {
  currentTextStyle: NativeTextStyle;
  currentTextScript: TextSpan["script"];
  currentArtStyle?: ToolsetArtStylePayload;
  currentArtStyleTarget?: ToolsetArtPaintTarget;
  currentMoleculeInspector?: ToolsetMoleculeInspectorPayload;
}

export type ToolsetArtPaintTarget = ArtInspectorPaintTarget;
export type ToolsetArtStylePayload = ArtInspectorModel;
export type ToolsetMoleculeInspectorPayload = MoleculeInspectorModel;

type Unlisten = () => void;

export function isDesktopRuntime(): boolean {
  const candidate = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

export function createPaletteCommandPayload(commandId: string): PaletteCommandPayload {
  return createToolsetCommandPayload(commandId);
}

export function createToolsetCommandPayload(commandId: string): ToolsetCommandPayload {
  return { commandId };
}

export function createToolsetActiveToolPayload(commandId: string): ToolsetActiveToolPayload {
  return createToolsetCommandPayload(commandId);
}

export function createToolsetTextStylePayload(
  currentTextStyle: NativeTextStyle,
  currentTextScript: TextSpan["script"] = "normal",
  currentArtStyle?: ToolsetArtStylePayload,
  currentArtStyleTarget: ToolsetArtPaintTarget = "fill",
  currentMoleculeInspector?: ToolsetMoleculeInspectorPayload
): ToolsetTextStylePayload {
  return {
    currentTextStyle,
    currentTextScript,
    ...(currentArtStyle ? { currentArtStyle, currentArtStyleTarget } : {}),
    ...(currentMoleculeInspector ? { currentMoleculeInspector } : {})
  };
}

export function createToolsetWindowStatePayload(
  toolsetId: string,
  open: boolean,
  focused = false,
  position?: ToolsetWindowPosition
): ToolsetWindowState {
  return { toolsetId, open, focused, position };
}

/** Title/size for a palette window, supplied from the TS toolbar registry so Rust doesn't read the
 *  manifest. Size is a starting point; PaletteWindow resizes to fit content. */
export interface ToolsetWindowGeometry {
  title: string;
  width: number;
  height: number;
  /** Default top-left for a first-ever placement (JS staggers by registry order). */
  x: number;
  y: number;
}

export async function openToolsetWindow(
  toolsetId: string,
  geometry?: ToolsetWindowGeometry
): Promise<ToolsetWindowState> {
  if (!isDesktopRuntime()) {
    return createToolsetWindowStatePayload(toolsetId, false);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolsetWindowState>("open_toolset_window", { toolsetId, window: geometry });
}

export async function closeToolsetWindow(toolsetId: string): Promise<ToolsetWindowState> {
  return invokeToolsetWindow("close_toolset_window", toolsetId);
}

/**
 * Opens (or repositions) a palette's popover in its own little floating window so it can
 * overflow the palette and float over the document — the native way (a webview can't paint
 * outside its own window). `x`/`y` are logical screen coordinates for the popover's top-left,
 * computed by the palette from its own window position + the trigger's client rect.
 */
export async function openToolsetPopoverWindow(
  toolsetId: string,
  kind: string,
  x: number,
  y: number
): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_toolset_popover", { toolsetId, kind, x, y });
}

export async function closeToolsetPopoverWindow(toolsetId: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_toolset_popover", { toolsetId }).catch(() => undefined);
}

/** Route param identifying a palette popover webview (see App.tsx / PalettePopoverWindow). */
export const TOOLSET_POPOVER_WINDOW_KIND = "toolsetPopover";

/** Broadcast that any open palette popover (e.g. the colour picker) should dismiss itself. */
export const TOOLSET_POPOVER_DISMISS_EVENT = "chemdraft://dismiss-toolset-popovers";

/**
 * Ask any open palette popover window to close. The document window and the palettes fire this on
 * a pointer-down anywhere that isn't the popover itself (a popover lives in its own window, so its
 * own clicks never reach these emitters) — giving the popover "stays while you click inside it,
 * closes when you click anything else" behaviour without depending on macOS key-window semantics.
 */
export async function dismissToolsetPopovers(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_POPOVER_DISMISS_EVENT).catch(() => undefined);
}

export async function listenForToolsetPopoverDismiss(handler: () => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen(TOOLSET_POPOVER_DISMISS_EVENT, () => handler());
}

/** One command in a flyout dropdown, snapshotted at open time so the popover window can render it. */
export interface ToolsetFlyoutCommandSnapshot {
  id: string;
  title: string;
  assetName?: string;
  icon?: string;
  enabled: boolean;
  active: boolean;
  disabledReason?: string;
  shortcutLabel?: string;
}

export interface ToolsetFlyoutSnapshot {
  id?: string;
  flyoutId: string;
  type?: "command-grid";
  title: string;
  columns?: number;
  commands: ToolsetFlyoutCommandSnapshot[];
  /**
   * "menu" (default): icon + label command list (shape/align/layer/…). "distribute": a plain-text
   * radio choice (Centers / Equal gaps) with no icon gutter — matches the icon-less layout the
   * inline toolbar-distribute-menu always used; without this the grid in the icon+label layout
   * places a lone icon-less label into the narrow icon column and it gets ellipsized.
   */
  variant?: "menu" | "distribute";
}

/**
 * What a palette popover window should show. The window is content-agnostic (one per palette),
 * so opening the colour picker vs a flyout dropdown just swaps the content in the same window —
 * no per-kind windows to keep in sync, and no way for a stale kind to coexist.
 */
export type ToolsetPopoverContent =
  | { kind: "artColor" }
  | { kind: "flyout"; flyout: ToolsetFlyoutSnapshot };

export type ToolsetPopoverContentPayload = { toolsetId: string } & ToolsetPopoverContent;

const TOOLSET_POPOVER_CONTENT_EVENT = "chemdraft://toolset-popover-content";
const TOOLSET_POPOVER_CONTENT_REQUEST_EVENT = "chemdraft://toolset-popover-content-request";

/** Palette → popover: set what the popover window renders (its owner sends this on every open). */
export async function setToolsetPopoverContent(toolsetId: string, content: ToolsetPopoverContent): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetPopoverContentPayload>(TOOLSET_POPOVER_CONTENT_EVENT, { toolsetId, ...content }).catch(
    () => undefined
  );
}

export async function listenForToolsetPopoverContent(
  handler: (payload: ToolsetPopoverContentPayload) => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<ToolsetPopoverContentPayload>(TOOLSET_POPOVER_CONTENT_EVENT, (event) => handler(event.payload));
}

/** Popover → palette: "I just mounted, resend my content" — closes the create-vs-emit startup race. */
export async function requestToolsetPopoverContent(toolsetId: string): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_POPOVER_CONTENT_REQUEST_EVENT, { toolsetId }).catch(() => undefined);
}

export async function listenForToolsetPopoverContentRequests(
  handler: (toolsetId: string) => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ toolsetId: string }>(TOOLSET_POPOVER_CONTENT_REQUEST_EVENT, (event) =>
    handler(event.payload.toolsetId)
  );
}

export async function toggleSpin3dDebuggerWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("toggle_spin3d_debugger_window");
}

/** Route param identifying the Preferences webview (see App.tsx). */
export const PREFERENCES_WINDOW_KIND = "preferences";
/** Cross-window event carrying updated Spin 3D settings from Preferences → main. */
export const SPIN3D_SETTINGS_EVENT = "chemdraft://spin3d-settings";

export async function togglePreferencesWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("toggle_preferences_window");
}

/** Broadcast a settings change so the main document window updates live. localStorage is
 *  the source of truth across reloads; this event is the explicit live-sync channel (the
 *  cross-window `storage` event is unreliable in webviews and is not relied upon). */
export async function broadcastSpin3dSettings(settings: Spin3dSettings): Promise<void> {
  dispatchDomToolsetEvent(SPIN3D_SETTINGS_EVENT, settings);
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<Spin3dSettings>(SPIN3D_SETTINGS_EVENT, settings);
}

export async function listenForSpin3dSettings(handler: (settings: Spin3dSettings) => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(SPIN3D_SETTINGS_EVENT, (event) => {
    if (isSpin3dSettingsPayload(event.detail)) handler(event.detail);
  });
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<Spin3dSettings>(SPIN3D_SETTINGS_EVENT, (event) => {
    if (isSpin3dSettingsPayload(event.payload)) handler(event.payload);
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

function isSpin3dSettingsPayload(payload: unknown): payload is Spin3dSettings {
  return isSpin3dSettings(payload);
}

export async function listToolsetWindowStates(): Promise<ToolsetWindowState[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolsetWindowState[]>("list_toolset_window_states");
}

export async function loadToolsetLayoutState(): Promise<unknown | undefined> {
  if (!isDesktopRuntime()) {
    return undefined;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<unknown | null>("load_toolset_customization_state").then((state) => state ?? undefined);
}

/**
 * Persist the full toolbar layout/customization state (visibility, order, user toolsets). JS owns
 * this now; Rust just writes the opaque JSON to disk. No-op off the desktop runtime.
 */
export async function saveToolsetLayoutState(state: unknown): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_toolset_customization_state", { state }).catch(() => undefined);
}

/** One row of the native Toolbars menu, pushed from the TS toolbar registry. */
export interface ToolbarMenuEntry {
  toolsetId: string;
  title: string;
  visible: boolean;
}

/**
 * Push the Toolbars menu model to Rust so the native menu's toolset rows come from the TS registry
 * rather than Rust's manifest copy. Use for structure (which toolsets exist / their titles); the
 * per-toggle checkmark still flips in place via setMenuChecked.
 */
export async function setToolbarsMenu(
  entries: readonly ToolbarMenuEntry[],
  // Rust rebuilds the whole menu bar here, which recreates the Show Rulers / Show Crosshairs check
  // items; pass their current state so the rebuild preserves the checkmarks instead of forcing them on.
  rulersVisible: boolean,
  crosshairsVisible: boolean
): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_toolbars_menu", { entries, rulersVisible, crosshairsVisible }).catch(() => undefined);
}

/**
 * Pushes a native menu item's check state from JS. The main window owns toolset
 * visibility now, so it mirrors each toggle's checkmark here after every change.
 * No-op in the browser build (there is no native menu).
 */
export async function setMenuChecked(commandId: string, checked: boolean): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_menu_checked", { commandId, checked }).catch(() => undefined);
}

export async function sendPaletteCommand(commandId: string): Promise<void> {
  return routeToolsetCommand(commandId);
}

export async function sendPaletteCommandPreview(commandId: string): Promise<void> {
  return emitToolsetCommandEvent(PALETTE_COMMAND_PREVIEW_EVENT, commandId);
}

export async function sendPaletteCommandCommit(commandId: string): Promise<void> {
  return emitToolsetCommandEvent(PALETTE_COMMAND_COMMIT_EVENT, commandId);
}

export async function sendPaletteCommandCancel(commandId: string): Promise<void> {
  return emitToolsetCommandEvent(PALETTE_COMMAND_CANCEL_EVENT, commandId);
}

export async function routeToolsetCommand(commandId: string): Promise<void> {
  // Single delivery: the invoke routes through Rust `route_toolset_command`, which dispatches the
  // native-command DOM event into the main window (the one listener in `listenForToolsetCommands`).
  // No client-side `emit` — that used to also fan out over the tauri event bus, so every command
  // arrived several times and needed `dedupeAdjacentCommands` to collapse it.
  const payload = createToolsetCommandPayload(commandId);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("route_toolset_command", payload as unknown as Record<string, unknown>);
}

async function emitToolsetCommandEvent(eventName: string, commandId: string): Promise<void> {
  const payload = createToolsetCommandPayload(commandId);
  dispatchDomToolsetEvent(eventName, payload);
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetCommandPayload>(eventName, payload);
}

export async function broadcastToolsetActiveTool(commandId: string): Promise<void> {
  const payload = createToolsetActiveToolPayload(commandId);
  dispatchDomToolsetEvent(TOOLSET_ACTIVE_TOOL_EVENT, payload);
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetActiveToolPayload>(TOOLSET_ACTIVE_TOOL_EVENT, payload);
}

export async function requestToolsetActiveTool(): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_ACTIVE_TOOL_REQUEST_EVENT, {});
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_ACTIVE_TOOL_REQUEST_EVENT);
}

export async function broadcastToolsetTextStyle(payload: ToolsetTextStylePayload): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_TEXT_STYLE_EVENT, payload);
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetTextStylePayload>(TOOLSET_TEXT_STYLE_EVENT, payload);
}

export async function requestToolsetTextStyle(): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_TEXT_STYLE_REQUEST_EVENT, {});
  if (!isDesktopRuntime()) {
    return;
  }

  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_TEXT_STYLE_REQUEST_EVENT);
}

export async function startPaletteWindowDrag(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function currentWindowLogicalPosition(): Promise<ToolsetWindowPosition | undefined> {
  if (!isDesktopRuntime()) {
    return undefined;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  const [position, scaleFactor] = await Promise.all([window.outerPosition(), window.scaleFactor()]);
  return {
    x: position.x / scaleFactor,
    y: position.y / scaleFactor
  };
}

export async function setCurrentWindowLogicalPosition(position: ToolsetWindowPosition): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow, LogicalPosition } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setPosition(new LogicalPosition(position.x, position.y));
}

export async function setCurrentWindowLogicalSize(size: ToolsetWindowSize): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
}

export async function focusCurrentWindowAndWebview(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const [{ invoke }, { getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webview")
  ]);

  await invoke("focus_main_document_window").catch(() => undefined);
  await Promise.allSettled([
    getCurrentWindow().setFocus(),
    getCurrentWebview().setFocus()
  ]);
}

export async function listenForPaletteCommands(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommands(handler);
}

export async function listenForToolsetCommands(handler: (commandId: string) => void): Promise<Unlisten> {
  // Native palette clicks arrive as the `native-command` DOM event that Rust `route_toolset_command`
  // dispatches into the main window (see `routeToolsetCommand`). That is now the single delivery path,
  // so a plain DOM listener receives each command exactly once — no tauri-bus fan-out, no dedupe.
  return listenForDomToolsetCommands(handler);
}

export async function listenForPaletteCommandPreviews(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommandPayload(PALETTE_COMMAND_PREVIEW_EVENT, handler);
}

export async function listenForPaletteCommandCommits(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommandPayload(PALETTE_COMMAND_COMMIT_EVENT, handler);
}

export async function listenForPaletteCommandCancels(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommandPayload(PALETTE_COMMAND_CANCEL_EVENT, handler);
}

export async function listenForToolsetActiveTool(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommandPayload(TOOLSET_ACTIVE_TOOL_EVENT, handler);
}

/** Window-local pointer position pushed by Rust's palette pointer feed (desktop only). The palette
 *  panels never become the key window, so the OS never delivers hover to their webviews; Rust polls
 *  the cursor and feeds it here, and PaletteWindow synthesizes pointerover/out (tooltips, hover).
 *  Every webview's `listen()` sees every event regardless of the emit target, so payloads carry the
 *  toolset id and each palette filters to its own. */
export async function listenForPalettePointer(
  toolsetId: string,
  handler: (payload: { x: number; y: number }) => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ toolsetId?: string; x?: number; y?: number }>(PALETTE_POINTER_EVENT, (event) => {
    if (event.payload?.toolsetId !== toolsetId) {
      return;
    }
    if (typeof event.payload.x === "number" && typeof event.payload.y === "number") {
      handler({ x: event.payload.x, y: event.payload.y });
    }
  });
}

/** The cursor left this palette window (or something covered it) — clear synthesized hover. */
export async function listenForPalettePointerLeave(
  toolsetId: string,
  handler: () => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ toolsetId?: string }>(PALETTE_POINTER_LEAVE_EVENT, (event) => {
    if (event.payload?.toolsetId === toolsetId) {
      handler();
    }
  });
}

/** Push the current toolbar layout state to every native palette webview. Each palette builds its
 *  toolbar from the layout state ONCE at window creation, so without this broadcast the Customize
 *  dialog's item hides/reorders/renames never reach an already-open palette. Desktop only — the
 *  browser renders palettes in-window straight from MainWindow state. */
export async function broadcastToolsetLayoutState(layoutState: unknown): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_LAYOUT_STATE_EVENT, layoutState);
}

export async function listenForToolsetLayoutState(
  handler: (layoutState: unknown) => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen(TOOLSET_LAYOUT_STATE_EVENT, (event) => handler(event.payload));
}

/** A freshly created palette window asks the main window for the current layout state — the disk
 *  copy it loads on mount can be stale while the save chain is still flushing (create-vs-save race,
 *  same shape as the popover content request). */
export async function requestToolsetLayoutState(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_LAYOUT_STATE_REQUEST_EVENT);
}

export async function listenForToolsetLayoutStateRequests(handler: () => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen(TOOLSET_LAYOUT_STATE_REQUEST_EVENT, () => handler());
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// In-place customize mode (core.main): the palette sends single edit ops back to the main window,
// which applies them against its authoritative layout state and re-broadcasts. Ops (not full state)
// so a stale palette snapshot can't clobber. Both channels use DUAL dispatch (DOM CustomEvent +
// Tauri emit) so jsdom tests and the browser build hit the identical path — in the browser the main
// window hears its own web palette's ops through the DOM event.
// ————————————————————————————————————————————————————————————————————————————————————————————————

/** One in-place customize edit. Applied in MainWindow via `applyToolsetLayoutEdit`; `exitCustomize`
 *  is handled by the caller (mode state), not the layout applier. */
export type ToolsetLayoutEdit =
  | { kind: "reorderItems"; groupId: string; orderedItemIds: string[] }
  | { kind: "addCommand"; groupId: string; index: number; commandId: string }
  | { kind: "addSpacer"; groupId: string; index: number }
  | { kind: "removeItem"; itemId: string }
  | { kind: "resetToolset" }
  | { kind: "exitCustomize" };

export interface ToolsetLayoutEditPayload {
  toolsetId: string;
  edit: ToolsetLayoutEdit;
}

export interface ToolsetCustomizeModePayload {
  toolsetId: string;
  active: boolean;
}

function isToolsetLayoutEditPayload(value: unknown): value is ToolsetLayoutEditPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ToolsetLayoutEditPayload).toolsetId === "string" &&
    typeof (value as ToolsetLayoutEditPayload).edit === "object" &&
    (value as ToolsetLayoutEditPayload).edit !== null &&
    typeof (value as { edit: { kind?: unknown } }).edit.kind === "string"
  );
}

function isToolsetCustomizeModePayload(value: unknown): value is ToolsetCustomizeModePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ToolsetCustomizeModePayload).toolsetId === "string" &&
    typeof (value as ToolsetCustomizeModePayload).active === "boolean"
  );
}

/** Palette → main: apply one customize edit. */
export async function sendToolsetLayoutEdit(payload: ToolsetLayoutEditPayload): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_LAYOUT_EDIT_EVENT, payload);
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetLayoutEditPayload>(TOOLSET_LAYOUT_EDIT_EVENT, payload);
}

export async function listenForToolsetLayoutEdits(
  handler: (payload: ToolsetLayoutEditPayload) => void
): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_LAYOUT_EDIT_EVENT, (event) => {
    if (isToolsetLayoutEditPayload(event.detail)) {
      handler(event.detail);
    }
  });
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<ToolsetLayoutEditPayload>(TOOLSET_LAYOUT_EDIT_EVENT, (event) => {
    if (isToolsetLayoutEditPayload(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

/** Main → palettes: customize mode turned on/off for a toolset. */
export async function broadcastToolsetCustomizeMode(payload: ToolsetCustomizeModePayload): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_CUSTOMIZE_MODE_EVENT, payload);
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit<ToolsetCustomizeModePayload>(TOOLSET_CUSTOMIZE_MODE_EVENT, payload);
}

export async function listenForToolsetCustomizeMode(
  handler: (payload: ToolsetCustomizeModePayload) => void
): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_CUSTOMIZE_MODE_EVENT, (event) => {
    if (isToolsetCustomizeModePayload(event.detail)) {
      handler(event.detail);
    }
  });
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<ToolsetCustomizeModePayload>(TOOLSET_CUSTOMIZE_MODE_EVENT, (event) => {
    if (isToolsetCustomizeModePayload(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

/** A palette that mounts mid-mode asks the main window for the current customize-mode state. */
export async function requestToolsetCustomizeMode(): Promise<void> {
  dispatchDomToolsetEvent(TOOLSET_CUSTOMIZE_MODE_REQUEST_EVENT, {});
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit(TOOLSET_CUSTOMIZE_MODE_REQUEST_EVENT);
}

export async function listenForToolsetCustomizeModeRequests(handler: () => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_CUSTOMIZE_MODE_REQUEST_EVENT, () => handler());
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen(TOOLSET_CUSTOMIZE_MODE_REQUEST_EVENT, () => handler());
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

/** Content + anchor for the ONE shared floating tooltip window. Coordinates are global logical px
 *  (top-left origin): the tooltip centers itself on `anchorCenterX` below the button (`belowY`),
 *  flipping above (`aboveY` = the would-be bottom edge) when there's no room underneath. A palette
 *  webview can't paint outside its content-fit window, so the tooltip gets its own window — the
 *  same reason popovers/flyouts do. */
export interface PaletteTooltipPayload {
  title: string;
  description?: string;
  shortcut?: string;
  anchorCenterX: number;
  belowY: number;
  aboveY: number;
}

export async function showPaletteFloatingTooltip(payload: PaletteTooltipPayload): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit(PALETTE_TOOLTIP_SHOW_EVENT, payload);
}

export async function hidePaletteFloatingTooltip(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }
  const { emit } = await import("@tauri-apps/api/event");
  await emit(PALETTE_TOOLTIP_HIDE_EVENT);
}

export async function listenForPaletteTooltipShow(
  handler: (payload: PaletteTooltipPayload) => void
): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PaletteTooltipPayload>(PALETTE_TOOLTIP_SHOW_EVENT, (event) => {
    if (typeof event.payload?.title === "string" && typeof event.payload.anchorCenterX === "number") {
      handler(event.payload);
    }
  });
}

export async function listenForPaletteTooltipHide(handler: () => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen(PALETTE_TOOLTIP_HIDE_EVENT, () => handler());
}

export async function listenForToolsetActiveToolRequests(handler: () => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_ACTIVE_TOOL_REQUEST_EVENT, () => handler());
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen(TOOLSET_ACTIVE_TOOL_REQUEST_EVENT, () => handler());
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

export async function listenForToolsetTextStyle(handler: (payload: ToolsetTextStylePayload) => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_TEXT_STYLE_EVENT, (event) => {
    const payload = event.detail;
    if (isToolsetTextStylePayload(payload)) {
      handler(payload);
    }
  });
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<ToolsetTextStylePayload>(TOOLSET_TEXT_STYLE_EVENT, (event) => {
    if (isToolsetTextStylePayload(event.payload)) {
      handler(event.payload);
    }
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

export async function listenForToolsetTextStyleRequests(handler: () => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetEvent(TOOLSET_TEXT_STYLE_REQUEST_EVENT, () => handler());
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen(TOOLSET_TEXT_STYLE_REQUEST_EVENT, () => handler());
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

function listenForDomToolsetCommands(handler: (commandId: string) => void): Unlisten {
  return listenForDomToolsetCommandPayload(DOM_COMMAND_EVENT, handler);
}

function dispatchDomToolsetEvent(eventName: string, payload: unknown): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
}

function listenForDomToolsetEvent(eventName: string, handler: (event: CustomEvent<unknown>) => void): Unlisten {
  const listener = (event: Event) => {
    handler(event as CustomEvent<unknown>);
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

function listenForDomToolsetCommandPayload(eventName: string, handler: (commandId: string) => void): Unlisten {
  return listenForDomToolsetEvent(eventName, (event) => {
    const payload = event.detail as Partial<ToolsetCommandPayload> | undefined;
    if (typeof payload?.commandId === "string") {
      handler(payload.commandId);
    }
  });
}

async function listenForToolsetCommandPayload(eventName: string, handler: (commandId: string) => void): Promise<Unlisten> {
  const unlistenDom = listenForDomToolsetCommandPayload(eventName, handler);
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlistenTauri = await listen<ToolsetCommandPayload>(eventName, (event) => {
    if (typeof event.payload?.commandId === "string") {
      handler(event.payload.commandId);
    }
  });
  return () => {
    unlistenDom();
    unlistenTauri();
  };
}

function isToolsetTextStylePayload(payload: unknown): payload is ToolsetTextStylePayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Partial<ToolsetTextStylePayload>;
  return (
    typeof candidate.currentTextStyle === "object" &&
    candidate.currentTextStyle !== null &&
    (
      candidate.currentTextScript === "normal" ||
      candidate.currentTextScript === "subscript" ||
      candidate.currentTextScript === "superscript"
    )
  );
}

export async function listenForToolsetWindowStates(handler: (state: ToolsetWindowState) => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<ToolsetWindowState>(TOOLSET_WINDOW_STATE_EVENT, (event) => {
    if (typeof event.payload?.toolsetId === "string" && typeof event.payload?.open === "boolean") {
      handler(event.payload);
    }
  });
}

async function invokeToolsetWindow(commandName: string, toolsetId: string): Promise<ToolsetWindowState> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolsetWindowState>(commandName, { toolsetId });
}
