import { isDesktopRuntime } from "../window-manager";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { isTextEditingElement } from "../editHistoryRouting";
import { isDisabledPaletteTypingKey, isPendingPaletteEditingKey, listenPaletteClickPending } from "../palettePendingKeys";

/** Form controls borrow the keyboard; command buttons never do. Labels count as their control. */
export function panelEditableControl(target: EventTarget | null, includeDisabled = false): HTMLElement | undefined {
  let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element?.closest("button")) return;
  const label = element?.closest("label");
  // A numeric label contains both a number and a range: lease the clicked control itself.
  if (!element?.closest("input, textarea, select, [contenteditable]") &&
    label instanceof HTMLLabelElement && label.control) element = label.control;
  const control = element?.closest("input, textarea, select, [contenteditable]");
  if (!(control instanceof HTMLElement) || (!includeDisabled && control.matches(":disabled"))) return;
  if (control instanceof HTMLInputElement) {
    if (control.readOnly || ["hidden", "button", "submit", "reset", "image"].includes(control.type)) return;
    return control;
  }
  if (control instanceof HTMLTextAreaElement) return control.readOnly ? undefined : control;
  if (control instanceof HTMLSelectElement) return control;
  const editable = control.getAttribute("contenteditable");
  return editable === "" || editable === "true" || editable === "plaintext-only" ? control : undefined;
}

/** Disabled inputs have pointer-events:none; WebKit sends the press to the wrapper. */
export function disabledControlAtPointer(
  shell: HTMLElement, event: Pick<PointerEvent, "target" | "clientX" | "clientY">
): HTMLElement | undefined {
  const selector = "input:disabled, textarea:disabled, select:disabled";
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !shell.contains(target) || target.closest("button")) return;
  const direct = target.closest<HTMLElement>(selector);
  if (direct) return direct;
  // Prefer geometry when a label wraps more than one field (number plus slider).
  const controls = [...shell.querySelectorAll<HTMLElement>(selector)];
  const hit = controls.find((control) => {
    const rect = control.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left &&
      event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  if (hit) return hit;
  // Accessible labels and single-control wrappers count as the field. A section
  // or palette background containing disabled descendants must still be draggable.
  const label = target.closest("label");
  if (label && shell.contains(label)) return label.querySelector<HTMLElement>(selector) ?? undefined;
  if (target === shell) return;
  const children = [...target.children].filter((child) => child.matches("input, textarea, select"));
  const child = children.length === 1 ? children[0] : undefined;
  return child instanceof HTMLElement && child.matches(selector) ? child : undefined;
}

/** Match the palette's native drag surfaces, including customize mode and disabled fields. */
export function isPaletteWindowDragPress(
  shell: HTMLElement, event: Pick<PointerEvent, "target" | "clientX" | "clientY" | "button" | "isPrimary">
): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return event.button === 0 && event.isPrimary !== false && !!target && shell.contains(target) &&
    !target.closest("button, select, input, textarea, [data-palette-control]") &&
    !disabledControlAtPointer(shell, event) &&
    !!target.closest('[data-palette-title-drag-surface="true"], [data-palette-drag-surface="true"]');
}

export interface NativePanelFocusEvent {
  kind: "activated" | "deactivated";
  generation: number;
  reason?: "window" | "outside" | "app" | "hide";
}

// Survives effect teardown/reinstall (including React StrictMode). Native bookkeeping
// resets at PageLoadEvent::Started when a reload creates a fresh JS counter.
let nextGeneration = 0;
let pageToken: Promise<string> | undefined;
const pendingPaletteShells = new WeakSet<HTMLElement>();
const paletteControls = new WeakMap<HTMLElement, HTMLElement>();
export const PALETTE_INPUT_FOCUS_COMMIT_EVENT = "chemdraft:palette-input-focus-commit";
export const PALETTE_INPUT_FOCUS_CANCEL_EVENT = "chemdraft:palette-input-focus-cancel";

