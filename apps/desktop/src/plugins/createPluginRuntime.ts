import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";

import { PluginPanelController } from "./PluginPanelController";

export interface DesktopPluginRuntimeOptions {
  /** Reads the current active document. Called on demand; must reflect the latest state. */
  getActiveDocument: () => ChemDraftDocument | undefined;
  /** Builds an immutable selection snapshot from current desktop state. */
  getSelection: () => PluginSelectionSnapshot;
  /** Injectable clock (tests pass a fixed value); defaults to wall-clock. */
  now?: () => Date | string;
}

/**
 * The persistent desktop plugin runtime: one {@link PluginHost} plus the panel controller that
 * renders its reports. Create it once (see `usePluginRuntime`) and feed current document/selection
 * through the provider callbacks — never rebuild it when the document, selection, page, viewport, or
 * undo history changes.
 */
export interface DesktopPluginRuntime {
  host: PluginHost;
  panels: PluginPanelController;
}

export function createPluginRuntime(options: DesktopPluginRuntimeOptions): DesktopPluginRuntime {
  const now = options.now ?? (() => new Date());
  const nowIso = (): string => {
    const value = now();
    return typeof value === "string" ? value : value.toISOString();
  };

  // The host and controller reference each other: the host forwards validated reports to the
  // controller, and the controller reads manifests back off the host. Close the loop with a
  // late-bound reference so neither construction depends on the other existing first.
  let controller: PluginPanelController | undefined;
  const host = new PluginHost({
    getActiveDocument: options.getActiveDocument,
    getSelection: options.getSelection,
    showPanelReport: (pluginId, panelId, report) => {
      controller?.showReport(pluginId, panelId, report);
    },
    now
  });
  controller = new PluginPanelController(host, nowIso);

  return { host, panels: controller };
}
