import { invoke, isTauri } from "@tauri-apps/api/core";

/** Rust owns the shared counter and the first visibility snapshot, across boxes and file panels. */
export async function acquireNativeUtilitySuspension(focusExportSessionId?: string): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => {};
  await invoke("suspend_toolset_windows", { suspended: true });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await invoke("suspend_toolset_windows", { suspended: false, ...(focusExportSessionId ? { focusExportSessionId } : {}) });
    } catch (error) {
      // Quit can refuse restoration. Keep the user's answer or the original panel failure.
      console.error("Could not restore floating windows after native dialog", error);
    }
  };
}

export async function withNativeUtilitySuspension<T>(operation: () => Promise<T>, focusExportSessionId?: string): Promise<T> {
  const release = await acquireNativeUtilitySuspension(focusExportSessionId);
  try {
    return await operation();
  } finally {
    await release();
  }
}
