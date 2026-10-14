import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { OPEN_MODAL_DIALOG_SELECTOR } from "@chemdraft/shortcut-engine";
import { acquireNativeUtilitySuspension } from "./nativeUtilitySuspension";

/** Install once in the document window, including dialogs portalled outside MainWindow's root. */
export function useInAppModalUtilitySuspension(): void {
  useEffect(() => {
    if (!isTauri()) return;
    return observeInAppModalUtilitySuspension(document);
  }, []);
}

function observeInAppModalUtilitySuspension(root: Document): () => void {
  const view = root.defaultView!;
  const dialogs = new Set(root.querySelectorAll<Element>(OPEN_MODAL_DIALOG_SELECTOR));
  let acquisition: ReturnType<typeof acquireNativeUtilitySuspension> | undefined;
  let stopped = false;

  const release = () => {
    const pending = acquisition;
    acquisition = undefined;
    // Cleanup never waits for IPC (especially during quit). If acquisition is still in flight,
    // release its successful result once it arrives. A refused acquisition owns no counter entry.
    if (pending) void pending.then((dispose) => dispose(), () => {});
  };
  const stop = () => {
    stopped = true;
    observer.disconnect();
    dialogs.clear();
    release();
  };
  const refresh = () => {
    if (stopped) return;
    try {
      let open = false;
      for (const dialog of dialogs) {
        if (!root.contains(dialog) || !dialog.matches(OPEN_MODAL_DIALOG_SELECTOR)) {
          dialogs.delete(dialog);
          continue;
        }
        if (isVisible(dialog, view)) open = true;
      }
      if (open && !acquisition) {
        acquisition = acquireNativeUtilitySuspension();
        // Keep a refused acquisition until the modal set closes: do not retry quit refusals on
        // every DOM mutation. Rust rolls back unsuccessful acquisitions itself.
        void acquisition.catch((error: unknown) => {
          console.error("Could not suspend floating windows for in-app dialog", error);
        });
      } else if (!open) {
        release();
      }
    } catch (error) {
      stop();
      console.error("Could not observe in-app modal dialogs", error);
    }
  };
  const consider = (element: Element) => {
    if (element.matches(OPEN_MODAL_DIALOG_SELECTOR)) dialogs.add(element);
    else dialogs.delete(element);
  };
  const observer = new view.MutationObserver((records) => {
    try {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.attributeName === "aria-modal" || record.attributeName === "hidden") {
            consider(record.target as Element);
          }
        } else {
          // Only scan inserted subtrees, never the whole drawing on each canvas mutation.
          for (const added of record.addedNodes) {
            if (added.nodeType !== 1) continue;
            const element = added as Element;
            consider(element);
            for (const dialog of element.querySelectorAll<Element>(OPEN_MODAL_DIALOG_SELECTOR)) dialogs.add(dialog);
          }
        }
      }
      refresh();
    } catch (error) {
      stop();
      console.error("Could not observe in-app modal dialogs", error);
    }
  });
  try {
    // Dialogs must unmount or use hidden when closed, as required by shortcut blocking. Style/class
    // observation also prevents a CSS-hidden modal (or ancestor) from holding a suspension.
    observer.observe(root, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["aria-modal", "hidden", "style", "class"]
    });
    refresh();
  } catch (error) {
    stop();
    console.error("Could not observe in-app modal dialogs", error);
  }
  return stop;
}

function isVisible(dialog: Element, view: Window): boolean {
  if (dialog.closest("[hidden]")) return false;
  const style = view.getComputedStyle(dialog);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  for (let element: Element | null = dialog; element; element = element.parentElement) {
    if (view.getComputedStyle(element).display === "none") return false;
  }
  return true;
}
