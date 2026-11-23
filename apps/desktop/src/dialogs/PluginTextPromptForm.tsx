import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { useDialogContentReady } from "./dialogContentFit";
import { pluginTextPromptValueFits, type PluginTextPromptSnapshot } from "./dialogProtocol";

/**
 * A plugin's one-line text question (dialogs.promptText). The native dialog host renders it in its
 * own document-owned window; the browser build renders the same form in an in-page fallback.
 * Holds only the local draft: the owner decides what a submitted answer does.
 */
export function PluginTextPromptForm({ data, onReady, onSubmit, onCancel, busy = false, error, scope = "window",
  platform = detectDesktopShortcutPlatform() }: {
  data: PluginTextPromptSnapshot;
  onReady?(element: HTMLElement): void;
  onSubmit(value: string): void;
  onCancel(): void;
  busy?: boolean;
  error?: string;
  /** "window": the form owns its native window's keyboard. "form": only keys aimed at the form (in-page fallback). */
  scope?: "window" | "form";
  platform?: ShortcutPlatform;
}) {
  const root = useDialogContentReady<HTMLFormElement>(onReady);
  const [value, setValue] = useState(data.initialValue);
  const composing = useRef(false);
  const escapePressed = useRef(false);
  const titleId = useId();
  const labelId = useId();
  const inputId = useId();
  const attributionId = useId();
  const statusId = useId();
  // The native window's answer must also fit the dialog channel; the in-page fallback has no channel.
  const fits = scope === "window" ? pluginTextPromptValueFits(value, data.maxLength) : value.length > 0 && value.length <= data.maxLength;
  const tooLong = value.length > 0 && !fits;
  const blocked = data.submitEnabled === false;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const form = root.current;
    const target: EventTarget | null | undefined = scope === "window" ? form?.ownerDocument.defaultView : form;
    if (!form || !target) return;
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current || event.keyCode === 229) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape") {
        consume(event);
        escapePressed.current ||= !event.repeat;
      } else if (platform === "macos" && event.key === "." && event.metaKey &&
          !event.ctrlKey && !event.altKey && !event.shiftKey) {
        consume(event);
        if (!event.repeat) onCancelRef.current();
      } else if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w") {
        consume(event);
        if (!event.repeat) onCancelRef.current();
      }
    };
    // Cancel on release so Escape's auto-repeat stays inside this dialog until the key comes up.
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !escapePressed.current) return;
      consume(event);
      escapePressed.current = false;
      onCancelRef.current();
    };
    const blur = () => { escapePressed.current = false; };
    const view = form.ownerDocument.defaultView;
    target.addEventListener("keydown", keydown as EventListener, true);
    target.addEventListener("keyup", keyup as EventListener, true);
    view?.addEventListener("blur", blur);
    return () => {
      target.removeEventListener("keydown", keydown as EventListener, true);
      target.removeEventListener("keyup", keyup as EventListener, true);
      view?.removeEventListener("blur", blur);
    };
  }, [platform, root, scope]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!busy && fits && !blocked && !composing.current) onSubmit(value);
  };
  // Enter confirming an IME composition must not submit the half-typed answer.
  const inputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
    event.preventDefault();
    submit();
  };
  const status = error ?? (tooLong ? "This answer is too long to send. Shorten it to continue." : data.statusLine ?? "");

  return <form ref={root} role="dialog"
    className={scope === "window" ? "plugin-text-prompt-form plugin-text-prompt-native cd-dialog-fit" : "plugin-prompt-dialog plugin-text-prompt-form"}
    aria-modal={scope === "form" ? true : undefined} aria-labelledby={titleId} aria-describedby={attributionId} aria-busy={busy}
    onSubmit={submit} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <div className="cd-dialog-fit-body">
      <header className="plugin-prompt-header">
        <h2 id={titleId}>{data.title}</h2>
        <p id={attributionId}>Requested by {data.pluginName} ({data.pluginId})</p>
      </header>
      <div className="plugin-prompt-body">
        <label id={labelId} htmlFor={inputId}>{data.label}</label>
        <input
          id={inputId}
          autoFocus
          aria-labelledby={labelId}
          aria-invalid={tooLong || undefined}
          aria-describedby={status ? statusId : undefined}
          value={value}
          placeholder={data.placeholder || undefined}
          maxLength={data.maxLength}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
          onKeyDown={inputKeyDown}
          onChange={event => setValue(event.currentTarget.value)}
        />
        {status ? <p id={statusId} role={error ? "alert" : "status"}>{status}</p> : null}
      </div>
    </div>
    <footer className="plugin-prompt-actions cd-dialog-fit-footer">
      <button className="plugin-manager-button" type="button" onClick={() => onCancel()}>Cancel</button>
      <button className="plugin-manager-button" type="submit" disabled={busy || !fits || blocked}>{data.submitLabel}</button>
    </footer>
  </form>;
}