/** Covers acquisition/refocus and transient control blur, when a key has no reliable DOM target. */
export function isPaletteInputFocusPending(shell: HTMLElement | null): boolean {
  return !!shell && pendingPaletteShells.has(shell);
}

/** The leased destination also owns keys temporarily targeted at body by the webview. */
export function paletteInputFocusControl(shell: HTMLElement | null): HTMLElement | undefined {
  const control = shell ? paletteControls.get(shell) : undefined;
  return control && shell?.contains(control) ? control : undefined;
}

function registerNativeInputFocus(): Promise<string> {
  // Register once per JS page, including across StrictMode effect reinstalls. Never
  // refresh a stale token: delayed requests must retain their originating page.
  return pageToken ??= import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<string>("register_plugin_panel_input_focus"));
}

async function requestNativeInputFocus(
  editing: boolean, generation: number, clickSequence?: number, pointerBefore?: number, returnFocus = false,
  selectInteraction = false
): Promise<boolean> {
  if (!isDesktopRuntime()) return editing;
  const token = await registerNativeInputFocus();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("set_plugin_panel_input_focus", {
    editing, generation, pageToken: token, clickSequence, pointerBefore, returnFocus,
    ...(selectInteraction ? { selectInteraction: true } : {})
  });
}

async function listenNativePanelFocus(listener: (event: NativePanelFocusEvent) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return listenCurrentWindowEvent<NativePanelFocusEvent>("chemdraft://plugin-panel-focus", ({ payload }) => listener(payload));
}

/** Palettes also accept text accessibility focus and release after control focus settles. Reports retain their
 * pointer-intent policy and ignore transient WebView2 DOM blur during native activation.
 * keepWindowFocus exempts an intentional Focus-mode reveal from idle/pointer hand-back until hidden. */
export function installPaletteInputFocus(
  shell: HTMLElement, platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  menuShortcut: (event: KeyboardEvent) => boolean = () => false,
  keepWindowFocus: () => boolean = () => false
): () => void {
  return installPluginPanelInputFocus(shell, undefined, platform, undefined, true, menuShortcut, keepWindowFocus);
}

