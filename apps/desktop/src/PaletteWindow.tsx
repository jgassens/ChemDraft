import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { DefaultNativeTextStyle, type NativeTextStyle, type TextSpan } from "@chemdraft/chem-core";
import { ToolPalette, type ToolbarPopoverAnchor } from "./ToolPalette";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  getToolsetCommandGroups,
  type DesktopToolsetRegistry
} from "./toolsets";
import {
  DEFAULT_TOOLSET_ID,
  closeToolsetWindow,
  closeToolsetPopoverWindow,
  currentWindowLogicalPosition,
  dismissToolsetPopovers,
  openToolsetPopoverWindow,
  listenForToolsetActiveTool,
  listenForToolsetTextStyle,
  loadToolsetLayoutState,
  requestToolsetActiveTool,
  requestToolsetTextStyle,
  sendPaletteCommand,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  startPaletteWindowDrag,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload,
  type ToolsetMoleculeInspectorPayload,
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

export function PaletteWindow({
  toolsetId = "core.main",
  // Interim seam so tests (and, until Phase 4's definition-push, callers) can supply a
  // registry that already includes plugin toolsets. Defaults to the core registry.
  initialRegistry
}: {
  toolsetId?: string;
  initialRegistry?: DesktopToolsetRegistry;
}) {
  const dragRef = useRef<PaletteWindowDrag | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const lastLoggedSizeRef = useRef<string>("");
  const pendingPositionRef = useRef<ToolsetWindowPosition | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const sizeAnimationFrameRef = useRef<number | undefined>(undefined);
  const [toolsetRegistry, setToolsetRegistry] = useState(() => initialRegistry ?? desktopToolsetRegistry);
  const [activeTool, setActiveTool] = useState("tool.select");
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [currentTextStyle, setCurrentTextStyle] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [currentTextScript, setCurrentTextScript] = useState<TextSpan["script"]>("normal");
  const [currentArtStyle, setCurrentArtStyle] = useState<ToolsetArtStylePayload | undefined>();
  const [currentArtStyleTarget, setCurrentArtStyleTarget] = useState<ToolsetArtPaintTarget>("fill");
  const [currentMoleculeInspector, setCurrentMoleculeInspector] = useState<ToolsetMoleculeInspectorPayload | undefined>();
  const toolset = toolsetRegistry.get(toolsetId) ?? toolsetRegistry.require(DEFAULT_TOOLSET_ID);
  const groups = getToolsetCommandGroups(toolset.id, toolsetRegistry);
  const shortcutRegistry = useMemo(
    () => createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), { includeDisabled: true }),
    []
  );

  useEffect(() => {
    document.documentElement.classList.add("palette-window-html");
    document.body.classList.add("palette-window-body");
    return () => {
      document.documentElement.classList.remove("palette-window-html");
      document.body.classList.remove("palette-window-body");
      if (animationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (sizeAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(sizeAnimationFrameRef.current);
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

  useEffect(() => {
    const preferredSize = toolset.preferredWindowSize;
    if (!preferredSize) {
      return;
    }

    const shell = shellRef.current;
    const applySize = () => {
      // Fit the window to the palette's own content in BOTH dimensions. The shell is
      // width/height:max-content (see CSS), so its measured box is the natural content size:
      // the window shrinks when the manifest size is too big (blank gaps) and grows when
      // content is larger (crowded rows). colorPickerOpen reserves room for the open swatch.
      const rect = shell?.getBoundingClientRect();
      const contentWidth = rect ? Math.ceil(rect.width) : 0;
      const contentHeight = rect ? Math.ceil(rect.height) : 0;
      const width = contentWidth > 0 ? contentWidth : preferredSize.width;
      const height = Math.max(colorPickerOpen ? 292 : 0, contentHeight > 0 ? contentHeight : preferredSize.height);
      // Dev-only size probe: open the palette window's devtools console to read exact
      // content-vs-window numbers for any palette that still looks wrong.
      if (import.meta.env.DEV) {
        const key = `${contentWidth}x${contentHeight}->${width}x${height}`;
        if (lastLoggedSizeRef.current !== key) {
          lastLoggedSizeRef.current = key;
          console.log(`[palette-size] ${toolset.id}: content ${contentWidth}x${contentHeight} -> window ${width}x${height}`);
        }
      }
      void setCurrentWindowLogicalSize({ width, height }).catch(() => undefined);
    };

    applySize();

    if (!shell || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (sizeAnimationFrameRef.current !== undefined) {
        return;
      }

      sizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        sizeAnimationFrameRef.current = undefined;
        applySize();
      });
    });
    observer.observe(shell);

    return () => {
      observer.disconnect();
      if (sizeAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(sizeAnimationFrameRef.current);
        sizeAnimationFrameRef.current = undefined;
      }
    };
  }, [colorPickerOpen, toolset.preferredWindowSize]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetActiveTool((commandId) => {
      setActiveTool(commandId);
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestToolsetActiveTool().catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetTextStyle((payload) => {
      setCurrentTextStyle(payload.currentTextStyle);
      setCurrentTextScript(payload.currentTextScript);
      setCurrentArtStyle(payload.currentArtStyle);
      setCurrentArtStyleTarget(payload.currentArtStyle?.activePaintTarget ?? payload.currentArtStyleTarget ?? "fill");
      setCurrentMoleculeInspector(payload.currentMoleculeInspector);
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestToolsetTextStyle().catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandId = shortcutRegistry.resolve(event);
      if (!commandId) {
        return;
      }

      event.preventDefault();
      void sendPaletteCommand(commandId).catch(() => undefined);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [shortcutRegistry]);

  const invokeCommand = (commandId: string) => {
    void sendPaletteCommand(commandId).catch(() => undefined);
  };
  const previewCommand = (commandId: string) => {
    void sendPaletteCommandPreview(commandId).catch(() => undefined);
  };
  const commitPreviewCommand = (commandId: string) => {
    void sendPaletteCommandCommit(commandId).catch(() => undefined);
  };
  const cancelPreviewCommand = () => {
    void sendPaletteCommandCancel("palette.preview.cancel").catch(() => undefined);
  };

  // Open the colour picker in its own floating window at the swatch, so it overflows this little
  // palette and floats over the document. `anchor` is the swatch's client rect inside this webview;
  // add our own window position to get screen coords. Clicking the swatch always (re)opens and
  // repositions — deliberately NOT a toggle: the panel hides itself on app-deactivate
  // (hidesOnDeactivate), which a local "is it open?" flag can't observe, so a toggle would go stale
  // and eat the next click. Dismissal is Escape (in the popover) or app-deactivate.
  const openArtColorPopover = (anchor: ToolbarPopoverAnchor) => {
    void (async () => {
      const windowPosition = await currentWindowLogicalPosition().catch(() => undefined);
      const screenX = (windowPosition?.x ?? 0) + anchor.left;
      const screenY = (windowPosition?.y ?? 0) + anchor.bottom + 4;
      await openToolsetPopoverWindow(toolset.id, "artColor", screenX, screenY);
      // Make sure the freshly shown picker reflects the current object's colour.
      await requestToolsetTextStyle().catch(() => undefined);
    })();
  };

  // If this palette goes away, don't leave its popover window orphaned on screen.
  useEffect(() => {
    return () => {
      void closeToolsetPopoverWindow(toolset.id).catch(() => undefined);
    };
  }, [toolset.id]);

  // A pointer-down anywhere in this palette that isn't a colour swatch dismisses any open popover
  // ("click elsewhere closes it"). The swatch is excluded so re-clicking it repositions its popover
  // rather than close-then-reopen. The popover lives in its own window, so its own clicks never
  // reach this listener.
  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".toolbar-color-trigger")) {
        return;
      }
      void dismissToolsetPopovers().catch(() => undefined);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, []);

  const hidePaletteWindow = (event: ReactMouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void closeToolsetWindow(toolset.id).catch(() => undefined);
  };

  const startDragFromPaletteSurface = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button, select, input, textarea, [data-palette-control]")) {
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

    if ((event.target as HTMLElement).closest("button, select, input, textarea, [data-palette-control]")) {
      return;
    }

    event.preventDefault();
    beginPaletteWindowDrag(event.screenX, event.screenY);
  };

  const startDragFromTitle = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginPaletteWindowDrag(event.screenX, event.screenY, event.pointerId);
  };

  const startMouseDragFromTitle = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    beginPaletteWindowDrag(event.screenX, event.screenY);
  };

  const beginPaletteWindowDrag = (screenX: number, screenY: number, pointerId?: number) => {
    // The OS owns the drag: startDragging() (and the title bar's data-tauri-drag-region)
    // move the window natively and smoothly. We deliberately do NOT also set the window
    // position from pointer deltas — doing both made the OS and JS fight over the position
    // every frame, which is the jitter/skipping seen while dragging. Window geometry is
    // persisted by the Rust WindowEvent::Moved handler, so nothing here needs to write it.
    void startPaletteWindowDrag().catch(() => undefined);

    dragRef.current = {
      pointerId,
      originX: screenX,
      originY: screenY,
      currentX: screenX,
      currentY: screenY
    };
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
      ref={shellRef}
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
      <div
        className="palette-title"
        data-palette-title-drag-surface="true"
        data-tauri-drag-region="true"
        onPointerDown={startDragFromTitle}
        onPointerMove={movePaletteWindow}
        onPointerUp={stopPaletteWindowDrag}
        onPointerCancel={stopPaletteWindowDrag}
        onMouseDown={startMouseDragFromTitle}
        onMouseMove={movePaletteWindowFromMouse}
        onMouseUp={stopPaletteWindowMouseDrag}
      >
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
      <ToolPalette
        groups={groups}
        activeTool={activeTool}
        mode="floating"
        orientation={toolset.gridLayout?.orientation ?? "vertical"}
        title={toolset.title}
        showMainStyleControls={toolset.id === "core.main"}
        showTextStyleControls={toolset.id === "core.text"}
        showArtStyleControls={toolset.id === "core.art"}
        showRingInspectorControls={toolset.id === "core.ringInspector"}
        showMoleculeInspectorControls={toolset.id === "core.moleculeInspector"}
        currentObjectColor={currentTextStyle.color}
        currentArtStyle={currentArtStyle}
        currentArtStyleTarget={currentArtStyleTarget}
        currentMoleculeInspector={currentMoleculeInspector}
        currentTextStyle={currentTextStyle}
        currentTextScript={currentTextScript}
        onColorPickerOpenChange={setColorPickerOpen}
        onRequestColorPopover={openArtColorPopover}
        onArtStylePreview={previewCommand}
        onArtStyleCommit={commitPreviewCommand}
        onArtStyleCancel={cancelPreviewCommand}
        onMoleculeInspectorPreview={previewCommand}
        onMoleculeInspectorCommit={commitPreviewCommand}
        onMoleculeInspectorCancel={cancelPreviewCommand}
        onInvoke={invokeCommand}
      />
    </main>
  );
}
