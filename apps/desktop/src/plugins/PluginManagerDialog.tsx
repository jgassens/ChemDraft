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
import type {
  PluginUpdateCheckResult,
  PluginUpdateOffer,
  PreparedPluginUpdate
} from "./pluginUpdates";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";

export interface PluginManagerDialogProps {
  runtime: DesktopPluginRuntime;
  bundledPlugins: readonly BundledPluginDescriptor[];
  /** Plugins installed from a package (M36). Empty where installing is unsupported (browser build, tests). */
  installedPlugins?: readonly InstalledPluginCatalogEntry[];
  /** False only while the desktop is still reading its on-disk install catalog. */
  installedPluginCatalogReady?: boolean;
  /** Show the native picker and describe the chosen package. `undefined` means the user cancelled.
   *  Absent when this build cannot install packages, which is what disables the control. */
  onPickPackage?: () => Promise<PickedPluginPackage | undefined>;
  /** Stage, load and register a described package. */
  onInstallPackage?: (inspection: PluginPackageInspection) => Promise<void>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
  /** Host-owned update operations. All are absent outside the Tauri desktop. */
  onCheckPluginUpdates?: () => Promise<readonly PluginUpdateCheckResult[]>;
  onPreparePluginUpdate?: (offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>;
  onUpdatePlugin?: (prepared: PreparedPluginUpdate) => Promise<void>;
  onClose: () => void;
  onPluginsChanged?: () => void;
}

type PluginManagerBusyOperation =
  | { kind: "pickPackage" }
  | { kind: "installPackage" }
  | { kind: "uninstallPlugin"; pluginId: string; pluginName: string }
  | { kind: "checkUpdates" }
  | { kind: "prepareUpdate"; pluginId: string; pluginName: string }
  | { kind: "applyUpdate"; pluginName: string };

interface CatalogBoundUpdateResults {
  catalogKey: string;
  results: ReadonlyMap<string, PluginUpdateCheckResult>;
}

interface CatalogBoundPreparedUpdate {
  catalogKey: string;
  prepared: PreparedPluginUpdate;
}

interface PluginManagerNotice {
  text: string;
  /** Check summaries become stale whenever the installed bytes change. Operation-completion notices do not. */
  catalogKey?: string;
}

const NO_PLUGIN_UPDATE_RESULTS: ReadonlyMap<string, PluginUpdateCheckResult> = new Map();

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
  installedPluginCatalogReady = true,
  onPickPackage,
  onInstallPackage,
  onUninstallPlugin,
  onCheckPluginUpdates,
  onPreparePluginUpdate,
  onUpdatePlugin,
  onClose,
  onPluginsChanged
}: PluginManagerDialogProps) {
  const titleId = useId();
  const packageNoteId = useId();
  const [, refreshFromHost] = useReducer((version: number) => version + 1, 0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PickedPluginPackage | undefined>(undefined);
  const [pendingUpdateState, setPendingUpdateState] = useState<CatalogBoundPreparedUpdate | undefined>(undefined);
  const [updateResultsState, setUpdateResultsState] = useState<CatalogBoundUpdateResults | undefined>(undefined);
  const [noticeState, setNoticeState] = useState<PluginManagerNotice | undefined>(undefined);
  const [busyOperation, setBusyOperation] = useState<PluginManagerBusyOperation | undefined>(undefined);
  const busy = busyOperation !== undefined;
  const backdropPressStartedRef = useRef(false);

  const installedCatalogKey = installedPluginCatalogKey(installedPlugins);
  const pendingUpdate =
    pendingUpdateState?.catalogKey === installedCatalogKey ? pendingUpdateState.prepared : undefined;
  const updateResults =
    updateResultsState?.catalogKey === installedCatalogKey
      ? updateResultsState.results
      : NO_PLUGIN_UPDATE_RESULTS;
  const notice =
    noticeState &&
    (noticeState.catalogKey === undefined || noticeState.catalogKey === installedCatalogKey)
      ? noticeState.text
      : undefined;
  const progressMessage = pluginManagerProgressMessage(busyOperation);

  // Keep the checkboxes truthful even when a registration changes outside this dialog.
  useEffect(() => runtime.host.subscribe(refreshFromHost), [runtime]);

  useEffect(() => {
    // Escape works even while an operation runs. A trusted-update download is allowed two minutes,
    // and the operation is owned by the install machinery rather than by this dialog — closing does
    // not abandon it, it just stops holding the user hostage to a progress line.
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
  const installSupported = onPickPackage !== undefined && onInstallPackage !== undefined;
  const updateSupported =
    onCheckPluginUpdates !== undefined &&
    onPreparePluginUpdate !== undefined &&
    onUpdatePlugin !== undefined;
  const canInstall = installedPluginCatalogReady && installSupported;
  const canUpdate = installedPluginCatalogReady && updateSupported;

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

  const run = async (
    operation: PluginManagerBusyOperation,
    action: () => Promise<void>
  ): Promise<void> => {
    setBusyOperation(operation);
    setError(undefined);
    setNoticeState(undefined);
    try {
      await action();
      setError(undefined);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setBusyOperation(undefined);
    }
  };

  const pickPackage = (): Promise<void> =>
    run({ kind: "pickPackage" }, async () => {
      const picked = await onPickPackage!();
      // A cancelled picker is not a failure; leave the dialog exactly as it was.
      if (picked) {
        setPendingUpdateState(undefined);
        setPending(picked);
        setNoticeState(undefined);
      }
    });

  const installPending = (): Promise<void> =>
    run({ kind: "installPackage" }, async () => {
      if (!pending) return;
      await onInstallPackage!(pending.inspection);
      setPending(undefined);
      onPluginsChanged?.();
    });

  const uninstall = (pluginId: string): Promise<void> =>
    run(
      {
        kind: "uninstallPlugin",
        pluginId,
        pluginName: installedPlugins.find((entry) => entry.record.id === pluginId)?.manifest.name ?? pluginId
      },
      async () => {
        await onUninstallPlugin!(pluginId);
        onPluginsChanged?.();
      }
    );

  const checkForUpdates = (): Promise<void> =>
    run({ kind: "checkUpdates" }, async () => {
      const results = await onCheckPluginUpdates!();
      setUpdateResultsState({
        catalogKey: installedCatalogKey,
        results: new Map(results.map((result) => [result.pluginId, result]))
      });
      setNoticeState({
        catalogKey: installedCatalogKey,
        text: pluginUpdateCheckSummary(results, installedPlugins.length)
      });
    });

  const reviewUpdate = (offer: PluginUpdateOffer): Promise<void> =>
    run(
      { kind: "prepareUpdate", pluginId: offer.pluginId, pluginName: offer.pluginName },
      async () => {
        const prepared = await onPreparePluginUpdate!(offer);
        setPending(undefined);
        setPendingUpdateState({ catalogKey: installedCatalogKey, prepared });
        setNoticeState(undefined);
      }
    );

  const applyPendingUpdate = (): Promise<void> =>
    run({ kind: "applyUpdate", pluginName: pendingUpdate?.offer.pluginName ?? "plugin" }, async () => {
      if (!pendingUpdate) return;
      await onUpdatePlugin!(pendingUpdate);
      const { offer } = pendingUpdate;
      // The parent replaces the catalog entry. Discard the old catalog-bound offer immediately instead
      // of synthesizing a result for state whose new checksum/path has not reached this render yet.
      setUpdateResultsState(undefined);
      setPendingUpdateState(undefined);
      setNoticeState({ text: `${offer.pluginName} updated to version ${offer.version}.` });
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
            <p>
              Enable or disable plugins, install a package, or check installed plugins for trusted updates.
            </p>
          </div>
          {/* Never disabled — see the Escape handler. The row buttons below stay disabled while
              busy, which is what actually prevents a second concurrent operation. */}
          <button type="button" className="plugin-manager-button" onClick={onClose} autoFocus>
            Close
          </button>
        </header>

        {error ? (
          <div className="plugin-manager-error" role="alert">
            Plugin operation failed: {error}
          </div>
        ) : null}

        {progressMessage || !installedPluginCatalogReady || notice ? (
          <div
            className="plugin-manager-notice"
            aria-live="polite"
            data-testid="plugin-manager-status"
            role="status"
          >
            {progressMessage ??
              (!installedPluginCatalogReady ? "Loading installed plugins…" : notice)}
          </div>
        ) : null}

        <ul className="plugin-manager-list" aria-label="Plugins">
          {catalog.map((descriptor) => {
            const manifest = descriptor.manifest;
            const enabled = enabledIds.has(manifest.id);
            const installed = installedIds.has(manifest.id);
            const installedEntry = installedPlugins.find((entry) => entry.record.id === manifest.id);
            const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
            const unavailable =
              installed && (installedEntry?.descriptor === undefined || unavailablePermissions.length > 0);
            const updateResult = updateResults.get(manifest.id);
            return (
              <li className="plugin-manager-item" data-plugin-id={manifest.id} key={manifest.id}>
                <div className="plugin-manager-details">
                  <div className="plugin-manager-name">
                    {manifest.name} <span>v{manifest.version}</span>
                    {installed ? <span className="plugin-manager-badge">Installed</span> : null}
                    {updateResult?.status === "available" ? (
                      <span className="plugin-manager-badge is-update">Update available</span>
                    ) : null}
                  </div>
                  <div className="plugin-manager-id">{manifest.id}</div>
                  {manifest.description ? <p>{manifest.description}</p> : null}
                  {installed ? <PermissionList permissions={manifest.permissions} /> : null}
                  {!installed ? (
                    <p className="plugin-manager-update-status">Included with ChemDraft — updated with the app.</p>
                  ) : null}
                  {installed && updateResult ? <PluginUpdateStatus result={updateResult} /> : null}
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
                  {installed && updateResult?.status === "available" ? (
                    <button
                      className="plugin-manager-button"
                      data-action="review-plugin-update"
                      data-plugin-id={manifest.id}
                      disabled={busy || !canUpdate}
                      onClick={() => void reviewUpdate(updateResult.offer)}
                      type="button"
                    >
                      {busyOperation?.kind === "prepareUpdate" &&
                      busyOperation.pluginId === manifest.id
                        ? "Downloading update…"
                        : "Review update…"}
                    </button>
                  ) : null}
                  {installed && onUninstallPlugin ? (
                    <button
                      className="plugin-manager-button"
                      data-action="uninstall-plugin"
                      data-plugin-id={manifest.id}
                      disabled={busy}
                      onClick={() => void uninstall(manifest.id)}
                      type="button"
                    >
                      {busyOperation?.kind === "uninstallPlugin" &&
                      busyOperation.pluginId === manifest.id
                        ? "Uninstalling…"
                        : "Uninstall"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {pendingUpdate ? (
          <PackageReview
            busy={busy}
            currentVersion={pendingUpdate.offer.installedVersion}
            mode="update"
            subject={pendingUpdate}
            onCancel={() => setPendingUpdateState(undefined)}
            onConfirm={() => void applyPendingUpdate()}
          />
        ) : pending ? (
          <PackageReview
            busy={busy}
            mode="install"
            subject={pending}
            onCancel={() => setPending(undefined)}
            onConfirm={() => void installPending()}
          />
        ) : (
          <footer className="plugin-manager-package">
            <div className="plugin-manager-package-actions">
              <button
                aria-describedby={packageNoteId}
                className="plugin-manager-button"
                data-action="add-plugin-package"
                disabled={!canInstall || busy}
                onClick={() => void pickPackage()}
                type="button"
              >
                {busyOperation?.kind === "pickPackage"
                  ? "Choosing package…"
                  : "Add plugin from package…"}
              </button>
              <button
                aria-describedby={packageNoteId}
                className="plugin-manager-button"
                data-action="check-plugin-updates"
                disabled={!canUpdate || busy}
                onClick={() => void checkForUpdates()}
                type="button"
              >
                {busyOperation?.kind === "checkUpdates"
                  ? "Checking…"
                  : "Check for plugin updates"}
              </button>
            </div>
            <p id={packageNoteId}>
              {!installedPluginCatalogReady
                ? "Installed plugins are still loading. Package and update actions will be available shortly."
                : canInstall && canUpdate
                ? "Install plugins you trust. Update checks are user-initiated and limited to ChemDraft's trusted catalog."
                : "Installing and updating plugins is only available in the ChemDraft desktop app."}
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
  currentVersion,
  mode,
  subject,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  currentVersion?: string;
  mode: "install" | "update";
  subject: Pick<PickedPluginPackage, "inspection" | "checksumVerified">;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { manifest, provenance, unpackedBytes, sourceChecksum } = subject.inspection;
  const unavailablePermissions = getUnavailableDesktopPluginPermissions(manifest);
  return (
    <footer className="plugin-manager-review" data-testid="plugin-package-review">
      <div className="plugin-manager-review-body">
        <div className="plugin-manager-name">
          {manifest.name} <span>v{manifest.version}</span>
        </div>
        {mode === "update" && currentVersion ? (
          <p className="plugin-manager-update-version" data-testid="plugin-update-version">
            Updating v{currentVersion} → v{manifest.version}
          </p>
        ) : null}
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
              {subject.checksumVerified ? "checksum verified" : "no .sha256 sidecar found"}
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
        {mode === "update" ? (
          <p className="plugin-manager-integrity-note" data-testid="plugin-update-integrity-note">
            The release SHA-256 verifies package integrity; it is not a cryptographic publisher signature.
          </p>
        ) : null}
      </div>
      <div className="plugin-manager-actions">
        <button className="plugin-manager-button" disabled={busy} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="plugin-manager-button"
          data-action={mode === "update" ? "confirm-plugin-update" : "confirm-install-package"}
          disabled={busy || unavailablePermissions.length > 0}
          onClick={onConfirm}
          type="button"
        >
          {busy
            ? mode === "update"
              ? "Updating…"
              : "Installing…"
            : unavailablePermissions.length > 0
              ? mode === "update"
                ? "Cannot update"
                : "Cannot install"
              : mode === "update"
                ? "Update"
                : "Install"}
        </button>
      </div>
    </footer>
  );
}

function PluginUpdateStatus({ result }: { result: PluginUpdateCheckResult }) {
  if (result.status === "available") {
    return (
      <p className="plugin-manager-update-status" data-update-status="available">
        Version {result.latestVersion} is available.
      </p>
    );
  }
  if (result.status === "upToDate") {
    return (
      <p className="plugin-manager-update-status" data-update-status="up-to-date">
        Up to date (latest trusted release: v{result.latestVersion}).
      </p>
    );
  }
  if (result.status === "failed") {
    return (
      <p className="plugin-manager-update-status is-error" data-update-status="failed" role="alert">
        Update check failed: {result.message}
      </p>
    );
  }
  return (
    <p className="plugin-manager-update-status" data-update-status="unsupported">
      No trusted ChemDraft update source is configured for this plugin.
    </p>
  );
}

function installedPluginCatalogKey(installedPlugins: readonly InstalledPluginCatalogEntry[]): string {
  return JSON.stringify(
    [...installedPlugins]
      .map(({ record }) => ({
        id: record.id,
        version: record.version,
        sourceChecksum: record.sourceChecksum,
        stagedPath: record.stagedPath,
        installedAt: record.installedAt
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function pluginUpdateCheckSummary(
  results: readonly PluginUpdateCheckResult[],
  installedPluginCount: number
): string {
  if (installedPluginCount === 0) {
    return "No installed plugins to check.";
  }

  const available = results.filter((result) => result.status === "available").length;
  const failed = results.filter((result) => result.status === "failed").length;
  if (available > 0 || failed > 0) {
    const parts: string[] = [];
    if (available > 0) {
      parts.push(
        available === 1
          ? "1 plugin update is available."
          : `${available} plugin updates are available.`
      );
    }
    if (failed > 0) {
      parts.push(
        failed === 1
          ? "1 update check failed."
          : `${failed} update checks failed.`
      );
      parts.push("See the plugin list for details.");
    }
    return parts.join(" ");
  }

  const supported = results.some((result) => result.status !== "unsupported");
  return supported
    ? "All supported installed plugins are up to date."
    : "No installed plugins have a trusted ChemDraft update source.";
}

function pluginManagerProgressMessage(
  operation: PluginManagerBusyOperation | undefined
): string | undefined {
  if (!operation) return undefined;
  switch (operation.kind) {
    case "pickPackage":
      return "Waiting for plugin package selection…";
    case "installPackage":
      return "Installing and verifying the plugin package…";
    case "uninstallPlugin":
      return `Uninstalling ${operation.pluginName}…`;
    case "checkUpdates":
      return "Checking installed plugins for updates…";
    case "prepareUpdate":
      return `Downloading and verifying the ${operation.pluginName} update…`;
    case "applyUpdate":
      return `Updating ${operation.pluginName}…`;
  }
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
