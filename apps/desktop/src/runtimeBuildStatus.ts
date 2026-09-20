/**
 * What build the RUNNING window is actually executing, written to a file anyone can read.
 *
 * The build line in the corner of the window answers this, but only for whoever is looking at the
 * screen. Asking the dev server instead answers a different question — the server serves the newest
 * source, while the open window holds whatever the last hot reload managed to apply, and after a
 * long session those two drift apart silently. So the window states it for itself: on load, on
 * every hot update, and whenever it is brought back to the front, it writes
 * `runtime-build.json` into the app's data directory.
 *
 * `pnpm running-build` prints the file for every installed ChemDraft. Nothing reads it back into
 * the app; it exists to be read from outside.
 */

export const RUNTIME_BUILD_STATUS_FILE = "runtime-build.json";

export interface RuntimeBuildStatus {
  /** The `CURRENT_BUILD_STAMP` constant compiled into the running code. */
  buildStamp: string;
  /** The stamp Vite baked in when the dev server or bundle was built: branch, commit, time. */
  bundleStamp: string;
  /** "desktop" (Tauri) or "web" (a browser preview). */
  runtime: "desktop" | "web";
  /** Window this status came from — the main window, a palette, an inspector. */
  windowLabel: string;
  /** When this code was loaded into the window. */
  loadedAt: string;
  /** When the status was last written: a hot update, or the window coming to the front. */
  updatedAt: string;
  /** Hot updates applied since the page loaded. A high count on an old `loadedAt` is the shape of
   *  a long session, where a missed reload is most likely. */
  hotUpdates: number;
  /** What prompted this write. */
  reason: "load" | "hot-update" | "focus";
}

export interface RuntimeBuildStatusInput {
  buildStamp: string;
  bundleStamp: string;
  runtime: "desktop" | "web";
  windowLabel: string;
  loadedAt: Date;
  updatedAt: Date;
  hotUpdates: number;
  reason: RuntimeBuildStatus["reason"];
}

export function buildRuntimeBuildStatus(input: RuntimeBuildStatusInput): RuntimeBuildStatus {
  return {
    buildStamp: input.buildStamp,
    bundleStamp: input.bundleStamp,
    runtime: input.runtime,
    windowLabel: input.windowLabel,
    loadedAt: input.loadedAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
    hotUpdates: input.hotUpdates,
    reason: input.reason
  };
}

export function serializeRuntimeBuildStatus(status: RuntimeBuildStatus): string {
  return `${JSON.stringify(status, null, 2)}\n`;
}

/**
 * One line for a person or an agent: which build, how old, and whether hot reloading has been
 * carrying the session for a long time.
 */
export function describeRuntimeBuildStatus(
  status: RuntimeBuildStatus,
  now: Date = new Date()
): string {
  const ageMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(status.updatedAt)) / 60000));
  const age = ageMinutes < 1
    ? "just now"
    : ageMinutes < 60
      ? `${ageMinutes} min ago`
      : `${Math.round(ageMinutes / 60)} h ago`;
  const updates = status.hotUpdates > 0 ? `, ${status.hotUpdates} hot update${status.hotUpdates === 1 ? "" : "s"}` : "";
  return `${status.buildStamp} · ${status.bundleStamp} · ${status.windowLabel} · last seen ${age}${updates}`;
}

/**
 * Write the status where an outside reader can find it. Desktop only (a browser preview has no
 * app data directory), best effort: a diagnostic file must never be able to break the window it is
 * describing, so every failure is swallowed.
 */
export async function writeRuntimeBuildStatus(status: RuntimeBuildStatus): Promise<boolean> {
  if (status.runtime !== "desktop") {
    return false;
  }
  try {
    const { BaseDirectory, writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(RUNTIME_BUILD_STATUS_FILE, serializeRuntimeBuildStatus(status), {
      baseDir: BaseDirectory.AppData
    });
    return true;
  } catch {
    return false;
  }
}
