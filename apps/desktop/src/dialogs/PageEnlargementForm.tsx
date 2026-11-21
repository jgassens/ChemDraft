import { useEffect, useRef } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { useDialogContentReady } from "./dialogContentFit";
import { PAGE_ENLARGEMENT_MESSAGE, PAGE_ENLARGEMENT_TITLE } from "./dialogProtocol";

export function PageEnlargementForm({ onReady, onKeep, onEnlarge, busy, error,
  platform = detectDesktopShortcutPlatform() }: {
  onReady(element: HTMLElement): void;
  onKeep(): void;
  onEnlarge(): void;
  busy: boolean;
  error?: string;
  platform?: ShortcutPlatform;
}) {
  const root = useDialogContentReady<HTMLElement>(onReady);
  const escapePressed = useRef(false);
  useEffect(() => {
    const view = root.current?.ownerDocument.defaultView;
    if (!view) return;
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        consume(event);
        escapePressed.current ||= !event.repeat;
      } else if (platform === "macos" && event.key === "." && event.metaKey &&
          !event.ctrlKey && !event.altKey && !event.shiftKey) {
        consume(event);
        if (!event.repeat) onKeep();
      }
    };
    // Keep Escape's auto-repeat in this window until the key is released.
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !escapePressed.current) return;
      consume(event);
      escapePressed.current = false;
      onKeep();
    };
    const blur = () => { escapePressed.current = false; };
    view.addEventListener("keydown", keydown, true);
    view.addEventListener("keyup", keyup, true);
    view.addEventListener("blur", blur);
    return () => {
      view.removeEventListener("keydown", keydown, true);
      view.removeEventListener("keyup", keyup, true);
      view.removeEventListener("blur", blur);
    };
  }, [onKeep, platform, root]);
  return <section ref={root} role="dialog" aria-label={PAGE_ENLARGEMENT_TITLE} aria-describedby="page-enlargement-question"
    className="cd-page-size-form cd-dialog-fit">
    <div className="cd-dialog-fit-body">
      <p id="page-enlargement-question">{PAGE_ENLARGEMENT_MESSAGE}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="cd-page-size-buttons cd-dialog-fit-footer">
      <button type="button" disabled={busy} onClick={onKeep}>Keep Page Size</button>
      <button type="button" autoFocus disabled={busy} onClick={onEnlarge}>Enlarge</button>
    </div>
  </section>;
}
