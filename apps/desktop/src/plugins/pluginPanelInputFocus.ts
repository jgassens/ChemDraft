import { isDesktopRuntime } from "../window-manager";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { isTextEditingElement } from "../editHistoryRouting";

/** Form controls borrow the keyboard; command buttons never do. Labels count as their control. */
export function panelEditableControl(target: EventTarget | null): HTMLElement | undefined {
  let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element?.closest("button")) return;
  const label = element?.closest("label");
  // A numeric label contains both a number and a range: lease the clicked control itself.
  if (!element?.closest("input, textarea, select, [contenteditable], button") &&
    label instanceof HTMLLabelElement && label.control) element = label.control;
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
const pendingPaletteShells = new WeakSet<HTMLElement>();
export const PALETTE_INPUT_FOCUS_CANCEL_EVENT = "chemdraft:palette-input-focus-cancel";

/** Covers acquisition/refocus and transient control blur, when a key has no reliable DOM target. */
export function isPaletteInputFocusPending(shell: HTMLElement | null): boolean {
  return !!shell && pendingPaletteShells.has(shell);
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

async function listenNativePanelFocus(listener: (event: NativePanelFocusEvent) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return listenCurrentWindowEvent<NativePanelFocusEvent>("chemdraft://plugin-panel-focus", ({ payload }) => listener(payload));
}

/** Palettes also accept text accessibility focus and release after control focus settles. Reports retain their
 * pointer-intent policy and ignore transient WebView2 DOM blur during native activation. */
export function installPaletteInputFocus(shell: HTMLElement): () => void {
  return installPluginPanelInputFocus(shell, undefined, undefined, undefined, true);
}

/** A trusted input click or deliberate report-text selection borrows the keyboard for a lease. */
export function installPluginPanelInputFocus(
  shell: HTMLElement,
  requestFocus: (editing: boolean, generation: number) => Promise<boolean> = requestNativeInputFocus,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  subscribeFocus: (listener: (event: NativePanelFocusEvent) => void) => Promise<() => void> = listenNativePanelFocus,
  editableFocus = false
): () => void {
  if (requestFocus === requestNativeInputFocus && isDesktopRuntime()) {
    void registerNativeInputFocus().catch((error: unknown) =>
      console.error("Could not register panel input focus:", error));
  }
  let editing = false;
  let acquiredControlFocus = false;
  let suspendingControlFocus = false;
  let leasedControl: HTMLElement | undefined;
  let selectionLease = false;
  let selectionNodes: Node[] = [];
  let selectionGesture: { pointerId: number; x: number; y: number; dragged: boolean } | undefined;
  let pointerClickTarget: EventTarget | null | undefined;
  let revision = 0;
  let leaseChain = 0;
  const nativeGenerations = new Set<number>();
  let pending = Promise.resolve();
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let controlBlurTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerActive = false;
  let disposed = false;
  const editableControl = panelEditableControl;
  const setEditing = (next: boolean, retry = false): void => {
    if (editing === next && !retry) return;
    if (editing !== next) {
      leaseChain++;
      nativeGenerations.clear();
      acquiredControlFocus = false;
    }
    editing = next;
    if (editableFocus) {
      if (next && !acquiredControlFocus) pendingPaletteShells.add(shell);
      else pendingPaletteShells.delete(shell);
    }
    const requestedChain = leaseChain;
    const requestedRevision = revision = ++nextGeneration;
    // Every request has a generation, including retries. Keep IPC serialized through native
    // completion: an old hand-back can never execute natively after a newer lease request.
    pending = pending.catch(() => undefined).then(async () => {
      if (requestedRevision !== revision) return;
      try {
        // Subscribe before acquiring: a native loss can precede the acquisition reply.
        await subscribed;
        if (requestedRevision !== revision) return;
        if (next) nativeGenerations.add(requestedRevision);
        const acquired = await requestFocus(next, requestedRevision);
        if (next && requestedChain === leaseChain) {
          if (!acquired) finish(true);
          else {
            // A settled successor supersedes old native events. Until it settles, loss of
            // its predecessor also cancels this retry and any clicks queued behind it.
            nativeGenerations.clear();
            nativeGenerations.add(requestedRevision);
            acquiredControlFocus = true;
            if (editableFocus) pendingPaletteShells.delete(shell);
            if (editableFocus && leasedControl && shell.contains(leasedControl)) leasedControl.focus();
          }
        }
      } catch (error) {
        if (next && requestedChain === leaseChain) finish(true);
        throw error;
      }
    });
    void pending.catch((error: unknown) => console.error("Could not change panel input focus:", error));
  };
  const finish = (cancelControl = false): void => {
    clearTimeout(controlBlurTimer);
    setEditing(false);
    if (editableFocus && cancelControl) leasedControl?.dispatchEvent(new Event(PALETTE_INPUT_FOCUS_CANCEL_EVENT));
    leasedControl = undefined;
    selectionGesture = undefined;
    if (selectionLease) document.getSelection()?.removeAllRanges();
    selectionLease = false;
    selectionNodes = [];
    const active = editableControl(document.activeElement);
    if (active && shell.contains(active)) active.blur();
  };
  const returnPointerFocus = (): void => {
    // WebView2 can activate its parent despite NOACTIVATE/WM_MOUSEACTIVATE. Like the
    // toolbar command route, explicitly hand back after an ordinary interaction, even
    // when there was no lease to finish. The native command checks foreground ownership.
    if (platform === "windows" && !editing) setEditing(false, true);
  };
  const reportText = (node: EventTarget | null): boolean => {
    if (editableFocus) return false;
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
    const control = editableControl(event.target);
    if (control && shell.contains(control)) {
      clearTimeout(controlBlurTimer);
      if (editableFocus && acquiredControlFocus) pendingPaletteShells.delete(shell);
      if (selectionLease) finish();
      leasedControl = control;
      // Palette multi-clicks reuse the held or pending lease. Reacquiring calls native focus
      // again and can blur WebView2 mid-click. A rejected lease already finished, so it retries.
      // Reports retain their existing per-click generation policy.
      setEditing(true, !editableFocus);
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
      if (editing && nativeGenerations.has(event.generation)) finish();
    } else checkActivation();
  };
  const focusIn = (event: FocusEvent): void => {
    const control = editableControl(event.target);
    if (control && shell.contains(control)) {
      clearTimeout(controlBlurTimer);
      if (editableFocus && acquiredControlFocus) pendingPaletteShells.delete(shell);
    }
    if (editableFocus && event.isTrusted && control && shell.contains(control) &&
      (editing || isTextEditingElement(control))) {
      leasedControl = control;
      setEditing(true);
      // Until native acquisition succeeds, the document still owns the keyboard. Never show
      // a caret in this window while typing would edit the document instead.
      if (!acquiredControlFocus) {
        // This is a lease transition, not the start/end of a React edit. In particular,
        // do not reset a spin-button press or create a draft before acquisition succeeds.
        event.stopPropagation();
        suspendingControlFocus = true;
        control.blur();
        suspendingControlFocus = false;
      }
    }
    if (editing && !selectionLease && control) leasedControl = control;
  };
  const focusOut = (event: FocusEvent): void => {
    if (editableFocus && suspendingControlFocus) {
      event.stopPropagation();
      return;
    }
    if (!editableFocus || suspendingControlFocus || !acquiredControlFocus || !editing) return;
    const next = editableControl(event.relatedTarget);
    if (next && shell.contains(next)) return;
    if (!editableControl(event.target)) return;
    if (event.relatedTarget instanceof Node) {
      finish(); // A known destination outside the palette's controls is a real departure.
      return;
    }
    // WebView2 can report focusout(null), window blur, then focusin on the same control
    // during a multi-click. Handing back immediately brings the document in front and sends
    // the next key to the drawing. Check the settled DOM focus; focusin cancels this check.
    clearTimeout(controlBlurTimer);
    pendingPaletteShells.add(shell);
    controlBlurTimer = setTimeout(() => {
      const active = editableControl(document.activeElement);
      if (!disposed && editing && !(active && shell.contains(active))) finish();
      else if (acquiredControlFocus) pendingPaletteShells.delete(shell);
    }, 0);
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (editableFocus && (!(event.target instanceof Node) || !shell.contains(event.target))) return;
    pointerClickTarget = undefined;
    const control = editableControl(event.target);
    if (!editing || event.isComposing) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation(); // Escape finishes editing; it must not close the report window.
      finish();
    } else if (selectionLease && event.isTrusted && event.key !== "Escape") {
      const copyOrSelectAll = (event.ctrlKey || event.metaKey) && !event.altKey &&
        ["c", "a"].includes(event.key.toLowerCase());
      const extending = event.shiftKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key);
      if (copyOrSelectAll || extending || ["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key)) return;
      // WebView2 scrolls non-editable selections on arrows instead of collapsing them.
      // End explicitly; suppress only scrolling defaults so the release does not move the report.
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
      }
      finish();
    } else if (!control) return;
    else if (event.key === "Enter" && (!editableFocus || isTextEditingElement(control)) &&
      (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      // Bubble after the control's commit handler; textarea/contenteditable keep multiline Enter.
      finish();
    } else if (event.key === "Tab" && !event.defaultPrevented) {
      // Palettes use browser traversal and keep the lease between all non-button controls.
      // A checkbox/slider/select must take keys too: otherwise Delete reaches the drawing
      // on both platforms. Text entry still commits on blur before traversing to the slider.
      if (editableFocus) return;
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
  const selectionChange = (): void => {
    if (selectionLease && !hasReportSelection()) finish();
  };
  // Removing a focused node need not emit focusout (including a replaced report or closed portal).
  const observer = new MutationObserver(() => {
    if (selectionLease) {
      if (selectionNodes.some((node) => !shell.contains(node))) finish();
    } else if (editing && (!leasedControl || !shell.contains(leasedControl) ||
      editableControl(leasedControl) !== leasedControl)) finish();
  });
  observer.observe(shell, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "readonly", "contenteditable", "type"] });
  shell.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointermove", pointerMove, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", cancelSelectionGesture, true);
  shell.addEventListener("click", click, true);
  shell.addEventListener("focusin", focusIn);
  shell.addEventListener("focusout", focusOut);
  // Palette controls commit/cancel through React's delegated handlers at the root above shell.
  // Finish their leases afterwards, so Escape cannot swallow the control's cancel handler.
  if (editableFocus) window.addEventListener("keydown", keyDown);
  else shell.addEventListener("keydown", keyDown);
  document.addEventListener("selectionchange", selectionChange);
  let unsubscribeFocus: (() => void) | undefined;
  const subscribed = subscribeFocus(nativeFocus).then((unsubscribe) => {
    if (disposed) unsubscribe();
    else unsubscribeFocus = unsubscribe;
  });
  void subscribed.catch((error: unknown) => console.error("Could not observe panel focus:", error));
  return () => {
    disposed = true;
    clearTimeout(activationTimer);
    clearTimeout(controlBlurTimer);
    unsubscribeFocus?.();
    observer.disconnect();
    shell.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", cancelSelectionGesture, true);
    shell.removeEventListener("click", click, true);
    shell.removeEventListener("focusin", focusIn);
    shell.removeEventListener("focusout", focusOut);
    if (editableFocus) window.removeEventListener("keydown", keyDown);
    else shell.removeEventListener("keydown", keyDown);
    document.removeEventListener("selectionchange", selectionChange);
    finish();
  };
}
