import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { PluginPanelWindow } from "./plugins/PluginPanelWindow";
import { Spin3dDebuggerWindow } from "./Spin3dDebuggerWindow";
import { PreferencesWindow } from "./PreferencesWindow";
import { SPIN3D_DEBUGGER_WINDOW_KIND } from "./conformerDebug";
import { PREFERENCES_WINDOW_KIND } from "./window-manager";

export function App() {
  if (isSpin3dDebuggerRoute()) {
    return <Spin3dDebuggerWindow />;
  }

  if (isPreferencesRoute()) {
    return <PreferencesWindow />;
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
