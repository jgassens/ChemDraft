import { isDesktopRuntime } from "../window-manager";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";

/** Only editable controls borrow the document's keyboard focus. Labels count as their control. */
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

// Survives effect teardown/reinstall in the same webview (including React StrictMode).
let nextGeneration = 0;

async function requestNativeInputFocus(editing: boolean, generation: number): Promise<boolean> {
  if (!isDesktopRuntime()) return editing;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("set_plugin_panel_input_focus", { editing, generation });
}

async function listenNativePanelFocus(listener: (event: NativePanelFocusEvent) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return listenCurrentWindowEvent<NativePanelFocusEvent>("chemdraft://plugin-panel-focus", ({ payload }) => listener(payload));
}

/** A trusted input click or deliberate report-text selection borrows the keyboard for a lease. */
export function installPluginPanelInputFocus(
  shell: HTMLElement,
  requestFocus: (editing: boolean, generation: number) => Promise<boolean> = requestNativeInputFocus,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  subscribeFocus: (listener: (event: NativePanelFocusEvent) => void) => Promise<() => void> = listenNativePanelFocus
): () => void {
  let editing = false;
  let leasedControl: HTMLElement | undefined;
  let selectionLease = false;
  let selectionNodes: Node[] = [];
  let selectionGesture: { pointerId: number; x: number; y: number; dragged: boolean } | undefined;
  let pointerClickTarget: EventTarget | null | undefined;
  let revision = 0;
  let pending = Promise.resolve();
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerActive = false;
  let disposed = false;
  const setEditing = (next: boolean, retry = false): void => {
    if (editing === next && !retry) return;
    editing = next;
    const requestedRevision = revision = ++nextGeneration;
    // Every request has a generation, including retries. Keep IPC serialized through native
    // completion: an old hand-back can never execute natively after a newer lease request.
    pending = pending.catch(() => undefined).then(async () => {
      if (requestedRevision !== revision) return;
      try {
        // Subscribe before acquiring: a native loss can precede the acquisition reply.
        await subscribed;
        if (requestedRevision !== revision) return;
        const acquired = await requestFocus(next, requestedRevision);
        if (next && requestedRevision === revision && !acquired) finish();
      } catch (error) {
        if (next && requestedRevision === revision) finish();
        throw error;
      }
    });
    void pending.catch((error: unknown) => console.error("Could not change panel input focus:", error));
  };
  const finish = (): void => {
    setEditing(false);
    leasedControl = undefined;
    selectionGesture = undefined;
    if (selectionLease) document.getSelection()?.removeAllRanges();
    selectionLease = false;
    selectionNodes = [];
    const active = panelEditableControl(document.activeElement);
    if (active && shell.contains(active)) active.blur();
  };
  const returnPointerFocus = (): void => {
    // WebView2 can activate its parent despite NOACTIVATE/WM_MOUSEACTIVATE. Like the
    // toolbar command route, explicitly hand back after an ordinary interaction, even
    // when there was no lease to finish. The native command checks foreground ownership.
    if (platform === "windows" && !editing) setEditing(false, true);
  };
  const reportText = (node: EventTarget | null): boolean => {
    const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    return !!element && shell.contains(element) &&
      !!element.closest(".plugin-report, .plugin-panel-content") &&
      !element.closest("button, a, input, textarea, select, [contenteditable], svg, canvas, [role=button]");
  };
  const hasReportSelection = (): boolean => {
    const selection = document.getSelection();
    return !!selection && !selection.isCollapsed && selection.toString().length > 0 &&
      reportText(selection.anchorNode) && reportText(selection.focusNode);
  };
  const leaseSelection = (): void => {
    if (!hasReportSelection()) return;
    leasedControl = undefined;
    selectionLease = true;
    const selection = document.getSelection()!;
    selectionNodes = [selection.anchorNode!, selection.focusNode!];
    setEditing(true);
  };
  const pointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || event.button !== 0) return;
    pointerActive = true;
    pointerClickTarget = event.target;
    selectionGesture = undefined;
    const control = panelEditableControl(event.target);
    if (control && shell.contains(control)) {
      if (selectionLease) finish();
      leasedControl = control;
      // Every trusted click gets a new generation, including retries after a rejected request.
      setEditing(true, true);
    } else {
      if (editing) finish();
      if (reportText(event.target)) {
        selectionGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
      }
    }
  };
  const pointerMove = (event: PointerEvent): void => {
    if (event.isTrusted && selectionGesture?.pointerId === event.pointerId &&
      (event.clientX !== selectionGesture.x || event.clientY !== selectionGesture.y)) {
      selectionGesture.dragged = true;
    }
  };
  const pointerUp = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    pointerActive = false;
    if (event.button === 0 && selectionGesture?.pointerId === event.pointerId) {
      if (selectionGesture.dragged || event.clientX !== selectionGesture.x || event.clientY !== selectionGesture.y) {
        leaseSelection();
      } else {
        // A double/triple click's selection is decided in click. Do not enqueue a
        // hand-back before that decision: its delayed blur could cancel the new lease.
        return;
      }
    }
    // Decide selection first. Returning focus during a report-text drag can interrupt it.
    returnPointerFocus();
    // Keep the gesture through click: double/triple clicks select text without pointer movement.
  };
  const click = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const fromPointer = event.detail > 0 && pointerClickTarget === event.target;
    pointerClickTarget = undefined;
    if (platform === "windows" && !fromPointer) return;
    if (selectionGesture && event.detail >= 2) leaseSelection();
    selectionGesture = undefined;
    // Covers activation performed by WebView2's default click handling after pointerup.
    returnPointerFocus();
  };
  const cancelSelectionGesture = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    pointerActive = false;
    pointerClickTarget = undefined;
    selectionGesture = undefined;
    returnPointerFocus();
  };
  const checkActivation = (): void => {
    if (platform !== "windows" || editing) return;
    const activatedRevision = revision;
    clearTimeout(activationTimer);
    // Native activation can precede DOM pointerdown. Allow it to establish intent; every
    // lease request, even one queued behind IPC, supersedes this activation check.
    activationTimer = setTimeout(() => {
      if (!disposed && revision === activatedRevision && !editing && !pointerActive && !selectionGesture) {
        returnPointerFocus();
      }
    }, 32);
  };
  const nativeFocus = (event: NativePanelFocusEvent): void => {
    if (disposed) return;
    if (event.kind === "deactivated") {
      // Loss is terminal even if a delayed acquisition reply says it acquired focus.
      if (editing && event.generation === revision) finish();
    } else checkActivation();
  };
  const focusIn = (event: FocusEvent): void => {
    const control = panelEditableControl(event.target);
    if (editing && !selectionLease && control) leasedControl = control;
  };
  const keyDown = (event: KeyboardEvent): void => {
    pointerClickTarget = undefined;
    const control = panelEditableControl(event.target);
    if (!editing || event.isComposing) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation(); // Escape finishes editing; it must not close the report window.
      finish();
    } else if (selectionLease && event.key === "Tab" && !event.defaultPrevented) {
      event.preventDefault();
      finish();
    } else if (!control) return;
    else if (event.key === "Enter" &&
      (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      // Bubble after the control's commit handler; textarea/contenteditable keep multiline Enter.
      finish();
    } else if (event.key === "Tab" && !event.defaultPrevented) {
      const activeModal = control.closest<HTMLElement>('[aria-modal="true"]');
      const controls = [...shell.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable]")]
        .filter((candidate) => panelEditableControl(candidate) === candidate &&
          (activeModal ? activeModal.contains(candidate) : !candidate.closest('[aria-modal="true"]')) &&
          (candidate.tabIndex >= 0 || (candidate.hasAttribute("contenteditable") && !candidate.hasAttribute("tabindex"))) &&
          !candidate.closest('[hidden], [inert]') && getComputedStyle(candidate).display !== "none" &&
          getComputedStyle(candidate).visibility !== "hidden")
        .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
      const next = controls[controls.indexOf(control) + (event.shiftKey ? -1 : 1)];
      event.preventDefault();
      if (next) next.focus();
      else finish();
    }
  };
  // Removing a focused node need not emit focusout (including a replaced report or closed portal).
  const observer = new MutationObserver(() => {
    if (selectionLease) {
      if (selectionNodes.some((node) => !shell.contains(node))) finish();
    } else if (editing && (!leasedControl || !shell.contains(leasedControl) ||
      panelEditableControl(leasedControl) !== leasedControl)) finish();
  });
  observer.observe(shell, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "readonly", "contenteditable", "type"] });
  shell.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointermove", pointerMove, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", cancelSelectionGesture, true);
  shell.addEventListener("click", click, true);
  shell.addEventListener("focusin", focusIn);
  shell.addEventListener("keydown", keyDown);
  let unsubscribeFocus: (() => void) | undefined;
  const subscribed = subscribeFocus(nativeFocus).then((unsubscribe) => {
    if (disposed) unsubscribe();
    else unsubscribeFocus = unsubscribe;
  });
  void subscribed.catch((error: unknown) => console.error("Could not observe panel focus:", error));
  return () => {
    disposed = true;
    clearTimeout(activationTimer);
    unsubscribeFocus?.();
    observer.disconnect();
    shell.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", cancelSelectionGesture, true);
    shell.removeEventListener("click", click, true);
    shell.removeEventListener("focusin", focusIn);
    shell.removeEventListener("keydown", keyDown);
    finish();
  };
}
