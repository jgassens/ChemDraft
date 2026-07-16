import type { PluginManifest } from "@chemdraft/plugin-api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { PluginDiagnosticsPanel } from "./PluginDiagnosticsPanel";
import { PluginReportRenderer } from "./PluginReportRenderer";
import type { OpenPluginPanel, PluginDiagnostic } from "./types";

export interface PluginPanelSurfaceProps {
  openPanel: OpenPluginPanel | undefined;
  diagnosticsOpen: boolean;
  plugins: readonly PluginManifest[];
  diagnostics: readonly PluginDiagnostic[];
  /** True when the open panel's report.source no longer matches the live document (D-09). */
  stale?: boolean;
  onClose: () => void;
  onCloseDiagnostics: () => void;
  onRunAgain: (commandId: string) => void;
  /** Pop the open panel out into a floating native window (ADR-0030). Desktop only: absent (and the
   *  control hidden) on the browser build, which keeps the in-app surface. */
  onOpenAsWindow?: () => void;
}

interface PanelOffset {
  x: number;
  y: number;
}

interface PanelBaseGeometry {
  left: number;
  top: number;
  width: number;
  headerHeight: number;
}

const fallbackPanelHeaderHeight = 40;

function readPanelBaseGeometry(
  panel: HTMLElement | null,
  header: HTMLElement | null,
  offset: PanelOffset
): PanelBaseGeometry | undefined {
  const rect = panel?.getBoundingClientRect();
  if (!rect || rect.width <= 0) {
    // jsdom and genuinely unlaid-out elements have no useful bounds. Preserve the free-drag
    // behavior in that case instead of clamping everything to the origin.
    return undefined;
  }
  const measuredHeaderHeight = header?.getBoundingClientRect().height ?? 0;
  return {
    left: rect.left - offset.x,
    top: rect.top - offset.y,
    width: rect.width,
    headerHeight: measuredHeaderHeight > 0 ? measuredHeaderHeight : fallbackPanelHeaderHeight
  };
}

function clampPanelOffset(
  offset: PanelOffset,
  geometry: PanelBaseGeometry,
  viewportWidth: number,
  viewportHeight: number
): PanelOffset {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return offset;
  }

  // Keep the complete panel width on-screen. The panel's CSS max-width ensures this range is
  // normally feasible; if a transient layout is wider than the viewport, align its right edge so
  // the header's Close control remains reachable.
  const minX = -geometry.left;
  const maxX = viewportWidth - geometry.left - geometry.width;
  const x = minX <= maxX ? Math.min(Math.max(offset.x, minX), maxX) : maxX;

  // The report body may extend below a short viewport, but the complete header must remain visible
  // so the panel can always be dragged or closed again.
  const visibleHeaderHeight = Math.min(geometry.headerHeight, viewportHeight);
  const minY = -geometry.top;
  const maxY = viewportHeight - geometry.top - visibleHeaderHeight;
  const y = Math.min(Math.max(offset.y, minY), maxY);

  return { x, y };
}

function offsetsEqual(left: PanelOffset, right: PanelOffset): boolean {
  return left.x === right.x && left.y === right.y;
}

/**
 * Desktop chrome around contributed panels: title, close, and a "Run again" action (the panel
 * contribution's command) around a plugin's declarative report, plus the toggleable bundled-plugin
 * diagnostics view. Renders nothing when neither a panel nor diagnostics is open, so it stays inert
 * until the plugin runtime is actually used.
 */
export function PluginPanelSurface(props: PluginPanelSurfaceProps) {
  const { openPanel, diagnosticsOpen } = props;
  const [expanded, setExpanded] = useState(false);
  if (!openPanel && !diagnosticsOpen) {
    return null;
  }

  // Only interactive figures benefit from the large view; a text/table report stays compact.
  const canExpand = openPanel?.report.sections.some((section) => section.kind === "linkedFigure") ?? false;
  const className = ["plugin-surface", expanded && canExpand ? "plugin-surface--expanded" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} data-testid="plugin-surface">
      {openPanel ? (
        <OpenPanelView
          panel={openPanel}
          stale={props.stale ?? false}
          canExpand={canExpand}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
          onClose={props.onClose}
          onRunAgain={props.onRunAgain}
          onOpenAsWindow={props.onOpenAsWindow}
        />
      ) : null}
      {diagnosticsOpen ? (
        <section className="plugin-diagnostics-surface" data-testid="plugin-diagnostics-surface">
          <button
            type="button"
            className="plugin-panel-close"
            aria-label="Close bundled plugins"
            onClick={props.onCloseDiagnostics}
          >
            Close
          </button>
          <PluginDiagnosticsPanel plugins={props.plugins} diagnostics={props.diagnostics} />
        </section>
      ) : null}
    </div>
  );
}

