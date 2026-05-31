import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { ToolPalette } from "./ToolPalette";
import { createDesktopToolsetRegistry, desktopToolsetRegistry, getToolsetCommandGroups } from "./toolsets";
import {
  DEFAULT_TOOLSET_ID,
  closeToolsetWindow,
  currentWindowLogicalPosition,
  loadToolsetLayoutState,
  sendPaletteCommand,
  setCurrentWindowLogicalPosition,
  startPaletteWindowDrag,
  type ToolsetWindowPosition
} from "./window-manager";

type PaletteWindowDrag = {
  pointerId: number | undefined;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  startX?: number;
  startY?: number;
};

export function PaletteWindow({ toolsetId = "core.main" }: { toolsetId?: string }) {
  const dragRef = useRef<PaletteWindowDrag | null>(null);
  const pendingPositionRef = useRef<ToolsetWindowPosition | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const [toolsetRegistry, setToolsetRegistry] = useState(() => desktopToolsetRegistry);
  const toolset = toolsetRegistry.get(toolsetId) ?? toolsetRegistry.require(DEFAULT_TOOLSET_ID);
  const groups = getToolsetCommandGroups(toolset.id, toolsetRegistry);

  useEffect(() => {
    document.documentElement.classList.add("palette-window-html");
    document.body.classList.add("palette-window-body");
    return () => {
      document.documentElement.classList.remove("palette-window-html");
      document.body.classList.remove("palette-window-body");
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadToolsetLayoutState()
      .then((layoutState) => {
        if (active && layoutState !== undefined) {
          setToolsetRegistry(createDesktopToolsetRegistry(layoutState));
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  const invokeCommand = (commandId: string) => {
    void sendPaletteCommand(commandId).catch(() => undefined);
  };

  const hidePaletteWindow = (event: ReactMouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void closeToolsetWindow(toolset.id).catch(() => undefined);
  };

  const startDragFromPaletteSurface = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginPaletteWindowDrag(event.screenX, event.screenY, event.pointerId);
  };

  const startMouseDragFromPaletteSurface = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    beginPaletteWindowDrag(event.screenX, event.screenY);
  };

  const beginPaletteWindowDrag = (screenX: number, screenY: number, pointerId?: number) => {
    dragRef.current = {
      pointerId,
      originX: screenX,
      originY: screenY,
      currentX: screenX,
      currentY: screenY
    };

    void currentWindowLogicalPosition()
      .then((position) => {
        const drag = dragRef.current;
        if (!position || !drag || drag.pointerId !== pointerId) {
          return;
        }

        drag.startX = position.x;
        drag.startY = position.y;
        movePaletteWindowToCurrentPointer(drag);
      })
      .catch(() => {
        void startPaletteWindowDrag().catch(() => undefined);
      });
  };

  const movePaletteWindow = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.startX === undefined || drag.startY === undefined) {
      if (drag?.pointerId === event.pointerId) {
        drag.currentX = event.screenX;
        drag.currentY = event.screenY;
      }
      return;
    }

    drag.currentX = event.screenX;
    drag.currentY = event.screenY;
    movePaletteWindowToCurrentPointer(drag);
  };

  const movePaletteWindowFromMouse = (event: ReactMouseEvent<HTMLElement> | MouseEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== undefined) {
      return;
    }

    drag.currentX = event.screenX;
    drag.currentY = event.screenY;
    movePaletteWindowToCurrentPointer(drag);
  };

  const stopPaletteWindowDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const stopPaletteWindowMouseDrag = () => {
    if (dragRef.current?.pointerId === undefined) {
      dragRef.current = null;
    }
  };

  const schedulePaletteWindowMove = (position: ToolsetWindowPosition) => {
    pendingPositionRef.current = position;
    if (animationFrameRef.current !== undefined) {
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = undefined;
      const pendingPosition = pendingPositionRef.current;
      pendingPositionRef.current = null;
      if (pendingPosition) {
        void setCurrentWindowLogicalPosition(pendingPosition).catch(() => undefined);
      }
    });
  };

  const movePaletteWindowToCurrentPointer = (drag: PaletteWindowDrag) => {
    if (drag.startX === undefined || drag.startY === undefined) {
      return;
    }

    schedulePaletteWindowMove({
      x: drag.startX + drag.currentX - drag.originX,
      y: drag.startY + drag.currentY - drag.originY
    });
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      movePaletteWindowFromMouse(event);
    };
    const handleMouseUp = () => {
      stopPaletteWindowMouseDrag();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  });

  return (
    <main
      className="palette-window-shell"
      aria-label={`ChemDraft floating ${toolset.title}`}
      data-toolset-id={toolset.id}
      data-palette-drag-surface="true"
      onPointerDown={startDragFromPaletteSurface}
      onPointerMove={movePaletteWindow}
      onPointerUp={stopPaletteWindowDrag}
      onPointerCancel={stopPaletteWindowDrag}
      onMouseDown={startMouseDragFromPaletteSurface}
      onMouseMove={movePaletteWindowFromMouse}
      onMouseUp={stopPaletteWindowMouseDrag}
    >
      <div className="palette-title">
        <button
          className="palette-close-button"
          type="button"
          title={`Hide ${toolset.title}`}
          aria-label={`Hide ${toolset.title}`}
          onPointerDown={hidePaletteWindow}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={hidePaletteWindow}
        >
        </button>
        <span className="palette-title-label">{toolset.title.replace(/ Toolbar$/, "")}</span>
      </div>
      <ToolPalette groups={groups} activeTool="tool.select" mode="floating" title={toolset.title} onInvoke={invokeCommand} />
    </main>
  );
}
