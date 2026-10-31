import { isDesktopRuntime, listenForToolsetCommandSpecs, TOOLSET_COMMAND_SPECS_REQUEST_EVENT } from "../window-manager";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createDesktopShortcutRegistry, detectDesktopShortcutPlatform } from "../keyboardShortcuts";

/** Editable controls handle their own keys. Labels count as their control. */
export function panelEditableControl(target: EventTarget | null): HTMLElement | undefined {
  let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const label = element?.closest("label");
  if (label instanceof HTMLLabelElement && label.control) element = label.control;
  const control = element?.closest("input, textarea, select, [contenteditable]");
  if (!(control instanceof HTMLElement) || control.matches(":disabled")) return;
  if (control instanceof HTMLInputElement) {
    if (control.readOnly || ["hidden", "button", "submit", "reset", "image"].includes(control.type)) return;
    return control;
  }
  if (control instanceof HTMLTextAreaElement) return control.readOnly ? undefined : control;
  if (control instanceof HTMLSelectElement) return control;
  const editable = control.getAttribute("contenteditable");
  return editable === "" || editable === "true" || editable === "plaintext-only" ? control : undefined;
}

export interface NativePanelFocusEvent {
  kind: "activated" | "deactivated";
  generation: number;
}

// Survives effect teardown/reinstall (including React StrictMode). Native bookkeeping
// resets at PageLoadEvent::Started when a reload creates a fresh JS counter.
let nextGeneration = 0;
let pageToken: Promise<string> | undefined;
const deactivationListeners = new Set<() => void>();

/** Consumers share the input handler's generation check instead of interpreting raw focus events. */
export function listenPanelDeactivation(listener: () => void): () => void {
  deactivationListeners.add(listener);
  return () => { deactivationListeners.delete(listener); };
}

function registerNativeInputFocus(): Promise<string> {
  // Register once per JS page, including across StrictMode effect reinstalls. Never
  // refresh a stale token: delayed requests must retain their originating page.
  return pageToken ??= import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<string>("register_plugin_panel_input_focus"));
}

async function requestNativeInputFocus(editing: boolean, generation: number): Promise<boolean> {
  if (!isDesktopRuntime()) return editing;
  const token = await registerNativeInputFocus();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("set_plugin_panel_input_focus", { editing, generation, pageToken: token });
}

export async function listenNativePanelFocus(listener: (event: NativePanelFocusEvent) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return listenCurrentWindowEvent<NativePanelFocusEvent>("chemdraft://plugin-panel-focus", ({ payload }) => listener(payload));
}

export interface PanelShortcutHandler {
  resolve(event: KeyboardEvent): string | undefined;
  forward(commandId: string): void;
}

