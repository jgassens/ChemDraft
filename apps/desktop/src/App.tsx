import { lazy, Suspense, useEffect, type ReactElement } from "react";
import {
  PREFERENCES_WINDOW_KIND,
  routeToolsetCommand,
  TOOLSET_POPOVER_WINDOW_KIND,
  TOOLSET_TOOLTIP_WINDOW_KIND
} from "./window-manager";
import { installSecondaryWindowEditHistory } from "./editHistoryRouting";

const MainWindow = lazy(() => import("./MainWindow").then(m => ({ default: m.MainWindow })));
const PaletteWindow = lazy(() => import("./PaletteWindow").then(m => ({ default: m.PaletteWindow })));
const PalettePopoverWindow = lazy(() => import("./PalettePopoverWindow").then(m => ({ default: m.PalettePopoverWindow })));
const PaletteTooltipWindow = lazy(() => import("./PaletteTooltipWindow").then(m => ({ default: m.PaletteTooltipWindow })));
const PluginPanelWindow = lazy(() => import("./plugins/PluginPanelWindow").then(m => ({ default: m.PluginPanelWindow })));
const Spin3dDebuggerWindow = lazy(() => import("./Spin3dDebuggerWindow").then(m => ({ default: m.Spin3dDebuggerWindow })));
const PreferencesWindow = lazy(() => import("./PreferencesWindow").then(m => ({ default: m.PreferencesWindow })));
const DialogWindow = lazy(() => import("./dialogs/DialogWindow").then(m => ({ default: m.DialogWindow })));

export function App() {
  const dialog = dialogRoute();
  if (dialog !== undefined) {
    return <Suspense fallback={<p role="status">Opening dialog…</p>}>
      <SecondaryWindowEditHistory dialog />
      <DialogWindow hostId={dialog} />
    </Suspense>;
  }
  const secondaryWindow = secondaryWindowContent();
  if (secondaryWindow) {
    return (
      <Suspense fallback={null}>
        <SecondaryWindowEditHistory />
        {secondaryWindow}
      </Suspense>
    );
  }

  return <Suspense fallback={null}><MainWindow /></Suspense>;
}

/**
 * Edit ▸ Undo / Redo reach whichever window is key. Here that is a secondary window: undo its own
 * focused text field, or hand the command to the main window's document history.
 */
function SecondaryWindowEditHistory({ dialog = false }: { dialog?: boolean }): null {
  useEffect(() => installSecondaryWindowEditHistory({ forwardToMain: dialog ? () => {} : routeToolsetCommand }), [dialog]);
  return null;
}

export function dialogRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  return params.get("window") === "dialog" ? params.get("hostId") ?? "" : undefined;
}

function secondaryWindowContent(): ReactElement | undefined {
  if (isSpin3dDebuggerRoute()) {
    return <Suspense fallback={<p role="status">Opening 3D Debugger…</p>}><Spin3dDebuggerWindow /></Suspense>;
  }

  if (isPreferencesRoute()) {
    return <PreferencesWindow />;
  }

  const popoverRoute = toolsetPopoverRoute();
  if (popoverRoute) {
    return (
      <PalettePopoverWindow
        toolsetId={popoverRoute.toolsetId}
        kind={popoverRoute.kind}
        prewarm={popoverRoute.prewarm}
      />
    );
  }

  if (isToolsetTooltipRoute()) {
    return <PaletteTooltipWindow />;
  }

  const toolsetId = toolsetRouteId();
  if (toolsetId) {
    return <PaletteWindow toolsetId={toolsetId} />;
  }

  const pluginPanelId = pluginPanelRouteId();
  if (pluginPanelId) {
    return <PluginPanelWindow panelId={pluginPanelId} />;
  }

  return undefined;
}

function pluginPanelRouteId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("window") !== "pluginPanel") {
    return undefined;
  }

  return params.get("panelId") ?? undefined;
}

export function isSpin3dDebuggerRoute(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("window") === "spin3d-debugger";
}

export function isPreferencesRoute(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("window") === PREFERENCES_WINDOW_KIND;
}

function isToolsetTooltipRoute(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("window") === TOOLSET_TOOLTIP_WINDOW_KIND;
}

function toolsetPopoverRoute(): { toolsetId: string; kind: string; prewarm: boolean } | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("window") !== TOOLSET_POPOVER_WINDOW_KIND) {
    return undefined;
  }

  return {
    toolsetId: params.get("toolsetId") ?? "core.art",
    kind: params.get("kind") ?? "artColor",
    // Prewarmed popovers are built hidden before any press needs them; they must stay hidden until
    // the palette pushes real content (see PalettePopoverWindow).
    prewarm: params.get("prewarm") === "1"
  };
}

function toolsetRouteId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const params = new URLSearchParams(window.location.search);
  const windowKind = params.get("window");
  if (windowKind === "toolset") {
    return params.get("toolsetId") ?? "core.main";
  }

  if (windowKind === "tool-palette") {
    return "core.main";
  }

  return undefined;
}
