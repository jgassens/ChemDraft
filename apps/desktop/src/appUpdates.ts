/**
 * Windows app updates (macOS uses Sparkle; see docs/releasing/windows-updates.md).
 *
 * The native half is `tauri-plugin-updater`: it fetches the signed manifest committed on `main`
 * (`latest.json`, the counterpart of the macOS `appcast.xml`), verifies the installer against the
 * public key in `tauri.windows.conf.json`, and runs the NSIS installer in passive mode, which
 * relaunches ChemDraft when it finishes. This module is the rest: when to check, what to ask, and —
 * the part that matters most — saving the open document before the installer takes over, because on
 * Windows `install()` ends the process with `exit(0)` and never reaches the normal quit flush.
 *
 * Behaviour matches the macOS updater: at most one automatic check a day, never a silent install,
 * and File ▸ Check for Updates… for a check on demand.
 */

/** Only the released app updates itself. A branch build ("ChemDraft (dev)", its own identifier) or a
 *  `pnpm dev` session must never replace itself with a release. */
export const STABLE_APP_IDENTIFIER = "org.chemdraft.desktop";
/** The native File-menu item's id; macOS answers it with Sparkle, Windows routes it here. */
export const APP_CHECK_FOR_UPDATES_COMMAND_ID = "app.checkForUpdates";
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Delay before the launch check, so it never competes with startup work (session restore, plugins). */
export const AUTO_CHECK_DELAY_MS = 15_000;
export const LAST_AUTO_CHECK_STORAGE_KEY = "chemdraft.appUpdates.lastCheckedAt";

export interface UpdateBuildInfo {
  isDesktop: boolean;
  platform: string;
  identifier: string | undefined;
  /** Vite dev server (`pnpm dev`). */
  isDevServer: boolean;
}

/** Whether this build has an update channel at all (the menu item exists on Windows desktop). */
export function appUpdatesSupported(info: Pick<UpdateBuildInfo, "isDesktop" | "platform">): boolean {
  return info.isDesktop && info.platform === "windows";
}

/** Whether this particular build may check: supported, released, and not a dev or branch build. */
export function appUpdateChecksAllowed(info: UpdateBuildInfo): boolean {
  return appUpdatesSupported(info) && !info.isDevServer && info.identifier === STABLE_APP_IDENTIFIER;
}

/** An automatic check is due when none has succeeded within the interval. A timestamp from the future
 *  (clock moved back) counts as due rather than suppressing checks until the clock catches up. */
export function autoCheckDue(lastCheckedAt: number | undefined, now: number, intervalMs = AUTO_CHECK_INTERVAL_MS): boolean {
  if (lastCheckedAt === undefined || !Number.isFinite(lastCheckedAt) || lastCheckedAt > now) {
    return true;
  }
  return now - lastCheckedAt >= intervalMs;
}

