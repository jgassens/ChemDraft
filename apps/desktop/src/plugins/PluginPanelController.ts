import type { PluginPanelReport } from "@chemdraft/plugin-api";
import type { PluginHost } from "@chemdraft/plugin-host";

import type { OpenPluginPanel, PluginDiagnostic } from "./types";

/**
 * Holds the desktop's live panel state and receives declarative reports from the persistent host.
 *
 * The host validates a report's schema and that the plugin declared the panel before calling
 * {@link showReport}; this controller additionally resolves the panel's manifest metadata (title,
 * command) for chrome and degrades to a recorded diagnostic — never a throw — when a report arrives
 * for a panel the host does not know about, so an unexpected id can't crash the desktop.
 */
export class PluginPanelController {
  private open: OpenPluginPanel | undefined;
  private diagnostics: readonly PluginDiagnostic[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host: PluginHost,
    private readonly nowIso: () => string
  ) {}

  /** Entry point wired to `PluginHostOptions.showPanelReport`. Also safe to call from desktop code. */
  showReport(pluginId: string, panelId: string, report: PluginPanelReport): void {
    const plugin = this.host.getPlugin(pluginId);
    const panel = plugin?.manifest.contributes.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      this.recordDiagnostic(
        "panel-unknown",
        `Ignored a report for unknown panel "${panelId}" from plugin "${pluginId}".`
      );
      return;
    }

    this.open = {
      pluginId,
      panelId,
      title: panel.title,
      report,
      commandId: panel.commandId,
      openedAt: this.nowIso()
    };
    this.notify();
  }

  getOpenPanel(): OpenPluginPanel | undefined {
    return this.open;
  }

  closePanel(): void {
    if (this.open) {
      this.open = undefined;
      this.notify();
    }
  }

  getDiagnostics(): readonly PluginDiagnostic[] {
    return this.diagnostics;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private recordDiagnostic(code: string, message: string): void {
    this.diagnostics = [...this.diagnostics, { code, message, at: this.nowIso() }];
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