/** A trusted click keeps the panel key until native deactivation, independently of DOM editing. */
export function installPluginPanelInputFocus(
  shell: HTMLElement,
  requestFocus: (editing: boolean, generation: number) => Promise<boolean> = requestNativeInputFocus,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  subscribeFocus: (listener: (event: NativePanelFocusEvent) => void) => Promise<() => void> = listenNativePanelFocus,
  shortcuts?: PanelShortcutHandler
): () => void {
  if (requestFocus === requestNativeInputFocus && isDesktopRuntime()) {
    void registerNativeInputFocus().catch((error: unknown) =>
      console.error("Could not register panel input focus:", error));
  }
  let focused = false;
  let revision = 0;
  let disposed = false;
  let pending = Promise.resolve();
  let requestedFocus = false;
  const setFocused = (next: boolean): void => {
    focused = next;
    const generation = revision = ++nextGeneration;
    pending = pending.catch(() => undefined).then(async () => {
      await subscribed;
      if (revision !== generation) return;
      if (next) requestedFocus = true;
      let acquired: boolean;
      try {
        acquired = await requestFocus(next, generation);
      } catch (error) {
        if (revision === generation) {
          focused = false;
        }
        throw error;
      }
      if (revision !== generation) return;
      if (next && !acquired) {
        focused = false;
        clearInteraction();
      }
    });
    void pending.catch((error: unknown) => console.error("Could not change panel input focus:", error));
  };
  const blurControl = (): void => {
    const active = panelEditableControl(document.activeElement);
    if (active && shell.contains(active)) active.blur();
  };
  const clearInteraction = (): void => {
    blurControl();
    document.getSelection()?.removeAllRanges();
    for (const listener of deactivationListeners) listener();
  };
  const nativeFocus = (event: NativePanelFocusEvent): void => {
    if (disposed || event.kind !== "deactivated") return;
    if (focused && (event.generation === revision || !requestedFocus)) {
      setFocused(false);
      clearInteraction();
    }
  };
  let registry: ReturnType<typeof createDesktopShortcutRegistry> | undefined;
  const shortcutHandler = shortcuts ?? {
    resolve: (event: KeyboardEvent) => registry?.resolve(event),
    forward: (commandId: string) => {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("plugin_panel_event_forward", {
          event: "chemdraft://plugin-panel-shortcut", payload: { commandId }
        })).catch((error: unknown) => console.error("Could not forward panel shortcut:", error));
    }
  };
  let unsubscribeCommands: (() => void) | undefined;
  if (!shortcuts && isDesktopRuntime()) {
    // Reuse the document's live, scheme-mapped command catalog, including enabled state.
    void listenForToolsetCommandSpecs((commands) => {
      registry = createDesktopShortcutRegistry(commands.filter((command) =>
        command.id !== "document.closeTab" && !command.id.startsWith("document.closeTab.")), platform);
    }).then(async (unsubscribe) => {
      if (disposed) { unsubscribe(); return; }
      unsubscribeCommands = unsubscribe;
      const { invoke } = await import("@tauri-apps/api/core");
      if (!disposed) await invoke("plugin_panel_event_forward", {
        event: TOOLSET_COMMAND_SPECS_REQUEST_EVENT, payload: {}
      });
    }).catch((error: unknown) => console.error("Could not observe panel shortcuts:", error));
  }
  const pointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || !shell.contains(event.target as Node)) return;
    // Native pointer activation has already made the window key. This request only focuses
    // its webview, and native code refuses it if the user has since switched windows.
    // A new native activation can precede delivery of the previous loss notification.
    // Fence it off immediately, even if JS still thinks the preceding episode is focused.
    setFocused(true);
  };
  const hasReportSelection = (): boolean => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return false;
    // A drag can extend into panel chrome; protect any range intersecting the report.
    return [...shell.querySelectorAll(".plugin-report, .plugin-panel-content")].some((report) => {
      for (let i = 0; i < selection.rangeCount; i++) {
        if (selection.getRangeAt(i).intersectsNode(report)) return true;
      }
      return false;
    });
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const control = panelEditableControl(event.target);
    const menu = shell.querySelector('[role="menu"][data-plugin-panel-input-menu="true"]');
    const reload = event.key === "F5" || event.key === "BrowserRefresh" ||
      (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
    if (reload && (control || menu || hasReportSelection())) {
      event.preventDefault();
      return;
    }
    // Native close accelerators belong to this panel, including while a control/menu owns keys.
    if ((platform === "macos" && event.metaKey && event.key.toLowerCase() === "w") ||
      (platform === "windows" && event.altKey && event.key === "F4")) return;
    if (menu) return;
    if (control) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        blurControl();
      } else if (event.key === "Enter" &&
        (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
        blurControl();
      } else if (event.key === "Tab") {
        const modal = control.closest('[aria-modal="true"]');
        const controls = [...shell.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable]")]
          .filter((candidate) => panelEditableControl(candidate) === candidate &&
            (modal ? modal.contains(candidate) : !candidate.closest('[aria-modal="true"]')) &&
            (candidate.tabIndex >= 0 || (candidate.hasAttribute("contenteditable") && !candidate.hasAttribute("tabindex"))) &&
            !candidate.closest("[hidden], [inert]") && getComputedStyle(candidate).display !== "none" &&
            getComputedStyle(candidate).visibility !== "hidden")
          .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
        event.preventDefault();
        const next = controls[controls.indexOf(control) + (event.shiftKey ? -1 : 1)];
        if (next) next.focus();
        else blurControl();
      }
      return;
    }
    if (hasReportSelection()) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["c", "a"].includes(event.key.toLowerCase())) return;
      if (["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key) ||
        (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key))) return;
      document.getSelection()?.removeAllRanges();
      // The key ending a report selection belongs to the panel, including cut/paste,
      // history and destructive commands. It must never act on selected chemistry.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target instanceof Element && event.target.closest("button, a, [role=button]") &&
      ["Enter", " ", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    if (!event.isTrusted) {
      if (reload) event.preventDefault();
      return;
    }
    const commandId = shortcutHandler.resolve(event);
    if (commandId && commandId !== "document.closeTab" && !commandId.startsWith("document.closeTab.")) {
      event.preventDefault();
      shortcutHandler.forward(commandId);
    } else if (reload) event.preventDefault();
  };
  shell.addEventListener("pointerdown", pointerDown, true);
  shell.addEventListener("keydown", keyDown);
  let unsubscribeFocus: (() => void) | undefined;
  const subscribed = subscribeFocus(nativeFocus).then((unsubscribe) => {
    if (disposed) unsubscribe();
    else unsubscribeFocus = unsubscribe;
  });
  void subscribed.catch((error: unknown) => console.error("Could not observe panel focus:", error));
  return () => {
    disposed = true;
    unsubscribeFocus?.();
    unsubscribeCommands?.();
    shell.removeEventListener("pointerdown", pointerDown, true);
    shell.removeEventListener("keydown", keyDown);
    if (focused) setFocused(false);
  };
}
