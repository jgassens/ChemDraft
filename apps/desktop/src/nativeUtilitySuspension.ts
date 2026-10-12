import { invoke, isTauri } from "@tauri-apps/api/core";

/** Rust owns the shared counter and the first visibility snapshot, across boxes and file panels. */
export async function acquireNativeUtilitySuspension(): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => {};
  await invoke("suspend_toolset_windows", { suspended: true });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await invoke("suspend_toolset_windows", { suspended: false });
    } catch (error) {
      // Quit can refuse restoration. Keep the user's answer or the original panel failure.
      console.error("Could not restore floating windows after native dialog", error);
    }
  };
}

export async function withNativeUtilitySuspension<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireNativeUtilitySuspension();
  try {
    return await operation();
  } finally {
    await release();
  }
}
