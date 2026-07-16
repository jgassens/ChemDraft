import type { PluginContributions, PluginManifest } from "@chemdraft/plugin-api";

import type { PluginDiagnostic } from "./types";

/**
 * Lists the bundled plugins the desktop registered (id, name, version, contribution counts) plus any
 * controlled runtime diagnostics. Deliberately scoped to "bundled" plugins — this is not an installer
 * for arbitrary third-party plugins.
 */
export function PluginDiagnosticsPanel({
  plugins,
  diagnostics
}: {
  plugins: readonly PluginManifest[];
  diagnostics: readonly PluginDiagnostic[];
}) {
  return (
    <div className="plugin-diagnostics" data-testid="plugin-diagnostics">
      <h3>Bundled plugins</h3>
      {plugins.length === 0 ? (
        <p className="plugin-diagnostics-empty">No bundled plugins are registered.</p>
      ) : (
        <ul className="plugin-diagnostics-list">
          {plugins.map((manifest) => (
            <li key={manifest.id} className="plugin-diagnostics-item" data-plugin-id={manifest.id}>
              <div className="plugin-diagnostics-name">
                {manifest.name} <span className="plugin-diagnostics-version">v{manifest.version}</span>
              </div>
              <div className="plugin-diagnostics-id">{manifest.id}</div>
              <div className="plugin-diagnostics-contributions">{summarizeContributions(manifest.contributes)}</div>
            </li>
          ))}
        </ul>
      )}
      {diagnostics.length > 0 ? (
        <div className="plugin-diagnostics-warnings" data-testid="plugin-diagnostics-warnings">
          <h4>Runtime diagnostics</h4>
          <ul>
            {diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <code>{diagnostic.code}</code> {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function summarizeContributions(contributes: PluginContributions): string {
  const count = (label: string, n: number): string => `${n} ${label}${n === 1 ? "" : "s"}`;
  return [
    count("command", contributes.commands.length),
    count("menu", contributes.menus.length),
    count("panel", contributes.panels.length),
    count("analyzer", contributes.analyzers.length)
  ].join(" · ");
}
