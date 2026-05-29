import { useEffect } from "react";
import { paletteGroups } from "./commands";
import { ToolPalette } from "./ToolPalette";
import { sendPaletteCommand, startPaletteWindowDrag } from "./window-manager";

export function PaletteWindow() {
  useEffect(() => {
    document.body.classList.add("palette-window-body");
    return () => {
      document.body.classList.remove("palette-window-body");
    };
  }, []);

  const invokeCommand = (commandId: string) => {
    void sendPaletteCommand(commandId).catch(() => undefined);
  };

  return (
    <main className="palette-window-shell" aria-label="ChemDraft floating tool palette">
      <div
        className="palette-title"
        data-tauri-drag-region
        onPointerDown={() => {
          void startPaletteWindowDrag();
        }}
      >
        Tools
      </div>
      <ToolPalette groups={paletteGroups} activeTool="tool.select" mode="floating" onInvoke={invokeCommand} />
    </main>
  );
}
