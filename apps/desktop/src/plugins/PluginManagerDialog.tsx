import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { dangerousPluginPermissions, type PluginPermission } from "@chemdraft/plugin-api";

import {
  getUnavailableDesktopPluginPermissions,
  unavailableDesktopPluginPermissions,
  type DesktopPluginRuntime
} from "./createPluginRuntime";
import type { InstalledPluginCatalogEntry, PluginPackageInspection } from "./installPluginPackage";
import type { PickedPluginPackage } from "./pickPluginPackage";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";

export interface PluginManagerDialogProps {
  runtime: DesktopPluginRuntime;
  bundledPlugins: readonly BundledPluginDescriptor[];
  /** Plugins installed from a package (M36). Empty where installing is unsupported (browser build, tests). */
  installedPlugins?: readonly InstalledPluginCatalogEntry[];
  /** Show the native picker and describe the chosen package. `undefined` means the user cancelled.
   *  Absent when this build cannot install packages, which is what disables the control. */
  onPickPackage?: () => Promise<PickedPluginPackage | undefined>;
  /** Stage, load and register a described package. */
  onInstallPackage?: (inspection: PluginPackageInspection) => Promise<void>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
  onClose: () => void;
  onPluginsChanged?: () => void;
}

/**
 * Core-owned manager (ADR-0027) for both the plugins compiled into this build and those installed from a
 * package (M36).
 *
 * A disabled plugin — bundled or installed — stays in the catalog so it can be enabled again; only its
 * live host registration is removed. That rule predates installs (M32) and is why the catalog, not
 * `PluginHost.listPlugins()`, drives this list: the host only knows what is *currently registered*.
 *
 * ## The permissions panel is a disclosure, with a fail-closed availability check
 *
 * ADR-0029 §3 remains permissive for capabilities this build implements: available declared permissions
 * are auto-granted, without a per-permission prompt. A reserved permission whose capability broker does
 * not exist yet is different: the review names it as unavailable and refuses the whole package rather
 * than claiming a grant the worker cannot exercise. Dangerous permissions are still marked because a
 * user deserves to see them, not because marking them adds a consent prompt.
 */
