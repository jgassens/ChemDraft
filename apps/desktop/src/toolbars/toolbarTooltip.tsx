import {
  cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type HTMLAttributes, type ReactElement, type RefAttributes
} from "react";

/**
 * The palette tooltip machinery, shared by the grid icons (ToolbarPaletteItem) and the style
 * widget's cells: a single-visible-tooltip state hook with the standard delay, plus the relay that
 * announces a shell's tooltip to the hosting native palette window. Lives below ToolPalette (which
 * imports it back) so widget modules can use it without importing the palette renderer.
 */

export const TOOLTIP_DELAY_MS = 500;
export const TOOLTIP_RESHOW_WINDOW_MS = 300;

export type ClearTooltipOptions = { onlyMatchingPending?: boolean };

export function usePaletteTooltipState() {
  const [visibleTooltipId, setVisibleTooltipId] = useState<string | undefined>();
  const visibleTooltipIdRef = useRef<string | undefined>(undefined);
  const pendingTooltipRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTooltipIdRef = useRef<string | undefined>(undefined);
  const warmRef = useRef(false);
  const coolTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearPendingTooltip = useCallback(() => {
    if (pendingTooltipRef.current !== undefined) {
      clearTimeout(pendingTooltipRef.current);
      pendingTooltipRef.current = undefined;
    }
    pendingTooltipIdRef.current = undefined;
  }, []);

  const requestTooltip = useCallback((tooltipId: string) => {
    if (visibleTooltipIdRef.current === tooltipId || pendingTooltipIdRef.current === tooltipId) {
      return;
    }

    clearPendingTooltip();
    clearTimeout(coolTimerRef.current);
    if (warmRef.current) {
      visibleTooltipIdRef.current = tooltipId;
      setVisibleTooltipId(tooltipId);
      return;
    }
    visibleTooltipIdRef.current = undefined;
    setVisibleTooltipId(undefined);
    pendingTooltipIdRef.current = tooltipId;
    pendingTooltipRef.current = setTimeout(() => {
      pendingTooltipRef.current = undefined;
      pendingTooltipIdRef.current = undefined;
      warmRef.current = true;
      visibleTooltipIdRef.current = tooltipId;
      setVisibleTooltipId(tooltipId);
    }, TOOLTIP_DELAY_MS);
  }, [clearPendingTooltip]);

  const clearTooltip = useCallback((tooltipId?: string, options?: ClearTooltipOptions) => {
    // Pointer transitions can arrive from a stale owner after another tooltip was queued.
    // Explicit dismissals must cancel the timer regardless of its owner.
    if (!options?.onlyMatchingPending || tooltipId === undefined || pendingTooltipIdRef.current === tooltipId) {
      clearPendingTooltip();
    }
    if (!tooltipId || !options?.onlyMatchingPending) {
      clearTimeout(coolTimerRef.current);
      warmRef.current = false;
    }
    // Refs change synchronously so an old owner's leave cannot hide its neighbour before
    // React commits the handoff, even when both events arrive in the same pointer-feed tick.
    if (tooltipId && visibleTooltipIdRef.current !== tooltipId) return;
    visibleTooltipIdRef.current = undefined;
    setVisibleTooltipId(undefined);
    clearTimeout(coolTimerRef.current);
    if (tooltipId && options?.onlyMatchingPending) {
      // A's leave hides immediately. Keep a short warm interval across the gaps between cells,
      // so the neighbour can show promptly even when its enter is in the next pointer-feed tick.
      coolTimerRef.current = setTimeout(() => { warmRef.current = false; }, TOOLTIP_RESHOW_WINDOW_MS);
    }
  }, [clearPendingTooltip]);

  useEffect(() => {
    if (!visibleTooltipId) {
      return undefined;
    }

    const clearWhenPointerLeavesOwner = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      const targetElement = target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : undefined;
      const ownerElement = targetElement?.closest<HTMLElement>("[data-tooltip-owner-id]");

      if (ownerElement?.dataset.tooltipOwnerId !== visibleTooltipId) {
        clearTooltip(visibleTooltipId, { onlyMatchingPending: true });
      }
    };

    const clearVisibleTooltip = () => {
      clearTooltip(visibleTooltipId, { onlyMatchingPending: true });
    };

    document.addEventListener("mousemove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("pointermove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("mouseleave", clearVisibleTooltip, true);

    return () => {
      document.removeEventListener("mousemove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("pointermove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("mouseleave", clearVisibleTooltip, true);
    };
  }, [visibleTooltipId, clearTooltip]);

  useEffect(() => {
    const dismissTooltip = () => {
      clearTooltip();
    };

    window.addEventListener("blur", dismissTooltip);
    document.addEventListener("pointerdown", dismissTooltip, true);
    document.addEventListener("scroll", dismissTooltip, true);
    return () => {
      window.removeEventListener("blur", dismissTooltip);
      document.removeEventListener("pointerdown", dismissTooltip, true);
      document.removeEventListener("scroll", dismissTooltip, true);
    };
  }, [clearTooltip]);

  useEffect(() => () => {
    clearPendingTooltip();
    clearTimeout(coolTimerRef.current);
  }, [clearPendingTooltip]);

  return {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  };
}

const inactiveTooltipState: ReturnType<typeof usePaletteTooltipState> = {
  visibleTooltipId: undefined,
  requestTooltip: () => undefined,
  clearTooltip: () => undefined
};
export const PaletteControlTooltipContext = createContext<ReturnType<typeof usePaletteTooltipState> | undefined>(undefined);

/** Add the same tooltip contract to an existing label/button without changing its layout. */
export function PaletteControlTooltip({ tooltip, children }: {
  tooltip: string;
  children: ReactElement<HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement>>;
}) {
  const id = useId();
  const { visibleTooltipId, requestTooltip, clearTooltip } = useContext(PaletteControlTooltipContext) ?? inactiveTooltipState;
  const shellRef = useRef<HTMLElement | null>(null);
  const visible = visibleTooltipId === id;
  useNativeFloatingTooltip(shellRef, visible, tooltip);
  const props = children.props;
  return cloneElement(children, {
    ref: shellRef,
    className: `${props.className ?? ""} toolbar-control-tooltip`,
    ...{ "data-tooltip-owner-id": id, "data-tooltip-visible": visible ? "true" : undefined },
    onPointerEnter: event => { props.onPointerEnter?.(event); requestTooltip(id); },
    onPointerLeave: event => { props.onPointerLeave?.(event); clearTooltip(id, { onlyMatchingPending: true }); },
    onPointerDownCapture: event => { props.onPointerDownCapture?.(event); clearTooltip(id); },
    onClickCapture: event => { props.onClickCapture?.(event); clearTooltip(id); }
  }, props.children, <span className="tool-tooltip" role="tooltip" aria-hidden="true"><span>{tooltip}</span></span>);
}

/** Tooltip visibility announcement from a shell to its hosting window. In the native palette
 *  windows the in-DOM tooltip span is hidden (a content-fit window clips anything outside it), and
 *  PaletteWindow relays these events into the shared floating tooltip window instead. A DOM event
 *  keeps the components runtime-agnostic — no desktop imports here. */
export const PALETTE_TOOLTIP_DOM_EVENT = "chemdraft:palette-tooltip";

export interface PaletteTooltipDomDetail {
  visible: boolean;
  ownerId?: string;
  title?: string;
  description?: string;
  shortcut?: string;
  anchor?: { left: number; top: number; right: number; bottom: number };
}

/** Pull the structured tooltip parts back out of the (hidden) in-DOM span. The span holds the
 *  title as plain text/an unclassed span plus optional description/shortcut sub-spans AND a
 *  visually-hidden flat copy for screen readers — flattening the whole thing with textContent
 *  would concatenate all of them into garbage. */
export function extractTooltipParts(tooltip: Element): { title: string; description?: string; shortcut?: string } {
  const description = tooltip.querySelector(".tool-tooltip-description")?.textContent ?? undefined;
  const shortcut = tooltip.querySelector(".tool-tooltip-shortcut")?.textContent ?? undefined;
  let title = "";
  for (const node of Array.from(tooltip.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      title += node.textContent ?? "";
    } else if (node instanceof Element && node.tagName === "SPAN" && node.classList.length === 0) {
      title += node.textContent ?? "";
    }
  }
  return { title: title.trim(), description: description || undefined, shortcut: shortcut || undefined };
}

/**
 * Announce this shell's tooltip to the hosting native palette window. The default in-DOM span is
 * unusable there: the content-fit palette window clips anything positioned outside it (a webview
 * cannot paint past its window), so the span is display:none in palette windows (App.css) and the
 * visible tooltip is the shared floating tooltip window, which can overflow the palette freely —
 * the same reason popovers/flyouts live in their own windows. Browser and in-window palettes keep
 * the pure-CSS span; this hook is a no-op for them.
 */
export function useNativeFloatingTooltip(shellRef: { current: HTMLElement | null }, visible: boolean, contentKey?: string) {
  const ownerId = useId();
  useEffect(() => {
    if (!document.body.classList.contains("palette-window-body")) {
      return;
    }
    const shell = shellRef.current;
    if (!visible || !shell) {
      return;
    }
    const tooltip = shell.querySelector(".tool-tooltip");
    if (!tooltip) {
      return;
    }
    const { title, description, shortcut } = extractTooltipParts(tooltip);
    if (!title && !description) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent<PaletteTooltipDomDetail>(PALETTE_TOOLTIP_DOM_EVENT, {
        detail: {
          visible: true,
          ownerId,
          title,
          description,
          shortcut,
          anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        }
      })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent<PaletteTooltipDomDetail>(PALETTE_TOOLTIP_DOM_EVENT, { detail: { visible: false, ownerId } })
      );
    };
  }, [shellRef, visible, ownerId, contentKey]);
}
