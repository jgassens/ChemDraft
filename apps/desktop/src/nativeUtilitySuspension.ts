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

/** Hold one native lease while any HTML modal is present in the document window. */
export function observeNativeUtilityModals(document: Document) {
  let present = false;
  let acquisition: Promise<() => Promise<void>> | undefined;
  let pending = Promise.resolve();
  const track = (operation: Promise<unknown>) => {
    const handled = operation.catch((error) => console.error("Could not suspend floating windows for HTML dialog", error));
    pending = Promise.all([pending, handled]).then(() => undefined);
  };
  const release = () => {
    const acquired = acquisition;
    acquisition = undefined;
    if (acquired) track(acquired.then((release) => release()));
  };
  const update = () => {
    const next = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
    if (next === present) return;
    present = next;
    if (next) {
      // Issue acquisition immediately so a native-to-HTML handoff cannot restore between them.
      acquisition = acquireNativeUtilitySuspension();
      track(acquisition);
    } else {
      release();
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal"] });
  update();
  let stopped = false;
  return {
    settled: () => pending,
    stop() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      release();
    }
  };
}
