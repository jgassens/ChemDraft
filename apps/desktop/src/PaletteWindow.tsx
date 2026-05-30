import { useEffect, type PointerEvent } from "react";
import { ToolPalette } from "./ToolPalette";
import { desktopToolsetRegistry, getToolsetCommandGroups } from "./toolsets";
import { sendPaletteCommand, startPaletteWindowDrag } from "./window-manager";

export function PaletteWindow({ toolsetId = "core.main" }: { toolsetId?: string }) {
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

  const toolset = desktopToolsetRegistry.get(toolsetId) ?? desktopToolsetRegistry.require("core.main");
  const groups = getToolsetCommandGroups(toolset.id);

  return (
    <main
      className="palette-window-shell"
      aria-label={`ChemDraft floating ${toolset.title}`}
      data-toolset-id={toolset.id}
      data-palette-drag-surface="true"
      onPointerDown={startDragFromPaletteSurface}
    >
      <div className="palette-title" data-tauri-drag-region>
        {toolset.title.replace(/ Toolbar$/, "")}
      </div>
      <ToolPalette groups={groups} activeTool="tool.select" mode="floating" title={toolset.title} onInvoke={invokeCommand} />
    </main>
  );
}