/** A trusted input click or deliberate report-text selection borrows the keyboard for a lease. */
export function installPluginPanelInputFocus(
  shell: HTMLElement,
  requestFocus: (editing: boolean, generation: number) => Promise<boolean> = requestNativeInputFocus,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  subscribeFocus: (listener: (event: NativePanelFocusEvent) => void) => Promise<() => void> = listenNativePanelFocus,
  editableFocus = false,
  menuShortcut: (event: KeyboardEvent) => boolean = () => false,
  keepWindowFocus: () => boolean = () => false
): () => void {
  const editableControl = (target: EventTarget | null) => panelEditableControl(target, editableFocus);
  // Disabled controls cannot take DOM focus. Their palette is a keyboard sink instead.
  const originalTabIndex = shell.getAttribute("tabindex");
  if (editableFocus && originalTabIndex === null) shell.tabIndex = -1;
  if (requestFocus === requestNativeInputFocus && isDesktopRuntime()) {
    void registerNativeInputFocus().catch((error: unknown) =>
      console.error("Could not register panel input focus:", error));
  }
  let clickSequence: number | undefined;
  let latestClickSequence = 0;
  let unsubscribePointer: (() => void) | undefined;
  const pointerSubscribed = editableFocus && isDesktopRuntime() ? listenPaletteClickPending((event) => {
    if (disposed || event.sequence < latestClickSequence ||
      (event.sequence === latestClickSequence && clickSequence === undefined)) return;
    latestClickSequence = event.sequence;
    clickSequence = event.pending ? event.sequence : undefined;
  }).then((unsubscribe) => {
    if (disposed) unsubscribe();
    else unsubscribePointer = unsubscribe;
  }) : Promise.resolve();
  void pointerSubscribed.catch((error: unknown) => console.error("Could not observe palette clicks:", error));
  let editing = false;
  let acquiredControlFocus = false;
  let suspendingControlFocus = false;
  let leasedControl: HTMLElement | undefined;
  let openSelect: HTMLSelectElement | undefined;
  let selectSuspended = false;
  let nativeSelectInteraction = false;
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
  let pointerFocusTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerControl: HTMLElement | undefined;
  let pointerActive = false;
  let pointerClassificationBefore: number | undefined;
  let disposed = false;
  const focusLeasedControl = (): void => {
    if (selectSuspended && openSelect) return; // Do not dismiss an AppKit tracking menu.
    if (editableFocus && acquiredControlFocus && leasedControl && shell.contains(leasedControl)) {
      const destination = leasedControl.matches(":disabled") ? shell : leasedControl;
      if (document.activeElement !== destination) destination.focus({ preventScroll: true });
    }
  };
  const setEditing = (next: boolean, retry = false, pointerBefore?: number, returnFocus = false): void => {
    const selectInteraction = next && editableFocus && platform === "macos" &&
      leasedControl instanceof HTMLSelectElement && !leasedControl.disabled;
    retry ||= selectInteraction !== nativeSelectInteraction;
    if (editing === next && !retry) return;
    nativeSelectInteraction = selectInteraction;
    if (editing !== next) {
      leaseChain++;
      nativeGenerations.clear();
      acquiredControlFocus = false;
    }
    editing = next;
    if (editableFocus) {
      if (next && !acquiredControlFocus) pendingPaletteShells.add(shell);
      else pendingPaletteShells.delete(shell);
      if (next) shell.dataset.paletteInputFocus = acquiredControlFocus ? "held" : "pending";
      else delete shell.dataset.paletteInputFocus;
    }
    // Capture before queueing IPC, never when the queued release eventually runs.
    const requestedClick = clickSequence;
    // Only pointer classification supplies a timestamp fallback. Escape, blur and
    // observer cleanup must not acknowledge a click whose sequence is still in flight.
    const requestedChain = leaseChain;
    const requestedRevision = revision = ++nextGeneration;
    // Every request has a generation, including retries. Keep IPC serialized through native
    // completion: an old hand-back can never execute natively after a newer lease request.
    pending = pending.catch(() => undefined).then(async () => {
      if (requestedRevision !== revision) return;
      try {
        // Subscribe before acquiring: a native loss can precede the acquisition reply.
        await subscribed;
        await pointerSubscribed.catch(() => undefined);
        if (requestedRevision !== revision) return;
        if (next) nativeGenerations.add(requestedRevision);
        const acquired = await (requestFocus === requestNativeInputFocus
          ? requestNativeInputFocus(next, requestedRevision, requestedClick, pointerBefore, returnFocus, selectInteraction)
          : requestFocus(next, requestedRevision));
        if (next && requestedChain === leaseChain) {
          if (!acquired) finish(true, false, undefined, false);
          else {
            // A settled successor supersedes old native events. Until it settles, loss of
            // its predecessor also cancels this retry and any clicks queued behind it.
            nativeGenerations.clear();
            nativeGenerations.add(requestedRevision);
            acquiredControlFocus = true;
            if (editableFocus) {
              pendingPaletteShells.delete(shell);
              shell.dataset.paletteInputFocus = "held";
            }
            focusLeasedControl();
            if (!pointerActive && !pointerClickTarget && pointerFocusTimer === undefined) pointerControl = undefined;
          }
        }
      } catch (error) {
        if (next && requestedChain === leaseChain) finish(true, false, undefined, false);
        throw error;
      }
    });
    void pending.catch((error: unknown) => console.error("Could not change panel input focus:", error));
  };
  const finish = (cancelControl = false, preserveNativeChooser = false, pointerBefore?: number, returnFocus = true): void => {
    openSelect = undefined;
    selectSuspended = false;
    clearTimeout(controlBlurTimer);
    clearTimeout(pointerFocusTimer);
    pointerFocusTimer = undefined;
    pointerControl = undefined;
    paletteControls.delete(shell);
    setEditing(false, false, pointerBefore, returnFocus);
    if (editableFocus && cancelControl) leasedControl?.dispatchEvent(new Event(PALETTE_INPUT_FOCUS_CANCEL_EVENT));
    leasedControl = undefined;
    selectionGesture = undefined;
    if (selectionLease) document.getSelection()?.removeAllRanges();
    selectionLease = false;
    selectionNodes = [];
    const active = panelEditableControl(document.activeElement);
    // A colour/select chooser may itself have taken native focus. Blurring its owner can
    // dismiss it before the pick arrives; text entry still blurs so no inactive caret remains.
    const nativeChooser = active instanceof HTMLSelectElement ||
      (active instanceof HTMLInputElement && active.type === "color");
    if (active && shell.contains(active) && !(preserveNativeChooser && nativeChooser)) active.blur();
  };
  const returnPointerFocus = (pointerBefore?: number): void => {
    // A keyboard-opened E/Z popover owns focus for its whole reveal, without a
    // control lease. Activation and button clicks must not undo that explicit intent.
    if (keepWindowFocus()) return;
    // WebView2 can activate its parent despite NOACTIVATE/WM_MOUSEACTIVATE. Like the
    // toolbar command route, explicitly hand back after an ordinary interaction, even
    // when there was no lease to finish. The native command checks foreground ownership.
    if ((platform === "windows" || editableFocus) && !editing) setEditing(false, true, pointerBefore, true);
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
    clearTimeout(pointerFocusTimer);
    pointerFocusTimer = undefined;
    pointerActive = true;
    pointerClassificationBefore = Date.now();
    pointerClickTarget = event.target;
    selectionGesture = undefined;
    const control = (editableFocus ? disabledControlAtPointer(shell, event) : undefined) ?? editableControl(event.target);
    if (control && shell.contains(control)) {
      // WebKit may deliver the list-closing Escape to the page. Retain this
      // intent through popup blur/key loss too; WebView2 consumes it in its popup.
      openSelect = platform === "macos" && control instanceof HTMLSelectElement && !control.disabled ? control : undefined;
      clearTimeout(controlBlurTimer);
      if (editableFocus && acquiredControlFocus) pendingPaletteShells.delete(shell);
      if (selectionLease) finish(false, false, pointerClassificationBefore);
      leasedControl = control;
      if (editableFocus) {
        pointerControl = control;
        paletteControls.set(shell, control);
      }
      // Palette multi-clicks reuse the held or pending lease. Reacquiring calls native focus
      // again and can blur WebView2 mid-click. A rejected lease already finished, so it retries.
      // Reports retain their existing per-click generation policy.
      setEditing(true, !editableFocus, pointerClassificationBefore);
    } else {
      // Only Windows has WM_EXITSIZEMOVE to return foreground after Tao's modal drag.
      // macOS must retain its pointerdown hand-back or the palette remains key.
      const startsDrag = platform === "windows" && editableFocus && isPaletteWindowDragPress(shell, event);
      if (editing) finish(false, false, pointerClassificationBefore, !startsDrag);
      else if (startsDrag) setEditing(false, true, pointerClassificationBefore, false);
      else if (editableFocus) returnPointerFocus(pointerClassificationBefore);
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
    returnPointerFocus(pointerClassificationBefore);
    // Keep the gesture through click: double/triple clicks select text without pointer movement.
  };
  const click = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const fromPointer = event.detail > 0 && pointerClickTarget === event.target;
    pointerClickTarget = undefined;
    if (platform === "windows" && !fromPointer) return;
    if (editableFocus && fromPointer && pointerControl) {
      // WebKit does not focus checkbox/radio/range (and some select/colour) clicks.
      // Wait for the click default, which may itself put focus on body. Never cancel it:
      // colour inputs need that default to open their native picker.
      clearTimeout(pointerFocusTimer);
      pointerFocusTimer = setTimeout(() => {
        pointerFocusTimer = undefined;
        if (disposed || !editing || pointerControl !== leasedControl) return;
        focusLeasedControl();
        if (acquiredControlFocus) pointerControl = undefined;
      }, 0);
    }
    if (selectionGesture && event.detail >= 2) leaseSelection();
    selectionGesture = undefined;
    // Covers activation performed by WebView2's default click handling after pointerup.
    returnPointerFocus(fromPointer ? pointerClassificationBefore : undefined);
    pointerClassificationBefore = undefined;
  };
  const cancelSelectionGesture = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    pointerActive = false;
    pointerClickTarget = undefined;
    pointerControl = undefined;
    selectionGesture = undefined;
    returnPointerFocus(pointerClassificationBefore);
    pointerClassificationBefore = undefined;
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
      if (editing && nativeGenerations.has(event.generation) && nativeSelectInteraction &&
        (event.reason === undefined || event.reason === "window")) {
        // Losing key status to AppKit's popup is not a click away. Native code
        // keeps this select eligible to regain key status when tracking ends.
        selectSuspended = true;
        clearTimeout(controlBlurTimer);
        return;
      }
      // Loss is terminal even if a delayed acquisition reply says it acquired focus.
      if (editing && nativeGenerations.has(event.generation)) {
        finish(false, event.reason !== "hide", undefined, false);
      }
    } else if (selectSuspended && editing) {
      selectSuspended = false;
      focusLeasedControl();
    } else checkActivation();
  };
  const focusIn = (event: FocusEvent): void => {
    const control = editableControl(event.target);
    if (control !== openSelect) openSelect = undefined;
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
      // Only text entry has a caret to suspend. Blurring a non-text control here closes
      // native colour/select pickers before their asynchronous lease reply arrives.
      if (!acquiredControlFocus && isTextEditingElement(control)) {
        // This is a lease transition, not the start/end of a React edit. In particular,
        // do not reset a spin-button press or create a draft before acquisition succeeds.
        event.stopPropagation();
        suspendingControlFocus = true;
        control.blur();
        suspendingControlFocus = false;
      }
    }
    if (editing && !selectionLease && control) leasedControl = control;
    if (editableFocus && editing && control) paletteControls.set(shell, control);
  };
  const focusOut = (event: FocusEvent): void => {
    // Popup tracking can blur the select to body before the native notification.
    // An actual destination or Tab still ends this protection below.
    if (nativeSelectInteraction && event.target === leasedControl && !event.relatedTarget &&
      (openSelect || selectSuspended)) return;
    if (event.target === openSelect) openSelect = undefined;
    if (editableFocus && suspendingControlFocus) {
      event.stopPropagation();
      return;
    }
    if (!editableFocus || suspendingControlFocus || !acquiredControlFocus || !editing) return;
    if (event.relatedTarget === shell && leasedControl?.matches(":disabled")) return;
    const next = editableControl(event.relatedTarget);
    if (next && shell.contains(next)) return;
    if (!editableControl(event.target) && event.target !== shell) return;
    if (event.relatedTarget instanceof Node) {
      // Another palette's control is a destination, not an invitation to activate the drawing.
      finish(false, false, undefined, !next);
      return;
    }
    // WebView2 can report focusout(null), window blur, then focusin on the same control
    // during a multi-click. Handing back immediately brings the document in front and sends
    // the next key to the drawing. Check the settled DOM focus; focusin cancels this check.
    clearTimeout(controlBlurTimer);
    pendingPaletteShells.add(shell);
    controlBlurTimer = setTimeout(() => {
      const active = document.activeElement === shell && leasedControl?.matches(":disabled")
        ? leasedControl : editableControl(document.activeElement);
      if (!disposed && editing && pointerControl === leasedControl && pointerControl &&
        !isTextEditingElement(pointerControl) && shell.contains(pointerControl) && document.activeElement === document.body) {
        // A held WebKit click can blur to body before mouseup/click. Its explicitly leased
        // control is still the destination; do not hand the keyboard back to the drawing.
        focusLeasedControl();
        pendingPaletteShells.delete(shell);
      } else if (!disposed && editing && !(active && shell.contains(active))) finish();
      else if (acquiredControlFocus) pendingPaletteShells.delete(shell);
    }, 0);
  };
  const protectPendingKeys = (event: KeyboardEvent): void => {
    if (!editableFocus || !editing || (event.target !== document.body &&
      (!(event.target instanceof Node) || !shell.contains(event.target)))) return;
    if (event.key === "Escape" || event.key === "Tab") return;
    // Let the registry-backed app route run even during acquisition or in a disabled sink.
    if (menuShortcut(event)) return;
    const drop = leasedControl?.matches(":disabled")
      ? isDisabledPaletteTypingKey(event)
      : !acquiredControlFocus && isPendingPaletteEditingKey(event);
    if (drop) {
      // Only editing/typing is dropped. App menu shortcuts were admitted above.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (editableFocus && event.target !== document.body &&
      (!(event.target instanceof Node) || !shell.contains(event.target))) return;
    pointerClickTarget = undefined;
    const control = editableControl(event.target) ?? (editableFocus ? leasedControl : undefined);
    if (!editing || event.isComposing) return;
    if (platform === "macos" && control instanceof HTMLSelectElement && !control.disabled) {
      // Accepting the current option need not fire change. Space opens a closed
      // list, but accepts one already open; Enter/Return also end that list session.
      if (event.key === "Enter" || event.key === "Return" || (event.key === " " && control === openSelect)) {
        openSelect = undefined;
      } else if (event.key === " " || (event.altKey && event.key === "ArrowDown")) openSelect = control;
    }
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation(); // Escape finishes editing; it must not close the report window.
      if (control === openSelect && openSelect) {
        openSelect = undefined;
        if (selectSuspended) {
          selectSuspended = false;
          setEditing(true, true);
        }
        focusLeasedControl();
        return;
      }
      finish(true);
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
      !(editableFocus && control instanceof HTMLInputElement && control.type === "number") &&
      (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      // Bubble after the control's commit handler; textarea/contenteditable keep multiline Enter.
      finish();
    } else if (event.key === "Tab" && !event.defaultPrevented) {
      openSelect = undefined;
      selectSuspended = false;
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
  const selectChange = (event: Event): void => {
    if (event.target === openSelect) {
      openSelect = undefined;
      if (selectSuspended) {
        selectSuspended = false;
        setEditing(true, true);
      }
      focusLeasedControl();
    }
  };
  // Removing a focused node need not emit focusout (including a replaced report or closed portal).
  const observer = new MutationObserver(() => {
    if (selectionLease) {
      if (selectionNodes.some((node) => !shell.contains(node))) finish();
    } else if (editing && (!leasedControl || !shell.contains(leasedControl) ||
      (editableControl(leasedControl) !== leasedControl && !(editableFocus && leasedControl.matches(":disabled"))))) finish();
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
  shell.addEventListener("change", selectChange);
  // Palette controls commit/cancel through React's delegated handlers at the root above shell.
  // Finish their leases afterwards, so Escape cannot swallow the control's cancel handler.
  if (editableFocus) {
    window.addEventListener("keydown", protectPendingKeys, true);
    window.addEventListener("keydown", keyDown);
  }
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
    clearTimeout(pointerFocusTimer);
    unsubscribeFocus?.();
    unsubscribePointer?.();
    observer.disconnect();
    shell.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", cancelSelectionGesture, true);
    shell.removeEventListener("click", click, true);
    shell.removeEventListener("focusin", focusIn);
    shell.removeEventListener("focusout", focusOut);
    shell.removeEventListener("change", selectChange);
    if (editableFocus) {
      window.removeEventListener("keydown", protectPendingKeys, true);
      window.removeEventListener("keydown", keyDown);
    }
    else shell.removeEventListener("keydown", keyDown);
    document.removeEventListener("selectionchange", selectionChange);
    finish(false, false, undefined, false);
    if (editableFocus && originalTabIndex === null) shell.removeAttribute("tabindex");
  };
}