export function PluginManagerDialog({
  runtime,
  bundledPlugins,
  installedPlugins = [],
  onPickPackage,
  onInstallPackage,
  onUninstallPlugin,
  onClose,
  onPluginsChanged
}: PluginManagerDialogProps) {
  const titleId = useId();
  const packageNoteId = useId();
  const [, refreshFromHost] = useReducer((version: number) => version + 1, 0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PickedPluginPackage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const backdropPressStartedRef = useRef(false);

  // Keep the checkboxes truthful even when a registration changes outside this dialog.
  useEffect(() => runtime.host.subscribe(refreshFromHost), [runtime]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  // The catalog is bundled + installed, and an installed plugin is managed exactly like a compiled-in
  // one. Where both carry the same id — a package built from a plugin this build also bundles, which is
  // the ordinary case — the **installed copy shadows the bundled one**, matching what the host actually
  // has registered. Listing both would show two rows for one live plugin and let the toggle fight itself.
  const installedIds = new Set(installedPlugins.map((entry) => entry.record.id));
  const catalog: readonly BundledPluginDescriptor[] = [
    ...bundledPlugins.filter((descriptor) => !installedIds.has(descriptor.manifest.id)),
    ...installedPlugins.map(
      (entry): BundledPluginDescriptor =>
        entry.descriptor ?? { manifest: entry.manifest, options: { commandHandlers: {} } }
    )
  ];
  const enabledIds = new Set(runtime.host.listPlugins().map((manifest) => manifest.id));
  const canInstall = onPickPackage !== undefined && onInstallPackage !== undefined;

  const togglePlugin = (pluginId: string): void => {
    if (busy) {
      return;
    }

    // Preserve preferences for catalog entries that failed to load or are temporarily absent. A
    // toggle may update the visible catalog, but it must never silently re-enable an unseen plugin.
    const disabledIds = loadDisabledPluginIds();
    for (const descriptor of catalog) {
      const candidate = descriptor.manifest.id;
      if (enabledIds.has(candidate)) {
        disabledIds.delete(candidate);
      } else {
        disabledIds.add(candidate);
      }
    }

    if (enabledIds.has(pluginId)) {
      disabledIds.add(pluginId);
    } else {
      disabledIds.delete(pluginId);
    }

    try {
      applyEnabledPlugins(runtime, disabledIds, catalog);
      saveDisabledPluginIds(disabledIds);
      setError(undefined);
      onPluginsChanged?.();
    } catch (cause: unknown) {
      setError(messageOf(cause));
    }
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const pickPackage = (): Promise<void> =>
    run(async () => {
      const picked = await onPickPackage!();
      // A cancelled picker is not a failure; leave the dialog exactly as it was.
      if (picked) {
        setPending(picked);
      }
    });

  const installPending = (): Promise<void> =>
    run(async () => {
      if (!pending) return;
      await onInstallPackage!(pending.inspection);
      setPending(undefined);
      onPluginsChanged?.();
    });

  const uninstall = (pluginId: string): Promise<void> =>
    run(async () => {
      await onUninstallPlugin!(pluginId);
      onPluginsChanged?.();
    });

  return createPortal(
    <div
      className="plugin-manager-backdrop"
      data-testid="plugin-manager-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        backdropPressStartedRef.current = event.target === event.currentTarget;
      }}
      onPointerCancel={() => {
        backdropPressStartedRef.current = false;
      }}
      onClick={(event) => {
        const directBackdropClick = event.target === event.currentTarget && backdropPressStartedRef.current;
        backdropPressStartedRef.current = false;
        if (directBackdropClick && !busy) {
          onClose();
        }
      }}
    >
      <section
        aria-busy={busy}
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
            <p>Enable or disable the plugins bundled with this ChemDraft build, or install one from a package.</p>
          </div>
          <button type="button" className="plugin-manager-button" disabled={busy} onClick={onClose} autoFocus>
            Close
          </button>
        </header>

        {error ? (
          <div className="plugin-manager-error" role="alert">
            Plugin change failed: {error}
          </div>
        ) : null}

        <ul className="plugin-manager-list" aria-label="Bundled plugins">
          {catalog.map((descriptor) => {
            const manifest = descriptor.manifest;
            const enabled = enabledIds.has(manifest.id);
            const installed = installedIds.has(manifest.id);
            const installedEntry = installedPlugins.find((entry) => entry.record.id === manifest.id);
            const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
            const unavailable =
              installed && (installedEntry?.descriptor === undefined || unavailablePermissions.length > 0);
            return (
              <li className="plugin-manager-item" data-plugin-id={manifest.id} key={manifest.id}>
                <div className="plugin-manager-details">
                  <div className="plugin-manager-name">
                    {manifest.name} <span>v{manifest.version}</span>
                    {installed ? <span className="plugin-manager-badge">Installed</span> : null}
                  </div>
                  <div className="plugin-manager-id">{manifest.id}</div>
                  {manifest.description ? <p>{manifest.description}</p> : null}
                  {installed ? <PermissionList permissions={manifest.permissions} /> : null}
                </div>
                <div className="plugin-manager-actions">
                  <label className="plugin-manager-toggle">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${manifest.name}`}
                      checked={enabled}
                      disabled={busy || unavailable}
                      onChange={() => togglePlugin(manifest.id)}
                    />
                    <span>{unavailable ? "Unavailable" : enabled ? "Enabled" : "Disabled"}</span>
                  </label>
                  {installed && onUninstallPlugin ? (
                    <button
                      className="plugin-manager-button"
                      data-action="uninstall-plugin"
                      data-plugin-id={manifest.id}
                      disabled={busy}
                      onClick={() => void uninstall(manifest.id)}
                      type="button"
                    >
                      Uninstall
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {pending ? (
          <PackageReview
            busy={busy}
            picked={pending}
            onCancel={() => setPending(undefined)}
            onInstall={() => void installPending()}
          />
        ) : (
          <footer className="plugin-manager-package">
            <button
              aria-describedby={packageNoteId}
              className="plugin-manager-button"
              data-action="add-plugin-package"
              disabled={!canInstall || busy}
              onClick={() => void pickPackage()}
              type="button"
            >
              Add plugin from package…
            </button>
            <p id={packageNoteId}>
              {canInstall
                ? "Install plugins you trust: supported declared permissions take effect without a separate consent prompt."
                : "Installing plugins from a package is only available in the ChemDraft desktop app."}
            </p>
          </footer>
        )}
      </section>
    </div>,
    document.body
  );
}

/**
 * What the package declares, shown before it is staged.
 *
 * Everything here is disclosure. There is no permission-by-permission choice: supported permissions
 * take effect together, while a package containing a reserved/unavailable permission is refused whole.
 */
function PackageReview({
  busy,
  picked,
  onCancel,
  onInstall
}: {
  busy: boolean;
  picked: PickedPluginPackage;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const { manifest, provenance, unpackedBytes, sourceChecksum } = picked.inspection;
  const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
  return (
    <footer className="plugin-manager-review" data-testid="plugin-package-review">
      <div className="plugin-manager-review-body">
        <div className="plugin-manager-name">
          {manifest.name} <span>v{manifest.version}</span>
        </div>
        <div className="plugin-manager-id">{manifest.id}</div>
        {manifest.description ? <p data-testid="plugin-package-description">{manifest.description}</p> : null}

        <PermissionList permissions={manifest.permissions} />

        {unavailablePermissions.length > 0 ? (
          <p className="plugin-manager-unavailable" data-testid="plugin-package-unavailable" role="alert">
            Cannot install this package: {unavailablePermissions.join(", ")} is reserved for a future
            capability broker and is unavailable in this build.
          </p>
        ) : null}

        <dl className="plugin-manager-provenance">
          <div>
            <dt>Package</dt>
            <dd>
              {formatBytes(unpackedBytes)} unpacked ·{" "}
              {picked.checksumVerified ? "checksum verified" : "no .sha256 sidecar found"}
            </dd>
          </div>
          <div>
            <dt>Built from</dt>
            <dd>
              {provenance.sourceCommit.slice(0, 12)} ({provenance.sourceTree}) · SDK {provenance.sdkVersion}
            </dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd className="plugin-manager-digest">{sourceChecksum}</dd>
          </div>
        </dl>
      </div>
      <div className="plugin-manager-actions">
        <button className="plugin-manager-button" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="plugin-manager-button"
          data-action="confirm-install-package"
          disabled={busy || unavailablePermissions.length > 0}
          onClick={onInstall}
          type="button"
        >
          {busy ? "Installing…" : unavailablePermissions.length > 0 ? "Cannot install" : "Install"}
        </button>
      </div>
    </footer>
  );
}

/** Declared permissions, displayed without implying that reserved capabilities are currently granted. */
function PermissionList({ permissions }: { permissions: readonly PluginPermission[] }) {
  if (permissions.length === 0) {
    return (
      <p className="plugin-manager-permissions" data-testid="plugin-package-permissions">
        Declares no permissions.
      </p>
    );
  }
  const dangerous = new Set<string>(dangerousPluginPermissions);
  const unavailable = new Set<string>(unavailableDesktopPluginPermissions);
  return (
    <div className="plugin-manager-permissions" data-testid="plugin-package-permissions">
      <span>Declared permissions:</span>
      <ul>
        {permissions.map((permission) => {
          const className = [
            "plugin-manager-permission",
            dangerous.has(permission) ? "is-dangerous" : undefined,
            unavailable.has(permission) ? "is-unavailable" : undefined
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li className={className} data-permission={permission} key={permission}>
              {permission}
              {unavailable.has(permission) ? " — unavailable in this build" : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
