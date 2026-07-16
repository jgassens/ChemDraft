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

    const previous = this.open;
    const updatesOpenPanel = previous?.pluginId === pluginId && previous.panelId === panelId;
    if (previous && !updatesOpenPanel) {
      // The surface supports one contributed panel at a time. Replacing it is therefore a real
      // close for the previous plugin, even though the user did not click Close. This lets an NMR
      // panel abort in-flight work before a different analyzer takes over the surface.
      this.host.notifyPanelClosed(previous.pluginId, previous.panelId);
    }

    this.open = {
      pluginId,
      panelId,
      title: panel.title,
      report,
      // A report may name the exact command "Run again" should re-invoke (e.g. the ¹H vs ¹³C command
      // that produced it); otherwise fall back to the panel contribution's default command.
      commandId: report.rerunCommandId ?? panel.commandId,
      // Pending -> result reports for the same panel are updates, not close/reopen cycles.
      openedAt: updatesOpenPanel ? previous.openedAt : this.nowIso()
    };
    this.notify();
  }

  getOpenPanel(): OpenPluginPanel | undefined {
    return this.open;
  }

  closePanel(): void {
    if (this.open) {
      const closed = this.open;
      this.open = undefined;
      // Tell the plugin its panel closed so it can cancel in-flight work (ADR-0012).
      this.host.notifyPanelClosed(closed.pluginId, closed.panelId);
      this.notify();
    }
  }

  getDiagnostics(): readonly PluginDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * Record a controlled runtime diagnostic from desktop code.
   *
   * Used by the installed-plugin reload (M36): an install whose staged files are missing or unloadable
   * must be *reported*, not thrown, so one broken install cannot stop the app — or the other plugins —
   * from starting. Same contract as the internal unknown-panel path, just reachable from outside.
   */
  reportDiagnostic(code: string, message: string): void {
    this.recordDiagnostic(code, message);
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