export function updatePromptText(update: { version: string; currentVersion: string; body?: string }): string {
  const notes = update.body?.trim();
  return [
    `ChemDraft ${update.version} is available — you have ${update.currentVersion}.`,
    notes ? `\n${notes}\n` : "",
    "Download and install it now? ChemDraft saves your document, closes, and reopens when the update finishes."
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function downloadProgressLabel(version: string, received: number, total: number | undefined): string {
  const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  if (total && total > 0) {
    const percent = Math.min(100, Math.floor((received / total) * 100));
    return `Downloading ChemDraft ${version}: ${percent}% (${megabytes(received)} of ${megabytes(total)} MB)`;
  }
  return `Downloading ChemDraft ${version}: ${megabytes(received)} MB`;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** The slice of the plugin's `Update` this flow uses. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body?: string;
  download(onEvent?: (event: UpdateDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateFlowDeps {
  check(): Promise<AvailableUpdate | null>;
  confirm(text: string, options: { title: string; okLabel: string; cancelLabel: string }): Promise<boolean>;
  message(text: string, options: { title: string; kind: "info" | "error" }): Promise<void>;
  setStatus(text: string): void;
  /** Write the document session to disk now. Rejects if it could not be saved. */
  flushSession(): Promise<void>;
}

export type UpdateFlowOutcome = "up-to-date" | "declined" | "installing" | "check-failed" | "install-failed";

const DIALOG_TITLE = "ChemDraft Update";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One update check. `manual` (the menu) reports every result; `automatic` (the daily launch check)
 * speaks up only when there is an update, so an offline launch stays quiet.
 */
export async function runUpdateFlow(mode: "manual" | "automatic", deps: UpdateFlowDeps): Promise<UpdateFlowOutcome> {
  let update: AvailableUpdate | null;
  try {
    update = await deps.check();
  } catch (error) {
    if (mode === "manual") {
      await deps.message(`Could not check for updates: ${errorText(error)}`, { title: DIALOG_TITLE, kind: "error" });
    } else {
      console.warn("Automatic update check failed:", error);
    }
    return "check-failed";
  }

  if (!update) {
    if (mode === "manual") {
      await deps.message("You're running the latest version of ChemDraft.", { title: DIALOG_TITLE, kind: "info" });
    }
    return "up-to-date";
  }

  let accepted: boolean;
  try {
    accepted = await deps.confirm(updatePromptText(update), {
      title: DIALOG_TITLE,
      okLabel: "Install and Restart",
      cancelLabel: "Later"
    });
  } catch (error) {
    // The prompt itself failed (dialog plugin error, window closing). Nothing was installed; release
    // the native update handle, which nothing else would, and let the next check ask again.
    console.warn("Update prompt failed:", error);
    await update.close().catch(() => undefined);
    return "check-failed";
  }
  if (!accepted) {
    await update.close().catch(() => undefined);
    return "declined";
  }

  try {
    let received = 0;
    let total: number | undefined;
    deps.setStatus(downloadProgressLabel(update.version, 0, undefined));
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        deps.setStatus(downloadProgressLabel(update.version, received, total));
      }
    });
    // The installer ends this process. Anything not on disk now is gone, so a failed save stops the
    // update rather than risking the document.
    deps.setStatus(`Saving your document before installing ChemDraft ${update.version}…`);
    await deps.flushSession();
    deps.setStatus(`Installing ChemDraft ${update.version}…`);
    await update.install();
    return "installing";
  } catch (error) {
    deps.setStatus(`ChemDraft ${update.version} was not installed`);
    await deps.message(`ChemDraft ${update.version} could not be installed: ${errorText(error)}`, {
      title: DIALOG_TITLE,
      kind: "error"
    });
    await update.close().catch(() => undefined);
    return "install-failed";
  }
}

/** Per-machine convenience state, so it lives in localStorage (and may be lost, which only means an
 *  extra check). */
export function readLastAutoCheck(storage: Pick<Storage, "getItem"> | undefined): number | undefined {
  try {
    const value = storage?.getItem(LAST_AUTO_CHECK_STORAGE_KEY);
    return value ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastAutoCheck(storage: Pick<Storage, "setItem"> | undefined, at: number): void {
  try {
    storage?.setItem(LAST_AUTO_CHECK_STORAGE_KEY, String(at));
  } catch {
    // Storage unavailable: the next launch simply checks again.
  }
}

/** `window.localStorage`, or undefined where reading it throws (private mode, blocked site data). */
export function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** This build's identity, read from the running app. The identifier is the bundle identifier Tauri
 *  was built with, which is how a branch build ("ChemDraft (dev)") is told apart from a release. */
export async function currentUpdateBuildInfo(isDesktop: boolean, platform: string): Promise<UpdateBuildInfo> {
  let identifier: string | undefined;
  if (isDesktop) {
    try {
      const { getIdentifier } = await import("@tauri-apps/api/app");
      identifier = await getIdentifier();
    } catch {
      identifier = undefined;
    }
  }
  return { isDesktop, platform, identifier, isDevServer: import.meta.env.DEV };
}

/** The real dependencies: the updater plugin, the dialog plugin, and the app's own status/session. */
export function tauriUpdateFlowDeps(app: Pick<UpdateFlowDeps, "setStatus" | "flushSession">): UpdateFlowDeps {
  return {
    ...app,
    check: async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      return check();
    },
    confirm: async (text, options) => {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      return confirm(text, { ...options, kind: "info" });
    },
    message: async (text, options) => {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(text, options);
    }
  };
}
