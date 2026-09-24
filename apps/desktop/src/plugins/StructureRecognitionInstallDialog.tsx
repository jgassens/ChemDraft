import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import type { OpenStructureRecognitionInstall } from "./StructureRecognitionController";
import type { StructureRecognitionInstallError } from "./structureRecognitionEngine";

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

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

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
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onDecline, request.id, request.installing]);

  if (typeof document === "undefined") return null;

  const progress = request.progress;
  const byteProgress =
    progress?.bytesDone !== undefined && progress.bytesTotal !== undefined && progress.bytesTotal > 0;

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="plugin-prompt-dialog recognition-install-dialog"
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
            <div className="recognition-install-progress" aria-live="polite">
              <p>{progress?.message ?? "Installing the recognition engine…"}</p>
              {byteProgress ? (
                <>
                  <progress
                    aria-label="Recognition engine install progress"
                    value={progress.bytesDone}
                    max={progress.bytesTotal}
                  />
                  <span>
                    {formatDiskBytes(progress.bytesDone!)} of {formatDiskBytes(progress.bytesTotal!)}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          {request.error ? (
            <p className="plugin-image-error" role="alert">
              {recognitionInstallErrorMessage(request.error, request.status)}
            </p>
          ) : null}
        </div>
        <footer className="plugin-prompt-actions">
          {request.installing ? (
            <button className="plugin-manager-button" type="button" onClick={() => void onCancel(request.id)}>
              Cancel
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
                  Install
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

export function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1).replace(/\.0$/, "")} GB`;
}
