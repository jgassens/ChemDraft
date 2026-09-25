import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { dangerousPluginPermissions, type PluginPermission } from "@chemdraft/plugin-api";

import {
  getUnavailableDesktopPluginPermissions,
  unavailableDesktopPluginPermissions,
  type DesktopPluginRuntime
} from "./createPluginRuntime";
import type { InstalledPluginCatalogEntry, PluginPackageInspection } from "./installPluginPackage";
import { keepFocusInsideDialog } from "./PluginImageRequestDialog";
import type { PickedPluginPackage } from "./pickPluginPackage";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import type {
  PreparedOfficialPluginInstall,
  PluginUpdateCheckResult,
  PluginUpdateOffer,
  PreparedPluginUpdate
} from "./pluginUpdates";
import { OFFICIAL_PLUGIN_CATALOG } from "./pluginUpdates";
import { RecognitionInstallProgress } from "./RecognitionInstallProgress";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";
import type { StructureRecognitionInstallRun } from "./StructureRecognitionController";
import {
  formatDiskBytes,
  isRecognitionInstallKeyboardEvent,
  recognitionInstallErrorMessage
} from "./StructureRecognitionInstallDialog";
import type { StructureRecognitionEngineStatus } from "./structureRecognitionEngine";

/** Whether the official catalog says this plugin needs the host-managed recognition engine. The
 *  catalog entry is the only authority; nothing here keys on a particular plugin id. */
function requiresRecognitionEngine(pluginId: string | undefined): boolean {
  return (
    pluginId !== undefined &&
    OFFICIAL_PLUGIN_CATALOG.some(
      (entry) => entry.pluginId === pluginId && entry.requiresEngine === "structureRecognition"
    )
  );
}

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
  /** Download and inspect one entry from the host-owned official catalog. */
  onPrepareOfficialPluginInstall?: (pluginId: string) => Promise<PreparedOfficialPluginInstall>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
  /** Host-owned update operations. All are absent outside the Tauri desktop. */
  onCheckPluginUpdates?: () => Promise<readonly PluginUpdateCheckResult[]>;
  onPreparePluginUpdate?: (offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>;
  onUpdatePlugin?: (prepared: PreparedPluginUpdate) => Promise<void>;
  recognitionEngineStatus?: StructureRecognitionEngineStatus;
  /** The engine install in progress, or the last one that stopped without installing. It outlives
   *  this dialog, so reopening the dialog shows the same install rather than offering another. */
  recognitionEngineInstall?: StructureRecognitionInstallRun;
  /** Asked once when the dialog opens; the engine status is never read at app startup. */
  onRefreshRecognitionEngineStatus?: () => Promise<void>;
  /** Installs the engine in place; progress arrives through `recognitionEngineInstall`. */
  onInstallRecognitionEngine?: () => Promise<boolean>;
  onCancelRecognitionEngineInstall?: () => Promise<void>;
  onUninstallRecognitionEngine?: () => Promise<void>;
  onClose: () => void;
  onPluginsChanged?: () => void;
}

