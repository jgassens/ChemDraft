import { isDesktopRuntime, listenForToolsetCommandSpecs, TOOLSET_COMMAND_SPECS_REQUEST_EVENT } from "../window-manager";
import { listenCurrentWindowEvent } from "../window-manager/tauriEvents";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createDesktopShortcutRegistry, detectDesktopShortcutPlatform } from "../keyboardShortcuts";
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

async function requestNativePaletteInputFocus(
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

export async function listenNativePanelFocus(listener: (event: NativePanelFocusEvent) => void): Promise<() => void> {
  if (!isDesktopRuntime()) return () => undefined;
  return listenCurrentWindowEvent<NativePanelFocusEvent>("chemdraft://plugin-panel-focus", ({ payload }) => listener(payload));
}

/** Palettes accept text accessibility focus and release after control focus settles.
 * keepWindowFocus exempts an intentional Focus-mode reveal from idle/pointer hand-back until hidden. */
export function installPaletteInputFocus(
  shell: HTMLElement, platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  menuShortcut: (event: KeyboardEvent) => boolean = () => false,
  keepWindowFocus: () => boolean = () => false
): () => void {
  return installPaletteInputFocusLease(shell, undefined, platform, undefined, menuShortcut, keepWindowFocus);
}

/** Palette-only lease path. Plugin panels keep native activation independently of DOM editing. */
export function installPaletteInputFocusLease(
  shell: HTMLElement,
  requestFocus: (editing: boolean, generation: number) => Promise<boolean> = requestNativePaletteInputFocus,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  subscribeFocus: (listener: (event: NativePanelFocusEvent) => void) => Promise<() => void> = listenNativePanelFocus,
  menuShortcut: (event: KeyboardEvent) => boolean = () => false,
  keepWindowFocus: () => boolean = () => false
): () => void {
  const editableControl = (target: EventTarget | null) => panelEditableControl(target, true);
  // Disabled controls cannot take DOM focus. Their palette is a keyboard sink instead.
  const originalTabIndex = shell.getAttribute("tabindex");
  if (originalTabIndex === null) shell.tabIndex = -1;
  if (requestFocus === requestNativePaletteInputFocus && isDesktopRuntime()) {
    void registerNativeInputFocus().catch((error: unknown) =>
      console.error("Could not register panel input focus:", error));
  }
  let clickSequence: number | undefined;
  let latestClickSequence = 0;
  let unsubscribePointer: (() => void) | undefined;
  const pointerSubscribed = isDesktopRuntime() ? listenPaletteClickPending((event) => {
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
    if (acquiredControlFocus && leasedControl && shell.contains(leasedControl)) {
      const destination = leasedControl.matches(":disabled") ? shell : leasedControl;
      if (document.activeElement !== destination) destination.focus({ preventScroll: true });
    }
  };
  const setEditing = (next: boolean, retry = false, pointerBefore?: number, returnFocus = false): void => {
    const selectInteraction = next && platform === "macos" &&
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
    if (next && !acquiredControlFocus) pendingPaletteShells.add(shell);
    else pendingPaletteShells.delete(shell);
    if (next) shell.dataset.paletteInputFocus = acquiredControlFocus ? "held" : "pending";
    else delete shell.dataset.paletteInputFocus;
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
        const acquired = await (requestFocus === requestNativePaletteInputFocus
          ? requestNativePaletteInputFocus(next, requestedRevision, requestedClick, pointerBefore, returnFocus, selectInteraction)
          : requestFocus(next, requestedRevision));
        if (next && requestedChain === leaseChain) {
          if (!acquired) finish(true, false, undefined, false);
          else {
            // A settled successor supersedes old native events. Until it settles, loss of
            // its predecessor also cancels this retry and any clicks queued behind it.
            nativeGenerations.clear();
            nativeGenerations.add(requestedRevision);
            acquiredControlFocus = true;
            pendingPaletteShells.delete(shell);
            shell.dataset.paletteInputFocus = "held";
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
    if (cancelControl) leasedControl?.dispatchEvent(new Event(PALETTE_INPUT_FOCUS_CANCEL_EVENT));
    leasedControl = undefined;
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
    if (!editing) setEditing(false, true, pointerBefore, true);
  };
  const pointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted || event.button !== 0) return;
    clearTimeout(pointerFocusTimer);
    pointerFocusTimer = undefined;
    pointerActive = true;
    pointerClassificationBefore = Date.now();
    pointerClickTarget = event.target;
    const control = disabledControlAtPointer(shell, event) ?? editableControl(event.target);
    if (control && shell.contains(control)) {
      // WebKit may deliver the list-closing Escape to the page. Retain this
      // intent through popup blur/key loss too; WebView2 consumes it in its popup.
      openSelect = platform === "macos" && control instanceof HTMLSelectElement && !control.disabled ? control : undefined;
      clearTimeout(controlBlurTimer);
      if (acquiredControlFocus) pendingPaletteShells.delete(shell);
      leasedControl = control;
      pointerControl = control;
      paletteControls.set(shell, control);
      // Palette multi-clicks reuse the held or pending lease. Reacquiring calls native focus
      // again and can blur WebView2 mid-click. A rejected lease already finished, so it retries.
      setEditing(true, false, pointerClassificationBefore);
    } else {
      // Only Windows has WM_EXITSIZEMOVE to return foreground after Tao's modal drag.
      // macOS must retain its pointerdown hand-back or the palette remains key.
      const startsDrag = platform === "windows" && isPaletteWindowDragPress(shell, event);
      if (editing) finish(false, false, pointerClassificationBefore, !startsDrag);
      else if (startsDrag) setEditing(false, true, pointerClassificationBefore, false);
      else returnPointerFocus(pointerClassificationBefore);
    }
  };
  const pointerUp = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    pointerActive = false;
    returnPointerFocus(pointerClassificationBefore);
  };
  const click = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const fromPointer = event.detail > 0 && pointerClickTarget === event.target;
    pointerClickTarget = undefined;
    if (platform === "windows" && !fromPointer) return;
    if (fromPointer && pointerControl) {
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
    // Covers activation performed by WebView2's default click handling after pointerup.
    returnPointerFocus(fromPointer ? pointerClassificationBefore : undefined);
    pointerClassificationBefore = undefined;
  };
  const cancelPointerGesture = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    pointerActive = false;
    pointerClickTarget = undefined;
    pointerControl = undefined;
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
      if (!disposed && revision === activatedRevision && !editing && !pointerActive) {
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
      if (acquiredControlFocus) pendingPaletteShells.delete(shell);
    }
    if (event.isTrusted && control && shell.contains(control) &&
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
    if (editing && control) leasedControl = control;
    if (editing && control) paletteControls.set(shell, control);
  };
  const focusOut = (event: FocusEvent): void => {
    // Popup tracking can blur the select to body before the native notification.
    // An actual destination or Tab still ends this protection below.
    if (nativeSelectInteraction && event.target === leasedControl && !event.relatedTarget &&
      (openSelect || selectSuspended)) return;
    if (event.target === openSelect) openSelect = undefined;
    if (suspendingControlFocus) {
      event.stopPropagation();
      return;
    }
    if (suspendingControlFocus || !acquiredControlFocus || !editing) return;
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
    if (!editing || (event.target !== document.body &&
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
    if (event.target !== document.body &&
      (!(event.target instanceof Node) || !shell.contains(event.target))) return;
    pointerClickTarget = undefined;
    const control = editableControl(event.target) ?? leasedControl;
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
    } else if (!control) return;
    else if (event.key === "Enter" && isTextEditingElement(control) &&
      !(control instanceof HTMLInputElement && control.type === "number") &&
      (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      // Bubble after the control's commit handler; textarea/contenteditable keep multiline Enter.
      finish();
    } else if (event.key === "Tab" && !event.defaultPrevented) {
      openSelect = undefined;
      selectSuspended = false;
      // Palettes use browser traversal and keep the lease between all non-button controls.
      // A checkbox/slider/select must take keys too: otherwise Delete reaches the drawing
      // on both platforms. Text entry still commits on blur before traversing to the slider.
      return;
    }
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
    if (editing && (!leasedControl || !shell.contains(leasedControl) ||
      (editableControl(leasedControl) !== leasedControl && !leasedControl.matches(":disabled")))) finish();
  });
  observer.observe(shell, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "readonly", "contenteditable", "type"] });
  shell.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", cancelPointerGesture, true);
  shell.addEventListener("click", click, true);
  shell.addEventListener("focusin", focusIn);
  shell.addEventListener("focusout", focusOut);
  shell.addEventListener("change", selectChange);
  // Palette controls commit/cancel through React's delegated handlers at the root above shell.
  // Finish their leases afterwards, so Escape cannot swallow the control's cancel handler.
  window.addEventListener("keydown", protectPendingKeys, true);
  window.addEventListener("keydown", keyDown);
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
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", cancelPointerGesture, true);
    shell.removeEventListener("click", click, true);
    shell.removeEventListener("focusin", focusIn);
    shell.removeEventListener("focusout", focusOut);
    shell.removeEventListener("change", selectChange);
    window.removeEventListener("keydown", protectPendingKeys, true);
    window.removeEventListener("keydown", keyDown);
    finish(false, false, undefined, false);
    if (originalTabIndex === null) shell.removeAttribute("tabindex");
  };
}

