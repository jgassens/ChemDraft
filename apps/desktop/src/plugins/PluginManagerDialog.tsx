import { useEffect, useId, useReducer, useState } from "react";
import { createPortal } from "react-dom";

import type { DesktopPluginRuntime } from "./createPluginRuntime";
import { saveDisabledPluginIds } from "./pluginPreferences";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";

export interface PluginManagerDialogProps {
  runtime: DesktopPluginRuntime;
  bundledPlugins: readonly BundledPluginDescriptor[];
  onClose: () => void;
  onPluginsChanged?: () => void;
}

/**
 * Core-owned manager for the plugins compiled into this ChemDraft build. A disabled bundled plugin
 * stays in the catalog so it can be enabled again; only its live host registration is removed.
 */
export function PluginManagerDialog({
  runtime,
  bundledPlugins,
  onClose,
  onPluginsChanged
}: PluginManagerDialogProps) {
  const titleId = useId();
  const packageNoteId = useId();
  const [, refreshFromHost] = useReducer((version: number) => version + 1, 0);
  const [error, setError] = useState<string | undefined>(undefined);

  // Keep the checkboxes truthful even when a registration changes outside this dialog.
  useEffect(() => runtime.host.subscribe(refreshFromHost), [runtime]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  const enabledIds = new Set(runtime.host.listPlugins().map((manifest) => manifest.id));
  const togglePlugin = (pluginId: string): void => {
    const disabledIds = new Set(
      bundledPlugins
        .map((descriptor) => descriptor.manifest.id)
        .filter((bundledPluginId) => !enabledIds.has(bundledPluginId))
    );

    if (enabledIds.has(pluginId)) {
      disabledIds.add(pluginId);
    } else {
      disabledIds.delete(pluginId);
    }

    try {
      applyEnabledPlugins(runtime, disabledIds, bundledPlugins);
      saveDisabledPluginIds(disabledIds);
      setError(undefined);
      onPluginsChanged?.();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return createPortal(
    <div
      className="plugin-manager-backdrop"
      data-testid="plugin-manager-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="plugin-manager-dialog"
        data-testid="plugin-manager-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="plugin-manager-header">
          <div>
            <h2 id={titleId}>Add or Remove Plugins</h2>
            <p>Enable or disable the plugins bundled with this ChemDraft build.</p>
          </div>
          <button type="button" className="plugin-manager-button" onClick={onClose} autoFocus>
            Close
          </button>
        </header>

        {error ? (
          <div className="plugin-manager-error" role="alert">
            Plugin change failed: {error}
          </div>
        ) : null}

        <ul className="plugin-manager-list" aria-label="Bundled plugins">
          {bundledPlugins.map((descriptor) => {
            const manifest = descriptor.manifest;
            const enabled = enabledIds.has(manifest.id);
            return (
              <li className="plugin-manager-item" data-plugin-id={manifest.id} key={manifest.id}>
                <div className="plugin-manager-details">
                  <div className="plugin-manager-name">
                    {manifest.name} <span>v{manifest.version}</span>
                  </div>
                  <div className="plugin-manager-id">{manifest.id}</div>
                  {manifest.description ? <p>{manifest.description}</p> : null}
                </div>
                <label className="plugin-manager-toggle">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${manifest.name}`}
                    checked={enabled}
                    onChange={() => togglePlugin(manifest.id)}
                  />
                  <span>{enabled ? "Enabled" : "Disabled"}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <footer className="plugin-manager-package">
          <button
            aria-describedby={packageNoteId}
            className="plugin-manager-button"
            data-action="add-plugin-package"
            disabled
            type="button"
          >
            Add plugin from package…
          </button>
          <p id={packageNoteId}>Installing plugins from a package arrives with the plugin-packaging milestone.</p>
        </footer>
      </section>
    </div>,
    document.body
  );
}
