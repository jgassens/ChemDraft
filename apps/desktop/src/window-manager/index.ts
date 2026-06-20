import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import type { ArtInspectorModel, ArtInspectorPaintTarget } from "../artInspectorModel";

export const PALETTE_COMMAND_EVENT = "chemdraft://palette-command";
export const DOM_COMMAND_EVENT = "chemdraft:native-command";
export const TOOLSET_WINDOW_STATE_EVENT = "chemdraft://toolset-window-state";
export const TOOLSET_ACTIVE_TOOL_EVENT = "chemdraft://toolset-active-tool";
export const TOOLSET_ACTIVE_TOOL_REQUEST_EVENT = "chemdraft://toolset-active-tool-request";
export const TOOLSET_TEXT_STYLE_EVENT = "chemdraft://toolset-text-style";
export const TOOLSET_TEXT_STYLE_REQUEST_EVENT = "chemdraft://toolset-text-style-request";
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

export type PaletteWindowState = ToolsetWindowState;

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
}

export type ToolsetArtPaintTarget = ArtInspectorPaintTarget;
export type ToolsetArtStylePayload = ArtInspectorModel;

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
  currentArtStyleTarget: ToolsetArtPaintTarget = "fill"
): ToolsetTextStylePayload {
  return currentArtStyle
    ? { currentTextStyle, currentTextScript, currentArtStyle, currentArtStyleTarget }
    : { currentTextStyle, currentTextScript };
}

export function createToolsetWindowStatePayload(
  toolsetId: string,
  open: boolean,
  focused = false,
  position?: ToolsetWindowPosition
): ToolsetWindowState {
  return { toolsetId, open, focused, position };
}

export async function openToolsetWindow(toolsetId: string): Promise<ToolsetWindowState> {
  return invokeToolsetWindow("open_toolset_window", toolsetId);
}

export async function closeToolsetWindow(toolsetId: string): Promise<ToolsetWindowState> {
  return invokeToolsetWindow("close_toolset_window", toolsetId);
}

export async function focusToolsetWindow(toolsetId: string): Promise<ToolsetWindowState> {
  return invokeToolsetWindow("focus_toolset_window", toolsetId);
}

export async function toggleToolsetWindow(toolsetId: string): Promise<ToolsetWindowState> {
  return invokeToolsetWindow("toggle_toolset_window", toolsetId);
}

export async function toggleSpin3dDebuggerWindow(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("toggle_spin3d_debugger_window");
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

export async function openToolPalette(): Promise<PaletteWindowState> {
  return openToolsetWindow(DEFAULT_TOOLSET_ID);
}

export async function closeToolPalette(): Promise<PaletteWindowState> {
  return closeToolsetWindow(DEFAULT_TOOLSET_ID);
}

export async function focusToolPalette(): Promise<PaletteWindowState> {
  return focusToolsetWindow(DEFAULT_TOOLSET_ID);
}

export async function toggleToolPalette(): Promise<PaletteWindowState> {
  return toggleToolsetWindow(DEFAULT_TOOLSET_ID);
}

export async function toolPaletteState(): Promise<PaletteWindowState> {
  const states = await listToolsetWindowStates();
  return states.find((state) => state.toolsetId === DEFAULT_TOOLSET_ID) ?? {
    toolsetId: DEFAULT_TOOLSET_ID,
    open: false,
    focused: false
  };
}

export async function sendPaletteCommand(commandId: string): Promise<void> {
  return routeToolsetCommand(commandId);
}

export async function routeToolsetCommand(commandId: string): Promise<void> {
  const payload = createToolsetCommandPayload(commandId);
  const [{ invoke }, { emit }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event")
  ]);
  await emit<ToolsetCommandPayload>(PALETTE_COMMAND_EVENT, payload).catch(() => undefined);
  await invoke("route_toolset_command", payload as unknown as Record<string, unknown>);
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
  const routedHandler = dedupeAdjacentCommands(handler);
  const unlistenDom = listenForDomToolsetCommands(routedHandler);
  if (!isDesktopRuntime()) {
    return unlistenDom;
  }

  const [{ getCurrentWindow }, { getCurrentWebview }, { listen }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/webview"),
    import("@tauri-apps/api/event")
  ]);
  const onTauriCommand = (event: { payload?: Partial<ToolsetCommandPayload> }) => {
    if (typeof event.payload?.commandId === "string") {
      routedHandler(event.payload.commandId);
    }
  };
  const [unlistenWindow, unlistenWebview, unlistenGlobal] = await Promise.all([
    getCurrentWindow().listen<ToolsetCommandPayload>(PALETTE_COMMAND_EVENT, onTauriCommand),
    getCurrentWebview().listen<ToolsetCommandPayload>(PALETTE_COMMAND_EVENT, onTauriCommand),
    listen<ToolsetCommandPayload>(PALETTE_COMMAND_EVENT, onTauriCommand)
  ]);
  return () => {
    unlistenDom();
    unlistenWindow();
    unlistenWebview();
    unlistenGlobal();
  };
}

export async function listenForToolsetActiveTool(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommandPayload(TOOLSET_ACTIVE_TOOL_EVENT, handler);
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

function dedupeAdjacentCommands(handler: (commandId: string) => void): (commandId: string) => void {
  let lastCommandId: string | undefined;
  let lastCommandAt = 0;

  return (commandId) => {
    const now = Date.now();
    if (commandId === lastCommandId && now - lastCommandAt < 100) {
      return;
    }

    lastCommandId = commandId;
    lastCommandAt = now;
    handler(commandId);
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