const deactivationListeners = new Set<() => void>();

/** Consumers share the input handler's generation check instead of interpreting raw focus events. */
export function listenPanelDeactivation(listener: () => void): () => void {
  deactivationListeners.add(listener);
  return () => { deactivationListeners.delete(listener); };
}

async function requestNativeInputFocus(editing: boolean, generation: number): Promise<boolean> {
  if (!isDesktopRuntime()) return editing;
  const token = await registerNativeInputFocus();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("set_plugin_panel_input_focus", { editing, generation, pageToken: token });
}

export interface PanelShortcutHandler {
  resolve(event: KeyboardEvent): string | undefined;
  forward(commandId: string, event?: KeyboardEvent): void;
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
  const consumedKeys = new Set<string>();
  const setFocused = (next: boolean): void => {
    focused = next;
    const generation = revision = ++nextGeneration;
    pending = pending.catch(() => undefined).then(async () => {
      await subscribed;
      if (revision !== generation) return;
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
    consumedKeys.clear();
    blurControl();
    document.getSelection()?.removeAllRanges();
    for (const listener of deactivationListeners) listener();
  };
  const nativeFocus = (event: NativePanelFocusEvent): void => {
    if (disposed || event.kind !== "deactivated") return;
    if (focused && event.generation === revision) {
      setFocused(false);
      clearInteraction();
    }
  };
  let registry: ReturnType<typeof createDesktopShortcutRegistry> | undefined;
  const shortcutHandler = shortcuts ?? {
    resolve: (event: KeyboardEvent) => registry?.resolve(event),
    forward: (commandId: string, event?: KeyboardEvent) => {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("plugin_panel_event_forward", {
          event: "chemdraft://plugin-panel-shortcut", payload: { commandId,
            key: event?.key, metaKey: event?.metaKey ?? false, ctrlKey: event?.ctrlKey ?? false, altKey: event?.altKey ?? false }
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
  const clearConsumedKeys = (): void => { consumedKeys.clear(); };
  const visibilityChange = (): void => { if (document.hidden) clearConsumedKeys(); };
  const keyUp = (event: KeyboardEvent): void => { consumedKeys.delete(event.code); };
  const consumeKey = (event: KeyboardEvent): void => {
    consumedKeys.add(event.code);
    event.preventDefault();
    event.stopPropagation();
  };
  const keyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    // Clearing the selection must not send this held key's repeats to the drawing.
    if (consumedKeys.has(event.code)) {
      consumeKey(event);
      return;
    }
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
    // Panel deletion never targets the drawing, regardless of selection, modifiers,
    // repeat flags or intervening keyups. Editable controls have already kept their keys.
    if (event.key === "Backspace" || event.key === "Delete") {
      if (hasReportSelection()) document.getSelection()?.removeAllRanges();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (hasReportSelection()) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["c", "a"].includes(event.key.toLowerCase())) return;
      if (["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key) ||
        (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key))) return;
      document.getSelection()?.removeAllRanges();
      // The key ending a report selection belongs to the panel, including cut/paste,
      // history and destructive commands. It must never act on selected chemistry.
      consumeKey(event);
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
      if (shortcuts) shortcuts.forward(commandId);
      else shortcutHandler.forward(commandId, event);
    } else if (reload) event.preventDefault();
  };
  shell.addEventListener("pointerdown", pointerDown, true);
  shell.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", clearConsumedKeys);
  window.addEventListener("pagehide", clearConsumedKeys);
  window.addEventListener("unload", clearConsumedKeys);
  document.addEventListener("visibilitychange", visibilityChange);
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
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", clearConsumedKeys);
    window.removeEventListener("pagehide", clearConsumedKeys);
    window.removeEventListener("unload", clearConsumedKeys);
    document.removeEventListener("visibilitychange", visibilityChange);
    clearConsumedKeys();
    if (focused) setFocused(false);
  };
}
