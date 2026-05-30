import { useEffect, type PointerEvent } from "react";
import { paletteGroups } from "./commands";
import { ToolPalette } from "./ToolPalette";
import { sendPaletteCommand, startPaletteWindowDrag } from "./window-manager";

export function PaletteWindow() {
  useEffect(() => {
    document.documentElement.classList.add("palette-window-html");
    document.body.classList.add("palette-window-body");
    return () => {
      document.documentElement.classList.remove("palette-window-html");
      document.body.classList.remove("palette-window-body");
    };
  }, []);

  const invokeCommand = (commandId: string) => {
    void sendPaletteCommand(commandId).catch(() => undefined);
  };

  const startDragFromPaletteSurface = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    void startPaletteWindowDrag();
  };

  return (
    <main
      className="palette-window-shell"
      aria-label="ChemDraft floating tool palette"
      data-palette-drag-surface="true"
      onPointerDown={startDragFromPaletteSurface}
    >
      <div className="palette-title" data-tauri-drag-region>
        Tools
      </div>
      <ToolPalette groups={paletteGroups} activeTool="tool.select" mode="floating" onInvoke={invokeCommand} />
    </main>
  );
}
