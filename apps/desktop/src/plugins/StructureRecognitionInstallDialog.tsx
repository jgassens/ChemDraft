import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { keepFocusInsideDialog, trapDialogTab } from "./PluginImageRequestDialog";
import { RecognitionInstallProgress } from "./RecognitionInstallProgress";
import type { OpenStructureRecognitionInstall } from "./StructureRecognitionController";
import type { StructureRecognitionInstallError } from "./structureRecognitionEngine";
import { formatGigabytes } from "./structureRecognitionInstallProgress";

export interface StructureRecognitionInstallDialogProps {
  request: OpenStructureRecognitionInstall;
  onInstall: (id: number) => void;
  onCancel: (id: number) => void;
  onDecline: (id: number) => void;
}

/** The dialog owns its keys; MainWindow's global shortcuts and the plugin manager's Escape opt out. */
export function isRecognitionInstallKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest(".recognition-install-dialog") !== null;
}

export function StructureRecognitionInstallDialog({
  request,
  onInstall,
  onCancel,
  onDecline
}: StructureRecognitionInstallDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const unsupported = request.status.state === "unsupported";
  // An engine is on disk but does not match this build; the detail says why in plain words.
  const reinstall = request.status.state === "broken";

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Install swaps the footer, unmounting the focused button; keep the keyboard on this dialog.
  useLayoutEffect(() => keepFocusInsideDialog(dialogRef.current));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isRecognitionInstallKeyboardEvent(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (request.installing) void onCancel(request.id);
        else onDecline(request.id);
        return;
      }
      if (event.key !== "Tab") return;
      trapDialogTab(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onDecline, request.id, request.installing]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="plugin-prompt-dialog recognition-install-dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="plugin-prompt-header">
          <h2 id={titleId}>{unsupported ? "Recognition engine unavailable" : "Install recognition engine?"}</h2>
          <p>Requested by {request.pluginName} ({request.pluginId})</p>
        </header>
        <div className="plugin-prompt-body recognition-install-body" id={descriptionId}>
          {unsupported ? (
            <p role="alert">This computer isn’t supported by the MolScribe recognition engine yet.</p>
          ) : (
            <>
              <p>MolScribe recognition engine: a private Python, PyTorch and a 1.1 GB model.</p>
              <p>
                Space needed: {formatDiskBytes(request.status.requiredDiskBytes)}. Free space:{" "}
                {formatDiskBytes(request.status.freeDiskBytes)}.
              </p>
              <p>It runs entirely on this computer. Images never leave it.</p>
            </>
          )}
          {request.status.detail ? <p>{request.status.detail}</p> : null}
          {request.installing ? (
            <RecognitionInstallProgress
              progress={request.progress}
              startedAt={request.startedAt}
              phaseStartedAt={request.phaseStartedAt}
            />
          ) : null}
          {request.installing && !request.ownsInstall ? (
            <p data-testid="recognition-install-joined-note">
              This install was already running when {request.pluginName} asked for it. Closing this window does
              not stop it; you can cancel it in Add or Remove Plugins.
            </p>
          ) : null}
          {request.error ? (
            <p className="plugin-image-error" role="alert">
              {recognitionInstallErrorMessage(request.error, request.status)}
            </p>
          ) : null}
        </div>
        <footer className="plugin-prompt-actions">
          {request.installing ? (
            // A dialog that joined someone else's install only closes; see StructureRecognitionController.cancel.
            <button className="plugin-manager-button" type="button" onClick={() => void onCancel(request.id)}>
              {request.ownsInstall ? "Cancel" : "Close"}
            </button>
          ) : (
            <>
              <button className="plugin-manager-button" type="button" onClick={() => onDecline(request.id)}>
                Not now
              </button>
              {!unsupported ? (
                <button
                  className="plugin-manager-button recognition-install-confirm"
                  type="button"
                  onClick={() => void onInstall(request.id)}
                >
                  {reinstall ? "Install engine again" : "Install"}
                </button>
              ) : null}
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}

export function recognitionInstallErrorMessage(
  error: StructureRecognitionInstallError,
  status: OpenStructureRecognitionInstall["status"]
): string {
  switch (error.code) {
    case "insufficientDisk":
      return `There isn’t enough free space. ${formatDiskBytes(status.requiredDiskBytes)} is needed; ${formatDiskBytes(
        status.freeDiskBytes
      )} is free.`;
    case "network":
      return "The recognition engine could not be downloaded. Check your connection and try again.";
    case "checksumMismatch":
      return "The downloaded recognition engine did not pass its integrity check. Nothing was installed.";
    case "cancelled":
      return "Installation was cancelled.";
    case "unsupported":
      return "This computer isn’t supported by the MolScribe recognition engine yet.";
    case "failed":
      return `The recognition engine could not be installed: ${error.message}`;
  }
}

/** Disk sizes in the install flow, in decimal gigabytes like every other size it shows. */
export function formatDiskBytes(bytes: number): string {
  return formatGigabytes(bytes);
}
