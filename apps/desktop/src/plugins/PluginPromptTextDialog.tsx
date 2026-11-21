import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PluginTextPromptForm } from "../dialogs/PluginTextPromptForm";
import type { PluginTextPromptState } from "../dialogs/DialogCoordinator";
import type { OpenPluginTextPrompt } from "./PluginPromptTextController";
import { pluginTextPromptSnapshot } from "./nativePluginTextPrompts";

export interface PluginPromptTextDialogProps {
  prompt: OpenPluginTextPrompt;
  /** Submit off, with the reason, while the prompt's own tab is not active. */
  state?: PluginTextPromptState;
  onSubmit: (promptId: number, value: string) => void;
  onCancel: (promptId: number) => void;
}

/** MainWindow owns window-level shortcuts, including a capture-phase Escape handler. Those handlers
 * must bail out explicitly because a dialog listener cannot retroactively stop an earlier window
 * listener on the same event path. */
export function isPluginPromptKeyboardEvent(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest(".plugin-prompt-dialog") !== null;
}

/**
 * Browser-build fallback only. The desktop app asks through the shared native dialog host
 * (presentPluginTextPromptsNatively); a browser has no owned native windows, so this shows the
 * same PluginTextPromptForm in an in-page modal, as the other dialog-host kinds do there.
 */
export function PluginPromptTextDialog({ prompt, state, onSubmit, onCancel }: PluginPromptTextDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  // Read during the first render: the form's autoFocus moves focus at commit, before any effect runs.
  const [previousFocus] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : undefined);

  useEffect(() => {
    return () => {
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [previousFocus]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    // Keep Tab inside the modal while it is open.
    const trapTab = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const focusable = backdrop.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
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
    backdrop.addEventListener("keydown", trapTab);
    return () => backdrop.removeEventListener("keydown", trapTab);
  }, []);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div ref={backdropRef} className="plugin-prompt-backdrop" role="presentation">
      <PluginTextPromptForm
        scope="form"
        data={{ ...pluginTextPromptSnapshot(prompt), ...state }}
        onSubmit={value => onSubmit(prompt.id, value)}
        onCancel={() => onCancel(prompt.id)}
      />
    </div>,
    document.body
  );
}