type PluginManagerBusyOperation =
  | { kind: "pickPackage" }
  | { kind: "installPackage" }
  | { kind: "prepareOfficialInstall"; pluginId: string; pluginName: string }
  | { kind: "uninstallPlugin"; pluginId: string; pluginName: string }
  | { kind: "removeRecognitionEngine" }
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
  onPrepareOfficialPluginInstall,
  onUninstallPlugin,
  onCheckPluginUpdates,
  onPreparePluginUpdate,
  onUpdatePlugin,
  recognitionEngineStatus,
  recognitionEngineInstall,
  onRefreshRecognitionEngineStatus,
  onInstallRecognitionEngine,
  onCancelRecognitionEngineInstall,
  onUninstallRecognitionEngine,
  onClose,
  onPluginsChanged
}: PluginManagerDialogProps) {
  const titleId = useId();
  const packageNoteId = useId();
  const [, refreshFromHost] = useReducer((version: number) => version + 1, 0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PickedPluginPackage | PreparedOfficialPluginInstall | undefined>(undefined);
  const [pendingOfficialPluginId, setPendingOfficialPluginId] = useState<string | undefined>(undefined);
  const [officialInstallErrors, setOfficialInstallErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [pendingUpdateState, setPendingUpdateState] = useState<CatalogBoundPreparedUpdate | undefined>(undefined);
  const [updateResultsState, setUpdateResultsState] = useState<CatalogBoundUpdateResults | undefined>(undefined);
  const [noticeState, setNoticeState] = useState<PluginManagerNotice | undefined>(undefined);
  const [busyOperation, setBusyOperation] = useState<PluginManagerBusyOperation | undefined>(undefined);
  /** Disk size of the recognition engine the user may also want gone, asked once after MolScribe's
   *  plugin is uninstalled. The engine is host-owned and outlives the plugin unless the user says so. */
  const [engineRemovalOfferBytes, setEngineRemovalOfferBytes] = useState<number | undefined>(undefined);
  const busy = busyOperation !== undefined;
  const backdropPressStartedRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);

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

  // A row's button swaps label mid-operation (Install -> Downloading…, Install engine -> Cancel
  // install, Uninstall -> Removing…) by becoming disabled; keep the keyboard on this dialog instead
  // of letting it drop to <body>, from where Escape and the canvas shortcuts behind the modal take over.
  useLayoutEffect(() => keepFocusInsideDialog(dialogRef.current));

  useEffect(() => {
    // Escape works even while an operation runs. A trusted-update download is allowed two minutes,
    // and the operation is owned by the install machinery rather than by this dialog — closing does
    // not abandon it, it just stops holding the user hostage to a progress line.
    const closeOnEscape = (event: KeyboardEvent): void => {
      // The engine install dialog opens over this one and owns its own Escape (decline or cancel).
      if (event.key === "Escape" && !isRecognitionInstallKeyboardEvent(event)) {
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
  const availableOfficialPlugins = OFFICIAL_PLUGIN_CATALOG.filter((entry) => !installedIds.has(entry.pluginId));
  const catalog: readonly BundledPluginDescriptor[] = [
    ...bundledPlugins.filter((descriptor) => !installedIds.has(descriptor.manifest.id)),
    ...installedPlugins.map(
      (entry): BundledPluginDescriptor =>
        entry.descriptor ?? { manifest: entry.manifest, options: { commandHandlers: {} } }
    )
  ];
  const enabledIds = new Set(runtime.host.listPlugins().map((manifest) => manifest.id));
  const installSupported = onPickPackage !== undefined && onInstallPackage !== undefined;
  const officialInstallSupported =
    onPrepareOfficialPluginInstall !== undefined && onInstallPackage !== undefined;
  const updateSupported =
    onCheckPluginUpdates !== undefined &&
    onPreparePluginUpdate !== undefined &&
    onUpdatePlugin !== undefined;
  const canInstall = installedPluginCatalogReady && installSupported;
  const canInstallOfficial = installedPluginCatalogReady && officialInstallSupported;
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
        setPendingOfficialPluginId(undefined);
        setPending(picked);
        setNoticeState(undefined);
      }
    });

  const engineInstalling =
    recognitionEngineInstall?.running === true || recognitionEngineStatus?.state === "installing";
  const pendingNeedsEngine = requiresRecognitionEngine(pendingOfficialPluginId);

  const installPending = (): Promise<void> =>
    run({ kind: "installPackage" }, async () => {
      if (!pending) return;
      await onInstallPackage!(pending.inspection);
      setPending(undefined);
      if (pendingOfficialPluginId) {
        setOfficialInstallErrors((current) => withoutMapKey(current, pendingOfficialPluginId));
      }
      setPendingOfficialPluginId(undefined);
      onPluginsChanged?.();
      // One click: the review already said the engine comes too, so start it now. Its progress
      // shows in the plugin's row; a failure leaves the plugin installed with an Install engine
      // button, because the plugin itself installed fine.
      if (
        pendingNeedsEngine &&
        onInstallRecognitionEngine &&
        recognitionEngineStatus?.state !== "installed" &&
        recognitionEngineStatus?.state !== "unsupported"
      ) {
        void onInstallRecognitionEngine();
      }
    });

  const prepareOfficialInstall = (pluginId: string, pluginName: string): Promise<void> => {
    setBusyOperation({ kind: "prepareOfficialInstall", pluginId, pluginName });
    setError(undefined);
    setNoticeState(undefined);
    setOfficialInstallErrors((current) => withoutMapKey(current, pluginId));
    return onPrepareOfficialPluginInstall!(pluginId)
      .then((prepared) => {
        setPendingUpdateState(undefined);
        setPendingOfficialPluginId(pluginId);
        setPending(prepared);
        // The review states the engine's size against the free space now, so read it fresh.
        if (requiresRecognitionEngine(pluginId)) onRefreshRecognitionEngineStatus?.().catch(() => undefined);
      })
      .catch((cause: unknown) => {
        setOfficialInstallErrors((current) => new Map(current).set(pluginId, messageOf(cause)));
      })
      .finally(() => setBusyOperation(undefined));
  };

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
        if (
          requiresRecognitionEngine(pluginId) &&
          recognitionEngineStatus?.state === "installed" &&
          onUninstallRecognitionEngine
        ) {
          setEngineRemovalOfferBytes(recognitionEngineStatus.installed?.diskBytes ?? 0);
        }
      }
    );

  const removeRecognitionEngineAfterUninstall = (): Promise<void> =>
    run({ kind: "removeRecognitionEngine" }, async () => {
      setEngineRemovalOfferBytes(undefined);
      await onUninstallRecognitionEngine!();
      setNoticeState({ text: "Recognition engine removed." });
    });

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
        ref={dialogRef}
        aria-busy={busy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="plugin-manager-dialog"
        data-testid="plugin-manager-dialog"
        role="dialog"
        tabIndex={-1}
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

        {engineRemovalOfferBytes !== undefined ? (
          <div
            aria-labelledby={`${titleId}-engine-offer`}
            className="plugin-manager-notice"
            data-testid="recognition-engine-removal-offer"
            role="group"
          >
            <p id={`${titleId}-engine-offer`}>
              Also remove the recognition engine ({formatDiskBytes(engineRemovalOfferBytes)})?
            </p>
            <div className="plugin-manager-package-actions">
              <button
                className="plugin-manager-button"
                data-action="confirm-remove-recognition-engine"
                disabled={busy}
                onClick={() => void removeRecognitionEngineAfterUninstall()}
                type="button"
              >
                Remove
              </button>
              <button
                className="plugin-manager-button"
                data-action="keep-recognition-engine"
                disabled={busy}
                onClick={() => setEngineRemovalOfferBytes(undefined)}
                type="button"
              >
                Keep
              </button>
            </div>
          </div>
        ) : null}

        <div className="plugin-manager-catalog">
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
                    {installed && requiresRecognitionEngine(manifest.id) ? (
                      <RecognitionEngineRow
                        status={recognitionEngineStatus}
                        run={recognitionEngineInstall}
                        onRefresh={onRefreshRecognitionEngineStatus}
                        disabled={busy}
                        onInstall={onInstallRecognitionEngine}
                        onCancel={onCancelRecognitionEngineInstall}
                        onUninstall={onUninstallRecognitionEngine}
                      />
                    ) : null}
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
                        disabled={busy || (engineInstalling && requiresRecognitionEngine(manifest.id))}
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

          <section className="plugin-manager-available" aria-labelledby={`${titleId}-available`}>
            <h3 id={`${titleId}-available`}>Available</h3>
            {availableOfficialPlugins.length > 0 ? (
              <ul className="plugin-manager-list" aria-label="Available official plugins">
                {availableOfficialPlugins.map((entry) => {
                  const rowError = officialInstallErrors.get(entry.pluginId);
                  const downloading =
                    busyOperation?.kind === "prepareOfficialInstall" &&
                    busyOperation.pluginId === entry.pluginId;
                  return (
                    <li className="plugin-manager-item" data-plugin-id={entry.pluginId} key={entry.pluginId}>
                      <div className="plugin-manager-details">
                        <div className="plugin-manager-name">{entry.displayName}</div>
                        <div className="plugin-manager-id">{entry.pluginId}</div>
                        <p>{entry.description}</p>
                        {rowError ? (
                          <p
                            className="plugin-manager-update-status is-error"
                            data-official-install-error={entry.pluginId}
                            role="alert"
                          >
                            {rowError}
                          </p>
                        ) : null}
                      </div>
                      <div className="plugin-manager-actions">
                        <button
                          className="plugin-manager-button"
                          data-action="install-official-plugin"
                          data-plugin-id={entry.pluginId}
                          disabled={busy || !canInstallOfficial}
                          onClick={() => void prepareOfficialInstall(entry.pluginId, entry.displayName)}
                          type="button"
                        >
                          {downloading ? "Downloading…" : "Install"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="plugin-manager-available-empty">All official plugins are installed.</p>
            )}
          </section>
        </div>

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
            engine={pendingNeedsEngine ? { status: recognitionEngineStatus } : undefined}
            mode="install"
            subject={pending}
            onCancel={() => {
              setPending(undefined);
              setPendingOfficialPluginId(undefined);
            }}
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

function RecognitionEngineRow({
  status,
  run,
  disabled,
  onRefresh,
  onInstall,
  onCancel,
  onUninstall
}: {
  status?: StructureRecognitionEngineStatus | null;
  run?: StructureRecognitionInstallRun;
  disabled: boolean;
  onRefresh?: () => Promise<void>;
  onInstall?: () => Promise<boolean>;
  onCancel?: () => Promise<void>;
  onUninstall?: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  /** Install was clicked and the run has not shown up yet. Only this — never the whole install — keeps
   *  the buttons busy, so Cancel install is available for as long as the install runs. */
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!onRefresh) return;
    onRefresh().catch((cause: unknown) => setError(`The engine status could not be read: ${messageOf(cause)}`));
    // Once per dialog opening; a changed callback identity is not a reason to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const perform = (action: () => Promise<unknown>, failure: string): void => {
    setWorking(true);
    setError(undefined);
    action()
      .catch((cause: unknown) => setError(`${failure}: ${messageOf(cause)}`))
      .finally(() => setWorking(false));
  };

  // A run this window did not start (or started before it was reopened) is still this install.
  // `status` is checked with `!= null` throughout: a status must never be null, but a null one must
  // degrade to "checking…" rather than take the whole window down in render.
  const installing = run?.running === true || status?.state === "installing";
  const installed = !installing && status?.state === "installed";

  useEffect(() => {
    if (installing) setStarting(false);
  }, [installing]);

  const startInstall = (install: () => Promise<boolean>): void => {
    setStarting(true);
    setError(undefined);
    // The promise settles only when the whole install ends; the run itself reports failures, so all
    // that is caught here is a call that could not start.
    install()
      .catch((cause: unknown) => setError(`The engine install could not start: ${messageOf(cause)}`))
      .finally(() => setStarting(false));
  };
  const stateText = installing
    ? "installing"
    : status == null
      ? error ? "status unavailable" : "checking…"
      : installed
        ? `installed (${formatDiskBytes(status.installed?.diskBytes ?? 0)})`
        : status.state === "unsupported"
          ? "not supported on this computer"
          : status.state === "broken"
            ? "damaged — reinstall it"
            : "not installed";
  const canInstall = !installing && status != null && status.state !== "unsupported" && !installed;
  const runError = !installing ? run?.error : undefined;
  return (
    <div className="plugin-manager-engine" data-testid="molscribe-engine-row">
      <p className="plugin-manager-update-status" data-testid="molscribe-engine-state">
        Recognition engine: {stateText}
      </p>
      {installing ? (
        <RecognitionInstallProgress
          progress={run?.progress ?? status?.progress}
          startedAt={run?.startedAt}
          phaseStartedAt={run?.phaseStartedAt}
        />
      ) : null}
      {runError && status ? (
        <p className="plugin-manager-update-status is-error" data-testid="molscribe-engine-install-error" role="alert">
          {recognitionInstallErrorMessage(runError, status)}
        </p>
      ) : null}
      {canInstall && status && onInstall ? (
        <p className="plugin-manager-update-status" data-testid="molscribe-engine-install-note">
          Downloads about 2.5 GB and needs {formatDiskBytes(status.requiredDiskBytes)} free (
          {formatDiskBytes(status.freeDiskBytes)} free now). It runs entirely on this computer.
        </p>
      ) : null}
      <div className="plugin-manager-package-actions">
        {installing && onCancel ? (
          <button
            className="plugin-manager-button"
            data-action="cancel-recognition-engine-install"
            disabled={working}
            onClick={() => perform(onCancel, "The install could not be cancelled")}
            type="button"
          >
            Cancel install
          </button>
        ) : null}
        {installed && onUninstall ? (
          <button
            className="plugin-manager-button"
            data-action="remove-recognition-engine"
            disabled={disabled || working}
            onClick={() => perform(onUninstall, "The engine could not be removed")}
            type="button"
          >
            {working ? "Removing…" : "Remove engine"}
          </button>
        ) : null}
        {canInstall && onInstall ? (
          <button
            className="plugin-manager-button"
            data-action="install-recognition-engine"
            disabled={disabled || working || starting}
            onClick={() => startInstall(onInstall)}
            type="button"
          >
            {runError || status?.state === "broken" ? "Install engine again" : "Install engine"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="plugin-manager-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What installing an engine-requiring plugin also downloads, stated before the user confirms. */
function RecognitionEngineDisclosure({ status }: { status?: StructureRecognitionEngineStatus | null }) {
  if (status?.state === "installed") {
    return (
      <p className="plugin-manager-engine-disclosure" data-testid="plugin-package-engine-disclosure">
        Its recognition engine is already installed on this computer.
      </p>
    );
  }
  if (status?.state === "unsupported") {
    return (
      <p className="plugin-manager-engine-disclosure" data-testid="plugin-package-engine-disclosure" role="alert">
        This plugin needs a local recognition engine, which this computer doesn’t support yet. The plugin will
        install, but it cannot recognize images here.
      </p>
    );
  }
  const shortOfSpace = status != null && status.freeDiskBytes < status.requiredDiskBytes;
  return (
    <div className="plugin-manager-engine-disclosure" data-testid="plugin-package-engine-disclosure">
      <p>
        <strong>Also installs the local recognition engine:</strong> a private Python, PyTorch and the MolScribe
        model — about 2.5 GB to download. It runs entirely on this computer; images never leave it.
      </p>
      <p>
        Needs {formatDiskBytes(status?.requiredDiskBytes ?? 3e9)} free.{" "}
        {status != null ? `Free now: ${formatDiskBytes(status.freeDiskBytes)}.` : "Free space: checking…"}
      </p>
      {shortOfSpace ? (
        <p className="plugin-manager-unavailable" role="alert">
          There isn’t enough free space for the engine. The plugin will still install; free up space, then use
          Install engine.
        </p>
      ) : null}
    </div>
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
  engine,
  mode,
  subject,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  currentVersion?: string;
  /** Present when installing this plugin also installs the recognition engine. */
  engine?: { status?: StructureRecognitionEngineStatus };
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

        {engine ? <RecognitionEngineDisclosure status={engine.status} /> : null}

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
    case "prepareOfficialInstall":
      return `Downloading and verifying ${operation.pluginName}…`;
    case "uninstallPlugin":
      return `Uninstalling ${operation.pluginName}…`;
    case "removeRecognitionEngine":
      return "Removing the recognition engine…";
    case "checkUpdates":
      return "Checking installed plugins for updates…";
    case "prepareUpdate":
      return `Downloading and verifying the ${operation.pluginName} update…`;
    case "applyUpdate":
      return `Updating ${operation.pluginName}…`;
  }
}

function withoutMapKey<K, V>(source: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!source.has(key)) return source;
  const next = new Map(source);
  next.delete(key);
  return next;
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
  if (cause instanceof Error) return cause.message;
  // Tauri command rejections arrive as plain `{ code, message }` objects, not Error instances.
  if (typeof cause === "object" && cause !== null && typeof (cause as { message?: unknown }).message === "string") {
    return (cause as { message: string }).message;
  }
  return String(cause);
}
