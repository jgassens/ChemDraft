import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { OpenPluginTextPrompt } from "./PluginPromptTextController";

export interface PluginPromptTextDialogProps {
  prompt: OpenPluginTextPrompt;
  onSubmit: (promptId: number, value: string) => void;
  onCancel: (promptId: number) => void;
}

/** MainWindow owns window-level shortcuts, including a capture-phase Escape handler. Those handlers
 * must bail out explicitly because a dialog listener cannot retroactively stop an earlier window
 * listener on the same event path. */
export function isPluginPromptKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest(".plugin-prompt-dialog") !== null;
}

export function PluginPromptTextDialog({ prompt, onSubmit, onCancel }: PluginPromptTextDialogProps) {
  const [value, setValue] = useState(prompt.request.initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const labelId = useId();
  const attributionId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    inputRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    const handleDialogKeyDown = (event: KeyboardEvent): void => {
      // Only keys aimed at this dialog. Another plugin dialog (an image request, the engine installer)
      // may be open at the same time and owns its own Escape; a window-wide handler here would cancel
      // this prompt too.
      if (!(event.target instanceof Node) || !dialogRef.current?.contains(event.target)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel(prompt.id);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) {
        return;
      }
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
    window.addEventListener("keydown", handleDialogKeyDown);
    return () => window.removeEventListener("keydown", handleDialogKeyDown);
  }, [onCancel, prompt.id]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <form
        ref={dialogRef}
        className="plugin-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={attributionId}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.length > 0) {
            onSubmit(prompt.id, value);
          }
        }}
      >
        <header className="plugin-prompt-header">
          <h2 id={titleId}>{prompt.request.title}</h2>
          <p id={attributionId}>Requested by {prompt.pluginName} ({prompt.pluginId})</p>
        </header>
        <div className="plugin-prompt-body">
          <label id={labelId} htmlFor={`plugin-prompt-input-${prompt.id}`}>
            {prompt.request.label}
          </label>
          <input
            ref={inputRef}
            id={`plugin-prompt-input-${prompt.id}`}
            aria-labelledby={labelId}
            value={value}
            placeholder={prompt.request.placeholder}
            maxLength={prompt.request.maxLength}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </div>
        <footer className="plugin-prompt-actions">
          <button className="plugin-manager-button" type="button" onClick={() => onCancel(prompt.id)}>
            Cancel
          </button>
          <button className="plugin-manager-button" type="submit" disabled={value.length === 0}>
            {prompt.request.submitLabel ?? "Submit"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
