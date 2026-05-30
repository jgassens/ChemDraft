export const PALETTE_COMMAND_EVENT = "chemdraft://palette-command";
export const TOOLSET_WINDOW_STATE_EVENT = "chemdraft://toolset-window-state";
export const DEFAULT_TOOLSET_ID = "core.main";

export interface ToolsetWindowPosition {
  x: number;
  y: number;
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

export async function listToolsetWindowStates(): Promise<ToolsetWindowState[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ToolsetWindowState[]>("list_toolset_window_states");
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
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("route_toolset_command", createToolsetCommandPayload(commandId) as unknown as Record<string, unknown>);
}

export async function startPaletteWindowDrag(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function listenForPaletteCommands(handler: (commandId: string) => void): Promise<Unlisten> {
  return listenForToolsetCommands(handler);
}

export async function listenForToolsetCommands(handler: (commandId: string) => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<ToolsetCommandPayload>(PALETTE_COMMAND_EVENT, (event) => {
    if (typeof event.payload?.commandId === "string") {
      handler(event.payload.commandId);
    }
  });
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
