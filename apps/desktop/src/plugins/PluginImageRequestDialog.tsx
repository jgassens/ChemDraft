import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { PluginImageSource } from "@chemdraft/plugin-api";
import type { OpenPluginImageRequest } from "./PluginImageRequestController";

export interface PluginImageRequestDialogProps {
  request: OpenPluginImageRequest;
  onAcquire: (requestId: number, source: PluginImageSource) => void;
  onOpenPermissionSettings: (requestId: number) => void;
  onPermissionFocus: (requestId: number) => void;
  onRelaunch: (requestId: number) => void;
  onCancel: (requestId: number) => void;
}

export function isPluginImageKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest(".plugin-image-dialog") !== null;
}

/**
 * Keeps keyboard focus inside a modal dialog whose focused control just went away.
 *
 * These dialogs own their keys only for events *targeted inside them* (their own handlers and
 * MainWindow's opt-outs both test the event target). When the focused button unmounts (a footer that
 * swaps) or turns disabled (a source that is acquiring), the browser drops focus to `<body>`; from then
 * on Escape and Tab do nothing and Delete, Backspace or Cmd+Z reach the canvas behind the modal. So
 * after every render, a dialog whose focus fell out is refocused on its own container
 * (`tabIndex={-1}`), never on a button, so a repeated Enter cannot trigger an action nobody chose.
 * Focus that moved somewhere real (another dialog, an input) is left alone.
 */
export function keepFocusInsideDialog(dialog: HTMLElement | null): void {
  if (!dialog?.isConnected) return;
  const active = document.activeElement;
  const dropped = active === null || active === document.body || active === document.documentElement;
  const disabledInside =
    active instanceof HTMLElement && dialog.contains(active) && active !== dialog && active.matches(":disabled");
  if (dropped || disabledInside) dialog.focus({ preventScroll: true });
}

/** Tab and Shift+Tab cycle through the dialog's enabled buttons, including from the container itself. */
export function trapDialogTab(event: KeyboardEvent, dialog: HTMLElement | null): void {
  const buttons = dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
  if (!buttons || buttons.length === 0) {
    // Nothing to move to: stay on the dialog rather than leave it.
    event.preventDefault();
    return;
  }
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  const active = document.activeElement;
  const onAButton = Array.prototype.includes.call(buttons, active);
  if (!onAButton) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function PluginImageRequestDialog({
  request,
  onAcquire,
  onOpenPermissionSettings,
  onPermissionFocus,
  onRelaunch,
  onCancel
}: PluginImageRequestDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const attributionId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  // A source button turning disabled while it acquires (or the failure that follows) must not leave
  // the modal without focus.
  useLayoutEffect(() => keepFocusInsideDialog(dialogRef.current));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isPluginImageKeyboardEvent(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel(request.id);
        return;
      }
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        // There is deliberately no default source. A focused source button still activates normally.
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      trapDialogTab(event, dialogRef.current);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, request.id]);

  useEffect(() => {
    const handleFocus = (): void => onPermissionFocus(request.id);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [onPermissionFocus, request.id]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="plugin-prompt-dialog plugin-image-dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={attributionId}
      >
        <header className="plugin-prompt-header">
          <h2 id={titleId}>{request.request.title}</h2>
          <p id={attributionId}>Requested by {request.pluginName} ({request.pluginId})</p>
        </header>
        <div className="plugin-prompt-body plugin-image-body">
          {request.providers.length > 0 ? (
            <div className="plugin-image-sources">
              {request.providers.map((provider) => (
                <button
                  key={provider.id}
                  className="plugin-manager-button"
                  type="button"
                  data-image-source={provider.id}
                  disabled={request.acquiringSource !== undefined}
                  onClick={() => onAcquire(request.id, provider.id)}
                >
                  {request.acquiringSource === provider.id ? "Waiting for image…" : provider.label}
                </button>
              ))}
            </div>
          ) : null}
          {request.unavailableReason ? <p role="alert">{request.unavailableReason}</p> : null}
          {request.permissionPanel ? (
            <section className="plugin-image-permission" role="alert">
              <p>{request.permissionPanel.message}</p>
              <div className="plugin-image-permission-actions">
                <button
                  className="plugin-manager-button"
                  type="button"
                  onClick={() => onOpenPermissionSettings(request.id)}
                >
                  {request.permissionPanel.openSettingsLabel}
                </button>
                {request.permissionPanel.showRelaunch ? (
                  <button
                    className="plugin-manager-button plugin-image-relaunch"
                    type="button"
                    onClick={() => onRelaunch(request.id)}
                  >
                    Quit &amp; Reopen ChemDraft
                  </button>
                ) : null}
              </div>
              {request.permissionPanel.restartNote ? (
                <p className="plugin-image-permission-note">{request.permissionPanel.restartNote}</p>
              ) : null}
            </section>
          ) : null}
          {request.error ? <p className="plugin-image-error" role="alert">{request.error}</p> : null}
        </div>
        <footer className="plugin-prompt-actions">
          <button className="plugin-manager-button" type="button" onClick={() => onCancel(request.id)}>
            {request.unavailableReason ? "Close" : "Cancel"}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
