import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { PaletteTooltipWindow } from "./PaletteTooltipWindow";
import { PluginPanelWindow } from "./plugins/PluginPanelWindow";
import { Spin3dDebuggerWindow } from "./Spin3dDebuggerWindow";
import { PreferencesWindow } from "./PreferencesWindow";
import { SPIN3D_DEBUGGER_WINDOW_KIND } from "./conformerDebug";
import {
  PREFERENCES_WINDOW_KIND,
  TOOLSET_POPOVER_WINDOW_KIND,
  TOOLSET_TOOLTIP_WINDOW_KIND
} from "./window-manager";

export function App() {
  if (isSpin3dDebuggerRoute()) {
    return <Spin3dDebuggerWindow />;
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

  return <MainWindow />;
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
  return params.get("window") === SPIN3D_DEBUGGER_WINDOW_KIND;
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
