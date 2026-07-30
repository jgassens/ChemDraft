import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { DefaultNativeTextStyle, type NativeTextStyle, type TextSpan } from "@chemdraft/chem-core";
import {
  APPENDABLE_TOOLBAR_WIDGETS,
  PALETTE_TOOLTIP_DOM_EVENT,
  ToolPalette,
  type PaletteTooltipDomDetail,
  type ToolbarFlyoutRequest,
  type ToolbarPopoverAnchor
} from "./ToolPalette";
import { allShellCommands, type CommandSpec } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { TOOLBAR_SELECTION_KINDS, type ToolbarSelectionModel } from "./toolbars/toolbarSelectionKind";
import { ToolbarCustomizeController } from "./toolbars/CustomizeMainToolbar/ToolbarCustomizeController";
import { CustomizeBar } from "./toolbars/CustomizeMainToolbar/CustomizeBar";
import { GalleryTray } from "./toolbars/CustomizeMainToolbar/GalleryTray";
import { SHELL_COMMAND_IDS } from "./shellCommandIds";
import {
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  computePaletteGridSize,
  getToolsetCommandSpecs,
  getToolsetPaletteGroups,
  paletteCommandGroupsFromItemGroups,
  type DesktopToolsetDefinition,
  type DesktopToolsetRegistry,
  type ToolbarPaletteGroupModel
} from "./toolsets";
import { isCompatOnlyArtVariantCommandId, TRANSITIONAL_STUB_COMMAND_IDS } from "./drawingTools";
import {
  DEFAULT_TOOLSET_ID,
  closeToolsetWindow,
  closeToolsetPopoverWindow,
  currentWindowLogicalPosition,
  dismissToolsetPopovers,
  hidePaletteFloatingTooltip,
  openToolsetPopoverWindow,
  prewarmToolsetPopoverWindow,
  listenForPalettePointer,
  listenForPalettePointerLeave,
  listenForToolsetActiveTool,
  listenForToolsetCommandSpecs,
  listenForToolsetCustomizeMode,
  listenForToolsetDefinitions,
  listenForToolsetLayoutState,
  listenForToolsetPopoverContentRequests,
  listenForToolsetTextStyle,
  loadToolsetLayoutState,
  requestToolsetCustomizeMode,
  requestToolsetCommandSpecs,
  requestToolsetDefinitions,
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
  toolsetCommandSpecsSignature,
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

/** Rehydrate persisted palette layout against both the static shell catalog and runtime commands
 *  contributed by user/plugin toolsets. The latter must not be pruned while a detached palette is
 *  waiting for its next layout/spec broadcast. */
export function createPaletteRegistryFromLayoutState(
  layoutState: unknown,
  commandSpecs: readonly CommandSpec[],
  pluginToolsets: readonly DesktopToolsetDefinition[] = []
): DesktopToolsetRegistry {
  return createDesktopToolsetRegistry(
    layoutState,
    new Set([...SHELL_COMMAND_IDS, ...commandSpecs.map((command) => command.id)]),
    pluginToolsets
  );
}

/** A neutral, empty stand-in for a toolset whose definition hasn't reached this webview yet (a plugin
 *  or user toolbar window before its definitions broadcast lands, or an orphaned window for a toolset
 *  that no longer exists). It carries the window's real id so the title bar, close button, and popover
 *  routing all target the correct window — the point is precisely NOT to masquerade as core.main. The
 *  OS-level window title (set by Rust at open time) still shows the real toolbar name meanwhile. */
function pendingPlaceholderToolset(toolsetId: string): DesktopToolsetDefinition {
  return {
    id: toolsetId,
    title: "",
    source: "plugin",
    defaultVisible: true,
    defaultMode: "floating",
    groups: [{ id: `${toolsetId}.pending`, items: [] }]
  };
}

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
  const [commandSpecs, setCommandSpecs] = useState<CommandSpec[]>(() =>
    allShellCommands(createPhase4Document(), undefined, {
      registry: initialRegistry ?? desktopToolsetRegistry
    })
  );
  const commandSpecsRef = useRef(commandSpecs);
  const commandSpecsSignatureRef = useRef(toolsetCommandSpecsSignature(commandSpecs));
  const latestLayoutStateRef = useRef<unknown>(undefined);
  // Plugin toolset definitions arrive over IPC (they aren't in the static manifest this webview ships
  // with). Held in a ref so every registry rebuild — layout, command-spec, or definitions — folds in
  // the latest set from one source.
  const pluginToolsetsRef = useRef<readonly DesktopToolsetDefinition[]>([]);
  commandSpecsRef.current = commandSpecs;
  const [activeTool, setActiveTool] = useState("tool.select");
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [currentTextStyle, setCurrentTextStyle] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [currentTextScript, setCurrentTextScript] = useState<TextSpan["script"]>("normal");
  const [currentArtStyle, setCurrentArtStyle] = useState<ToolsetArtStylePayload | undefined>();
  const [currentArtStyleTarget, setCurrentArtStyleTarget] = useState<ToolsetArtPaintTarget>("fill");
  const [currentMoleculeInspector, setCurrentMoleculeInspector] = useState<ToolsetMoleculeInspectorPayload | undefined>();
  const [currentSelection, setCurrentSelection] = useState<ToolbarSelectionModel | undefined>();
  // A window opened for a plugin/user toolset starts with the core-only registry (its definition
  // arrives over the definitions IPC channel a beat later). While it's unknown, render an empty
  // placeholder carrying THIS window's real id — never fall back to core.main, which would render the
  // Main toolbar under the plugin's title AND make its close button target the real Main window.
  const knownToolset = toolsetRegistry.get(toolsetId);
  const toolset = useMemo(
    () => knownToolset ?? pendingPlaceholderToolset(toolsetId),
    [knownToolset, toolsetId]
  );
  const commandOverrides = useMemo(
    () => new Map(commandSpecs.map((command) => [command.id, command] as const)),
    [commandSpecs]
  );
  // Keep group ids (customize-mode reorder edits are per-group); itemGroups drops them. An
  // as-yet-unknown toolset (placeholder) isn't in the registry, so render no groups until its
  // definition lands rather than throwing on registry.require().
  const paletteGroups = useMemo(
    () => (knownToolset ? getToolsetPaletteGroups(toolset.id, toolsetRegistry, commandOverrides) : []),
    [knownToolset, commandOverrides, toolset.id, toolsetRegistry]
  );
  const itemGroups = useMemo(() => paletteGroups.map((group) => group.items), [paletteGroups]);
  const gridWindowSize = useMemo(() => computePaletteGridSize(toolset.gridLayout, itemGroups), [itemGroups, toolset.gridLayout]);
  // The main window owns live command metadata/availability and publishes snapshots to detached
  // palettes. The state initializer above is only a first-paint fallback before that handshake.
  const allCommands = commandSpecs;
  // Same rule as the main window's in-place gallery: transitional stubs are not draggable onto
  // toolbars. The declared stub set is used rather than the snapshot's enabled state.
  const galleryCommands = useMemo(() => {
    // The shipped manifest, not `toolsetRegistry` — see the matching note in MainWindow. Keyed off
    // the user's customized layout, removing a tool would delete it from the list they would add it
    // back with.
    const shipped = new Set(getToolsetCommandSpecs(desktopToolsetRegistry).map((command) => command.id));
    return allCommands.filter((command) =>
      !TRANSITIONAL_STUB_COMMAND_IDS.has(command.id) &&
      !isCompatOnlyArtVariantCommandId(command.id, shipped)
    );
  }, [allCommands]);
  const shortcutRegistry = useMemo(
    () => createDesktopShortcutRegistry(allCommands, { includeDisabled: true }),
    [allCommands]
  );
  // Every append-mode section widget the gallery can offer (Style Controls, Text Style) — present ones
  // gray out, removed ones (e.g. Style Controls after a drag-out) show as restorable tiles.
  const galleryWidgets = APPENDABLE_TOOLBAR_WIDGETS;

  // In-place customize mode (Main palette only). MainWindow broadcasts the flag; we mirror it and
  // suppress the drag-fighting feeds (pointer-feed hover synthesis, tooltips, popover-dismiss, shell
  // window-drag) while it's on. The ref lets the always-subscribed feed effects read it live.
  const [customizeActive, setCustomizeActive] = useState(false);
  const customizeThisPalette = customizeActive && toolset.id === DEFAULT_TOOLSET_ID;
  const customizeThisPaletteRef = useRef(false);
  customizeThisPaletteRef.current = customizeThisPalette;

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
          const nextRegistry = createPaletteRegistryFromLayoutState(
            layoutState,
            commandSpecsRef.current,
            pluginToolsetsRef.current
          );
          latestLayoutStateRef.current = layoutState;
          setToolsetRegistry(nextRegistry);
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
        const nextRegistry = createPaletteRegistryFromLayoutState(
          layoutState,
          commandSpecsRef.current,
          pluginToolsetsRef.current
        );
        latestLayoutStateRef.current = layoutState;
        setToolsetRegistry(nextRegistry);
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

  // Resolve every persisted command id against the main window's live CommandSpec. This preserves
  // current titles/icons/shortcuts and, importantly, changing enabled state such as Undo/Redo.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetCommandSpecs((commands) => {
      if (active) {
        const signature = toolsetCommandSpecsSignature(commands);
        if (signature === commandSpecsSignatureRef.current) {
          return;
        }
        commandSpecsSignatureRef.current = signature;
        commandSpecsRef.current = commands;
        setCommandSpecs(commands);
        if (latestLayoutStateRef.current !== undefined) {
          try {
            setToolsetRegistry(
              createPaletteRegistryFromLayoutState(latestLayoutStateRef.current, commands, pluginToolsetsRef.current)
            );
          } catch {
            // Retain the last good registry if a future schema/version makes rehydration fail.
          }
        }
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        void requestToolsetCommandSpecs().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Learn plugin toolset DEFINITIONS from the main window — this webview ships only the core manifest,
  // so without them a window opened for a plugin toolset can never resolve it (and would render the
  // placeholder forever). Fold the latest definitions into the registry, and request the current set
  // once subscribed since they may have been published before this window finished mounting. Rebuild
  // unconditionally (unlike the command-spec path): a plugin window with no layout customization still
  // needs its definition to render. In production the registry derives purely from the layout/command/
  // plugin refs, so folding them in is complete; the test-only `initialRegistry` seam never broadcasts
  // definitions, so it can't be clobbered here.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenForToolsetDefinitions((toolsets) => {
      if (!active) {
        return;
      }
      pluginToolsetsRef.current = toolsets as DesktopToolsetDefinition[];
      try {
        setToolsetRegistry(
          createPaletteRegistryFromLayoutState(
            latestLayoutStateRef.current,
            commandSpecsRef.current,
            pluginToolsetsRef.current
          )
        );
      } catch {
        // Keep the last good registry if a malformed definition slips past the shape check.
      }
    })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        void requestToolsetDefinitions().catch(() => undefined);
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
      // Version skew degrades to the pre-variant behavior: an unknown kind reads as no selection
      // model at all rather than freezing the palette on a rejected payload.
      setCurrentSelection(
        payload.currentSelection && TOOLBAR_SELECTION_KINDS.includes(payload.currentSelection.kind)
          ? payload.currentSelection
          : undefined
      );
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
  // the last content so the window can re-request it after it mounts (the create-vs-emit race);
  // `undefined` until the first real open, so a prewarmed popover's mount request — which fires with
  // no open in flight — gets no answer and the hidden window stays hidden.
  const lastPopoverContentRef = useRef<ToolsetPopoverContent | undefined>(undefined);

  const openPopover = (anchor: ToolbarPopoverAnchor, kind: string, content: ToolsetPopoverContent) => {
    lastPopoverContentRef.current = content;
    void (async () => {
      const windowPosition = await currentWindowLogicalPosition().catch(() => undefined);
      const screenX = (windowPosition?.x ?? 0) + anchor.left;
      const screenY = (windowPosition?.y ?? 0) + anchor.bottom + 4;
      await openToolsetPopoverWindow(toolset.id, kind, screenX, screenY);
      await setToolsetPopoverContent(toolset.id, content);
    })().catch(() => undefined);
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

  // Build this palette's popover window hidden, ahead of the first flyout/color press. The cold
  // build (a fresh webview loading the app bundle) is the slow part of a popover open — leaving it
  // to the first press made that press look unresponsive for a second or more. Deferred briefly so
  // palette startup itself stays snappy; by the first hold the window is warm and opens in a frame
  // or two.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void prewarmToolsetPopoverWindow(toolset.id).catch(() => undefined);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [toolset.id]);

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
      // No open has happened yet (a prewarmed popover requesting on mount): stay silent — an answer
      // would masquerade as an open and reveal a popover nobody asked for.
      const lastContent = lastPopoverContentRef.current;
      if (!lastContent) {
        return;
      }
      void setToolsetPopoverContent(toolset.id, lastContent).catch(() => undefined);
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

  // Render the palette from a given set of groups — the controller passes an optimistic overlay while
  // a drop is settling, otherwise this is the authoritative `paletteGroups`.
  const renderPalette = (renderGroups: readonly ToolbarPaletteGroupModel[]) => {
    const renderItemGroups = renderGroups.map((group) => group.items);
    return (
      <ToolPalette
        groups={paletteCommandGroupsFromItemGroups(renderItemGroups)}
        itemGroups={renderItemGroups}
        gridLayout={toolset.gridLayout}
        activeTool={activeTool}
        mode="floating"
        orientation={toolset.gridLayout?.orientation ?? "vertical"}
        title={toolset.title}
        onRequestFlyout={openFlyoutPopover}
        onInvoke={invokeCommand}
        customize={customizeThisPalette ? { groupIds: renderGroups.map((group) => group.id) } : undefined}
        widgetState={{
          currentObjectColor: currentTextStyle.color,
          currentArtStyle,
          currentArtStyleTarget,
          currentMoleculeInspector,
          currentSelection,
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
  };

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
          onEdit={(edit) => sendToolsetLayoutEdit({ toolsetId: toolset.id, edit })}
        >
          {(effectiveGroups) => (
            <>
              {renderPalette(effectiveGroups)}
              <CustomizeBar
                onDone={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "exitCustomize" } }).catch(() => undefined)}
                onRestoreDefaults={() => void sendToolsetLayoutEdit({ toolsetId: toolset.id, edit: { kind: "resetToolset" } }).catch(() => undefined)}
              />
              <GalleryTray
                commands={galleryCommands}
                widgets={galleryWidgets}
                presentItemIds={new Set(effectiveGroups.flatMap((group) => group.items.map((item) => item.id)))}
              />
            </>
          )}
        </ToolbarCustomizeController>
      ) : (
        renderPalette(paletteGroups)
      )}
    </main>
  );
}
