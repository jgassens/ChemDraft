import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The palette tooltip machinery, shared by the grid icons (ToolbarPaletteItem) and the style
 * widget's cells: a single-visible-tooltip state hook with the standard delay, plus the relay that
 * announces a shell's tooltip to the hosting native palette window. Lives below ToolPalette (which
 * imports it back) so widget modules can use it without importing the palette renderer.
 */

export const TOOLTIP_DELAY_MS = 500;

export function usePaletteTooltipState() {
  const [visibleTooltipId, setVisibleTooltipId] = useState<string | undefined>();
  const visibleTooltipIdRef = useRef<string | undefined>(undefined);
  const pendingTooltipRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTooltipIdRef = useRef<string | undefined>(undefined);
  visibleTooltipIdRef.current = visibleTooltipId;

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
    setVisibleTooltipId(undefined);
    pendingTooltipIdRef.current = tooltipId;
    pendingTooltipRef.current = setTimeout(() => {
      pendingTooltipRef.current = undefined;
      pendingTooltipIdRef.current = undefined;
      setVisibleTooltipId(tooltipId);
    }, TOOLTIP_DELAY_MS);
  }, [clearPendingTooltip]);

  const clearTooltip = useCallback((tooltipId?: string) => {
    clearPendingTooltip();
    setVisibleTooltipId((current) => (
      tooltipId && current !== tooltipId ? current : undefined
    ));
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
        clearTooltip(visibleTooltipId);
      }
    };

    const clearVisibleTooltip = () => {
      clearTooltip(visibleTooltipId);
    };

    document.addEventListener("mousemove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("pointermove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("mouseleave", clearVisibleTooltip, true);
    document.addEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
    window.addEventListener("blur", clearVisibleTooltip);

    return () => {
      document.removeEventListener("mousemove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("pointermove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("mouseleave", clearVisibleTooltip, true);
      document.removeEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
      window.removeEventListener("blur", clearVisibleTooltip);
    };
  }, [visibleTooltipId, clearTooltip]);

  useEffect(() => {
    const clearPendingOnBlur = () => {
      clearTooltip();
    };

    window.addEventListener("blur", clearPendingOnBlur);
    return () => {
      window.removeEventListener("blur", clearPendingOnBlur);
    };
  }, [clearTooltip]);

  useEffect(() => () => {
    clearPendingTooltip();
  }, [clearPendingTooltip]);

  return {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  };
}

/** Tooltip visibility announcement from a shell to its hosting window. In the native palette
 *  windows the in-DOM tooltip span is hidden (a content-fit window clips anything outside it), and
 *  PaletteWindow relays these events into the shared floating tooltip window instead. A DOM event
 *  keeps the components runtime-agnostic — no desktop imports here. */
export const PALETTE_TOOLTIP_DOM_EVENT = "chemdraft:palette-tooltip";

export interface PaletteTooltipDomDetail {
  visible: boolean;
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
export function useNativeFloatingTooltip(shellRef: { current: HTMLElement | null }, visible: boolean) {
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
          title,
          description,
          shortcut,
          anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        }
      })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent<PaletteTooltipDomDetail>(PALETTE_TOOLTIP_DOM_EVENT, { detail: { visible: false } })
      );
    };
  }, [shellRef, visible]);
}
