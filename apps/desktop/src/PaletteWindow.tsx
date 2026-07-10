import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { DefaultNativeTextStyle, type NativeTextStyle, type TextSpan } from "@chemdraft/chem-core";
import {
  PALETTE_TOOLTIP_DOM_EVENT,
  ToolPalette,
  type PaletteTooltipDomDetail,
  type ToolbarFlyoutRequest,
  type ToolbarPopoverAnchor
} from "./ToolPalette";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { ToolbarCustomizeController } from "./toolbars/CustomizeMainToolbar/ToolbarCustomizeController";
import { CustomizeBar } from "./toolbars/CustomizeMainToolbar/CustomizeBar";
import { GalleryTray } from "./toolbars/CustomizeMainToolbar/GalleryTray";
import {
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  computePaletteGridSize,
  getToolsetPaletteGroups,
  paletteCommandGroupsFromItemGroups,
  type DesktopToolsetRegistry
} from "./toolsets";
import {
  DEFAULT_TOOLSET_ID,
  closeToolsetWindow,
  closeToolsetPopoverWindow,
  currentWindowLogicalPosition,
  dismissToolsetPopovers,
  hidePaletteFloatingTooltip,
  openToolsetPopoverWindow,
  listenForPalettePointer,
  listenForPalettePointerLeave,
  listenForToolsetActiveTool,
  listenForToolsetCustomizeMode,
  listenForToolsetLayoutState,
  listenForToolsetPopoverContentRequests,
  listenForToolsetTextStyle,
  loadToolsetLayoutState,
  requestToolsetCustomizeMode,
  requestToolsetLayoutState,
  requestToolsetActiveTool,
  requestToolsetTextStyle,
  sendToolsetLayoutEdit,
  setToolsetPopoverContent,
  sendPaletteCommand,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  showPaletteFloatingTooltip,
  setCurrentWindowLogicalPosition,
  setCurrentWindowLogicalSize,
  setToolsetWindowFocusable,
  startPaletteWindowDrag,
  type ToolsetArtPaintTarget,
  type ToolsetArtStylePayload,
  type ToolsetMoleculeInspectorPayload,
  type ToolsetPopoverContent,
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
  // Keep group ids (customize-mode reorder edits are per-group); itemGroups drops them.
  const paletteGroups = useMemo(() => getToolsetPaletteGroups(toolset.id, toolsetRegistry), [toolset.id, toolsetRegistry]);
  const itemGroups = useMemo(() => paletteGroups.map((group) => group.items), [paletteGroups]);
  // Derive command groups from the already-normalized itemGroups instead of normalizing the toolset a second time.
  const groups = useMemo(() => paletteCommandGroupsFromItemGroups(itemGroups), [itemGroups]);
  const gridWindowSize = useMemo(() => computePaletteGridSize(toolset.gridLayout, itemGroups), [itemGroups, toolset.gridLayout]);
  // The full command catalog feeds both the shortcut registry and the customize gallery. Customize
  // mode never invokes, so a static (phase-4) document is fine — we only need id/title/icon.
  const allCommands = useMemo(() => allShellCommands(createPhase4Document()), []);
  const shortcutRegistry = useMemo(
    () => createDesktopShortcutRegistry(allCommands, { includeDisabled: true }),
    [allCommands]
  );
  // Customization ids already in the toolbar — the gallery grays these so a command can't be added
  // twice (a command id is unique within a toolset).
  const presentItemIds = useMemo(
    () => new Set(paletteGroups.flatMap((group) => group.items.map((item) => item.id))),
    [paletteGroups]
  );

  // In-place customize mode (Main palette only). MainWindow broadcasts the flag; we mirror it and
  // suppress the drag-fighting feeds (pointer-feed hover synthesis, tooltips, popover-dismiss, shell
  // window-drag) while it's on. The ref lets the always-subscribed feed effects read it live.
  const [customizeActive, setCustomizeActive] = useState(false);
  const customizeThisPalette = customizeActive && toolset.id === DEFAULT_TOOLSET_ID;
  const customizeThisPaletteRef = useRef(false);
  customizeThisPaletteRef.current = customizeThisPalette;
  const customizeGroupIds = useMemo(() => paletteGroups.map((group) => group.id), [paletteGroups]);

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

  // Follow live layout-state changes from the Customize dialog. The registry above is built once at
  // window creation, so without this subscription item hides/reorders/renames would never reach an
  // already-open palette. Also request the current state once subscribed — the disk copy read on
  // mount can be stale while the main window's save chain is still flushing.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetLayoutState((layoutState) => {
      if (!active || layoutState === undefined || layoutState === null) {
        return;
      }
      try {
        setToolsetRegistry(createDesktopToolsetRegistry(layoutState));
      } catch {
        // Malformed state: keep showing the last good layout rather than blanking the palette.
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        void requestToolsetLayoutState().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Follow the customize-mode flag for THIS toolset; request the current state once subscribed so a
  // palette that opened mid-mode picks it up (same request/response shape as layout state).
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetCustomizeMode((payload) => {
      if (active && payload.toolsetId === toolset.id) {
        setCustomizeActive(payload.active);
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        void requestToolsetCustomizeMode().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [toolset.id]);

  // Palettes ship non-focusable; the gallery's search field needs keystrokes, so flip focusability on
  // while customizing this palette and back off on exit (restoring the never-steal-key default).
  useEffect(() => {
    if (!customizeThisPalette) {
      return;
    }
    void setToolsetWindowFocusable(toolset.id, true).catch(() => undefined);
    return () => {
      void setToolsetWindowFocusable(toolset.id, false).catch(() => undefined);
    };
  }, [customizeThisPalette, toolset.id]);

  useEffect(() => {
    const preferredSize = toolset.preferredWindowSize ?? gridWindowSize;
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
  }, [colorPickerOpen, gridWindowSize, toolset.preferredWindowSize]);

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

  // Synthesize hover from the Rust pointer feed. This panel never becomes the key window (so
  // clicking it can't steal the document's focus), and macOS only delivers hover/mouseMoved to the
  // key window — so CSS :hover and pointerenter never fire here natively. Rust polls the cursor and
  // pushes window-local coordinates; we resolve the element under them and dispatch bubbling
  // pointerover/out pairs (which React turns into pointerenter/leave — the tooltip trigger), plus a
  // hover class for the :hover styling the OS can't apply.
  useEffect(() => {
    let unlistenMove: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;
    let lastElement: Element | null = null;
    const HOVER_CLASS = "palette-synthetic-hover";

    const syntheticPointer = (type: string, target: Element, relatedTarget: Element | null, x?: number, y?: number) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "mouse",
          relatedTarget: relatedTarget ?? document.body,
          clientX: x,
          clientY: y
        })
      );
    };
    const swapHoverClass = (previous: Element | null, next: Element | null) => {
      const previousHoverable = previous?.closest(".icon-button, .toolbar-text-button, .toolbar-align-button");
      const nextHoverable = next?.closest(".icon-button, .toolbar-text-button, .toolbar-align-button");
      if (previousHoverable !== nextHoverable) {
        previousHoverable?.classList.remove(HOVER_CLASS);
        nextHoverable?.classList.add(HOVER_CLASS);
      }
    };
    const handleLeave = () => {
      if (!lastElement) {
        return;
      }
      syntheticPointer("pointerout", lastElement, null);
      swapHoverClass(lastElement, null);
      lastElement = null;
    };
    const handleMove = (x: number, y: number) => {
      // No synthetic hover during customize mode — a button-less pointerover mid-drag confuses
      // dnd-kit's hit-testing and re-arms tooltip timers.
      if (customizeThisPaletteRef.current) {
        handleLeave();
        return;
      }
      const element = document.elementFromPoint(x, y);
      if (element === lastElement) {
        return;
      }
      const previous = lastElement;
      lastElement = element;
      if (previous) {
        syntheticPointer("pointerout", previous, element);
      }
      if (element) {
        syntheticPointer("pointerover", element, previous, x, y);
      }
      swapHoverClass(previous, element);
    };

    void listenForPalettePointer(toolset.id, (payload) => handleMove(payload.x, payload.y))
      .then((cleanup) => {
        unlistenMove = cleanup;
      })
      .catch(() => undefined);
    void listenForPalettePointerLeave(toolset.id, handleLeave)
      .then((cleanup) => {
        unlistenLeave = cleanup;
      })
      .catch(() => undefined);

    return () => {
      unlistenMove?.();
      unlistenLeave?.();
      handleLeave();
    };
  }, [toolset.id]);

  // Relay tooltip visibility from the shells (a DOM CustomEvent — ToolPalette stays
  // runtime-agnostic) into the shared floating tooltip window, converting the shell's client rect
  // to global screen coordinates the same way popovers are anchored. The in-DOM tooltip span is
  // hidden in palette windows: this content-fit window would clip it.
  useEffect(() => {
    const handleTooltip = (event: Event) => {
      if (customizeThisPaletteRef.current) {
        void hidePaletteFloatingTooltip().catch(() => undefined);
        return;
      }
      const detail = (event as CustomEvent<PaletteTooltipDomDetail>).detail;
      if (!detail) {
        return;
      }
      if (!detail.visible || !detail.anchor || !(detail.title || detail.description)) {
        void hidePaletteFloatingTooltip().catch(() => undefined);
        return;
      }
      const { title, description, shortcut, anchor } = detail;
      void (async () => {
        const windowPosition = await currentWindowLogicalPosition().catch(() => undefined);
        if (!windowPosition) {
          return;
        }
        await showPaletteFloatingTooltip({
          title: title ?? "",
          description,
          shortcut,
          anchorCenterX: windowPosition.x + anchor.left + (anchor.right - anchor.left) / 2,
          belowY: windowPosition.y + anchor.bottom + 6,
          aboveY: windowPosition.y + anchor.top - 6
        });
      })().catch(() => undefined);
    };
    window.addEventListener(PALETTE_TOOLTIP_DOM_EVENT, handleTooltip);
    return () => {
      window.removeEventListener(PALETTE_TOOLTIP_DOM_EVENT, handleTooltip);
      void hidePaletteFloatingTooltip().catch(() => undefined);
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

  // The colour picker and the flyout dropdowns open in this palette's own floating popover window
  // (they overflow the little palette and float over the document). The window is content-agnostic,
  // so opening one after another just swaps its content — no second window to keep in sync. `anchor`
  // is a client rect inside this webview; add our window position to get screen coords. We remember
  // the last content so the window can re-request it after it mounts (the create-vs-emit race).
  const lastPopoverContentRef = useRef<ToolsetPopoverContent>({ kind: "artColor" });

  const openPopover = (anchor: ToolbarPopoverAnchor, kind: string, content: ToolsetPopoverContent) => {
    lastPopoverContentRef.current = content;
    void (async () => {
      const windowPosition = await currentWindowLogicalPosition().catch(() => undefined);
      const screenX = (windowPosition?.x ?? 0) + anchor.left;
      const screenY = (windowPosition?.y ?? 0) + anchor.bottom + 4;
      await openToolsetPopoverWindow(toolset.id, kind, screenX, screenY);
      await setToolsetPopoverContent(toolset.id, content);
    })();
  };

  // Clicking the swatch always (re)opens + repositions — deliberately NOT a toggle: the panel hides
  // itself on app-deactivate (hidesOnDeactivate), which a local "is it open?" flag can't observe, so
  // a toggle would go stale and eat the next click. Dismissal is Escape / click-away / app-deactivate.
  const openArtColorPopover = (anchor: ToolbarPopoverAnchor) => {
    openPopover(anchor, "artColor", { kind: "artColor" });
    // Make sure the freshly shown picker reflects the current object's colour.
    void requestToolsetTextStyle().catch(() => undefined);
  };

  const openFlyoutPopover = (request: ToolbarFlyoutRequest) => {
    openPopover(request.anchor, "flyout", { kind: "flyout", flyout: request.flyout });
  };

  // If this palette goes away, don't leave its popover window orphaned on screen.
  useEffect(() => {
    return () => {
      void closeToolsetPopoverWindow(toolset.id).catch(() => undefined);
    };
  }, [toolset.id]);

  // The popover window re-requests its content once it mounts (create-vs-emit race); answer with
  // whatever we last opened for this palette.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForToolsetPopoverContentRequests((requestedToolsetId) => {
      if (requestedToolsetId !== toolset.id) {
        return;
      }
      void setToolsetPopoverContent(toolset.id, lastPopoverContentRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [toolset.id]);

  // A pointer-down anywhere in this palette that isn't a popover trigger dismisses any open popover
  // ("click elsewhere closes it"). The colour swatch and flyout buttons are excluded so re-clicking
  // one repositions/swaps its popover rather than close-then-reopen. The popover lives in its own
  // window, so its own clicks never reach this listener.
  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (customizeThisPaletteRef.current) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(".toolbar-color-trigger, .command-flyout-button, .distribute-mode-button")) {
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
    if (event.button !== 0 || customizeThisPaletteRef.current) {
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
    if (event.button !== 0 || customizeThisPaletteRef.current) {
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

  const paletteElement = (
    <ToolPalette
      groups={groups}
      itemGroups={itemGroups}
      gridLayout={toolset.gridLayout}
      activeTool={activeTool}
      mode="floating"
      orientation={toolset.gridLayout?.orientation ?? "vertical"}
      title={toolset.title}
      onRequestFlyout={openFlyoutPopover}
      onInvoke={invokeCommand}
      customize={customizeThisPalette ? { groupIds: customizeGroupIds } : undefined}
      widgetState={{
        currentObjectColor: currentTextStyle.color,
        currentArtStyle,
        currentArtStyleTarget,
        currentMoleculeInspector,
        currentTextStyle,
        currentTextScript,
        onColorPickerOpenChange: setColorPickerOpen,
        onRequestColorPopover: openArtColorPopover,
        onArtStylePreview: previewCommand,
        onArtStyleCommit: commitPreviewCommand,
        onArtStyleCancel: cancelPreviewCommand,
        onMoleculeInspectorPreview: previewCommand,
        onMoleculeInspectorCommit: commitPreviewCommand,
        onMoleculeInspectorCancel: cancelPreviewCommand,
        onInvoke: invokeCommand
      }}
    />
  );

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
      {customizeThisPalette ? (
        <ToolbarCustomizeController
          toolsetId={toolset.id}
          groups={paletteGroups}
          onEdit={(edit) => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit }).catch(() => undefined)}
        >
          {paletteElement}
          <CustomizeBar
            onDone={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "exitCustomize" } }).catch(() => undefined)}
            onRestoreDefaults={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "resetToolset" } }).catch(() => undefined)}
          />
          <GalleryTray commands={allCommands} presentItemIds={presentItemIds} />
        </ToolbarCustomizeController>
      ) : (
        paletteElement
      )}
    </main>
  );
}
