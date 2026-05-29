export const PALETTE_COMMAND_EVENT = "chemdraft://palette-command";

export interface PaletteWindowState {
  open: boolean;
  focused: boolean;
}

export interface PaletteCommandPayload {
  commandId: string;
}

type Unlisten = () => void;

export function isDesktopRuntime(): boolean {
  const candidate = globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

export function createPaletteCommandPayload(commandId: string): PaletteCommandPayload {
  return { commandId };
}

export async function openToolPalette(): Promise<PaletteWindowState> {
  return invokePaletteWindow("open_tool_palette");
}

export async function closeToolPalette(): Promise<PaletteWindowState> {
  return invokePaletteWindow("close_tool_palette");
}

export async function focusToolPalette(): Promise<PaletteWindowState> {
  return invokePaletteWindow("focus_tool_palette");
}

export async function toggleToolPalette(): Promise<PaletteWindowState> {
  return invokePaletteWindow("toggle_tool_palette");
}

export async function toolPaletteState(): Promise<PaletteWindowState> {
  return invokePaletteWindow("tool_palette_state");
}

export async function sendPaletteCommand(commandId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("route_palette_command", createPaletteCommandPayload(commandId) as unknown as Record<string, unknown>);
}

export async function startPaletteWindowDrag(): Promise<void> {
  if (!isDesktopRuntime()) {
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function listenForPaletteCommands(handler: (commandId: string) => void): Promise<Unlisten> {
  if (!isDesktopRuntime()) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<PaletteCommandPayload>(PALETTE_COMMAND_EVENT, (event) => {
    if (typeof event.payload?.commandId === "string") {
      handler(event.payload.commandId);
    }
  });
}

async function invokePaletteWindow(commandName: string): Promise<PaletteWindowState> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<PaletteWindowState>(commandName);
}
