import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import type { PluginImageSource } from "@chemdraft/plugin-api";
import type { OpenPluginImageRequest } from "./PluginImageRequestController";

export interface PluginImageRequestDialogProps {
  request: OpenPluginImageRequest;
  onAcquire: (requestId: number, source: PluginImageSource) => void;
  onCancel: (requestId: number) => void;
}

export function isPluginImageKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest(".plugin-image-dialog") !== null;
}

export function PluginImageRequestDialog({ request, onAcquire, onCancel }: PluginImageRequestDialogProps) {
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
      const focusable = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, request.id]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="plugin-prompt-dialog plugin-image-dialog"
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
