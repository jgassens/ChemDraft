import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { OpenPluginTextPrompt } from "./PluginPromptTextController";

export interface PluginPromptTextDialogProps {
  prompt: OpenPluginTextPrompt;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PluginPromptTextDialog({ prompt, onSubmit, onCancel }: PluginPromptTextDialogProps) {
  const [value, setValue] = useState(prompt.request.initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const labelId = useId();

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
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="plugin-prompt-backdrop" role="presentation">
      <form
        className="plugin-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.length > 0) {
            onSubmit(value);
          }
        }}
      >
        <header className="plugin-prompt-header">
          <h2 id={titleId}>{prompt.request.title}</h2>
          <p>Requested by {prompt.pluginName}</p>
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
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (value.length > 0) {
                  onSubmit(value);
                }
              }
            }}
          />
        </div>
        <footer className="plugin-prompt-actions">
          <button className="plugin-manager-button" type="button" onClick={onCancel}>
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
