import { isDesktopRuntime } from "../window-manager";

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

async function requestNativeInputFocus(editing: boolean): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_plugin_panel_input_focus", { editing });
}

/** Event delegation also covers controls mounted by later report snapshots and keyboard .focus(). */
export function installPluginPanelInputFocus(
  shell: HTMLElement,
  requestFocus: (editing: boolean) => Promise<void> = requestNativeInputFocus
): () => void {
  let editing = false;
  let revision = 0;
  let pending = Promise.resolve();
  const setEditing = (next: boolean): void => {
    if (editing === next) return;
    editing = next;
    const requestedRevision = ++revision;
    // Serialize IPC: a delayed pointer-down request must not refocus a field after Escape/blur.
    pending = pending.catch(() => undefined).then(async () => {
      if (requestedRevision === revision) await requestFocus(next);
    });
    void pending.catch((error: unknown) => console.error("Could not change panel input focus:", error));
  };
  const finish = (): void => {
    setEditing(false);
    const active = panelEditableControl(document.activeElement);
    if (active && shell.contains(active)) active.blur();
  };
  const pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (panelEditableControl(event.target)) setEditing(true);
    else if (editing) finish();
  };
  const focusIn = (event: FocusEvent): void => {
    if (panelEditableControl(event.target)) setEditing(true);
    else if (editing) finish();
  };
  const wheel = (event: WheelEvent): void => {
    if (editing && !panelEditableControl(event.target)) finish();
  };
  const focusOut = (): void => {
    // Native loss of focus and DOM blur can occur before the next control's focusin.
    queueMicrotask(() => {
      if (!shell.contains(document.activeElement) || !panelEditableControl(document.activeElement)) {
        setEditing(false);
      }
    });
  };
  const keyDown = (event: KeyboardEvent): void => {
    const control = panelEditableControl(event.target);
    if (!control || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Escape finishes editing; it must not close the report window.
      finish();
    } else if (event.key === "Enter" &&
      (control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
      // Bubble after the control's commit handler; textarea/contenteditable keep multiline Enter.
      finish();
    } else if (event.key === "Tab" && !event.defaultPrevented) {
      const controls = [...shell.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable]")]
        .filter((candidate) => panelEditableControl(candidate) === candidate &&
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
  shell.addEventListener("pointerdown", pointerDown, true);
  shell.addEventListener("focusin", focusIn);
  shell.addEventListener("focusout", focusOut);
  shell.addEventListener("wheel", wheel, { capture: true, passive: true });
  shell.addEventListener("keydown", keyDown);
  window.addEventListener("blur", finish);
  return () => {
    shell.removeEventListener("pointerdown", pointerDown, true);
    shell.removeEventListener("focusin", focusIn);
    shell.removeEventListener("focusout", focusOut);
    shell.removeEventListener("wheel", wheel, true);
    shell.removeEventListener("keydown", keyDown);
    window.removeEventListener("blur", finish);
    finish();
  };
}