function OpenPanelView({
  panel,
  stale,
  canExpand,
  expanded,
  onToggleExpand,
  onClose,
  onRunAgain,
  onOpenAsWindow
}: {
  panel: OpenPluginPanel;
  stale: boolean;
  canExpand: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onRunAgain: (commandId: string) => void;
  onOpenAsWindow?: () => void;
}) {
  const runCommandId = panel.commandId;
  const panelRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [offset, setOffset] = useState<PanelOffset>({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  const activeDragCleanupRef = useRef<(() => void) | undefined>(undefined);
  offsetRef.current = offset;

  useEffect(() => {
    const onResize = (): void => {
      // A resize changes the panel's CSS max-width and its usable drag range. End any drag that was
      // measured against the old viewport, then re-clamp the committed offset to the new bounds.
      activeDragCleanupRef.current?.();
      const current = offsetRef.current;
      const geometry = readPanelBaseGeometry(panelRef.current, headerRef.current, current);
      if (!geometry) {
        return;
      }
      const next = clampPanelOffset(current, geometry, window.innerWidth, window.innerHeight);
      if (!offsetsEqual(current, next)) {
        offsetRef.current = next;
        setOffset(next);
      }
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    // Expanding changes the right-docked surface from 430px to as much as 1080px. Re-clamp before
    // paint so a panel previously dragged to the compact view's left edge cannot grow mostly
    // off-screen. A replacement panel may also have different report geometry.
    activeDragCleanupRef.current?.();
    const current = offsetRef.current;
    const geometry = readPanelBaseGeometry(panelRef.current, headerRef.current, current);
    if (!geometry) return;
    const next = clampPanelOffset(current, geometry, window.innerWidth, window.innerHeight);
    if (!offsetsEqual(current, next)) {
      offsetRef.current = next;
      setOffset(next);
    }
  }, [canExpand, expanded, panel.pluginId, panel.panelId]);

  // Drag the whole panel by its header. Window-level listeners (added on pointer-down, removed on
  // up/cancel) keep the drag alive even when the pointer leaves the header; a button press never
  // starts a drag. Clamped so the panel header and Close control stay accessible (skipped when there
  // is no layout, e.g. jsdom).
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    activeDragCleanupRef.current?.();
    const initialOffset = offsetRef.current;
    const start = { x: event.clientX, y: event.clientY, ox: initialOffset.x, oy: initialOffset.y };
    // Capture the untransformed geometry once. React may not commit one pointermove's state update
    // before the next pointermove arrives; re-deriving the base from a stale DOM transform and the
    // newer offset ref would make the clamp itself drift during fast drags.
    const geometry = readPanelBaseGeometry(panelRef.current, headerRef.current, initialOffset);
    const onMove = (move: PointerEvent): void => {
      let next: PanelOffset = {
        x: start.ox + (move.clientX - start.x),
        y: start.oy + (move.clientY - start.y)
      };
      if (geometry) {
        next = clampPanelOffset(next, geometry, window.innerWidth, window.innerHeight);
      }
      offsetRef.current = next;
      setOffset(next);
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (activeDragCleanupRef.current === cleanup) {
        activeDragCleanupRef.current = undefined;
      }
    };
    const onEnd = (): void => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    activeDragCleanupRef.current = cleanup;
  };

  return (
    <section
      ref={panelRef}
      className={["plugin-panel", stale ? "is-stale" : ""].filter(Boolean).join(" ")}
      data-testid="plugin-panel"
      data-panel-id={panel.panelId}
      data-stale={stale ? "true" : undefined}
      style={offset.x !== 0 || offset.y !== 0 ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <header
        ref={headerRef}
        className="plugin-panel-header"
        onPointerDown={onHeaderPointerDown}
        title="Drag to move"
      >
        <h3 className="plugin-panel-title">{panel.report.title || panel.title}</h3>
        <div className="plugin-panel-actions">
          {canExpand ? (
            <button
              type="button"
              className="plugin-panel-expand"
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
          {runCommandId ? (
            <button type="button" className="plugin-panel-run-again" onClick={() => onRunAgain(runCommandId)}>
              Run again
            </button>
          ) : null}
          {onOpenAsWindow ? (
            <button
              type="button"
              className="plugin-panel-open-window"
              aria-label="Open panel as window"
              onClick={onOpenAsWindow}
            >
              Open as window
            </button>
          ) : null}
          <button type="button" className="plugin-panel-close" aria-label="Close panel" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {stale ? (
        <div className="plugin-panel-stale" role="status" data-testid="plugin-panel-stale">
          This result may be out of date — the structure changed since it was computed. Run again to refresh.
        </div>
      ) : null}
      <PluginReportRenderer report={panel.report} />
    </section>
  );
}
