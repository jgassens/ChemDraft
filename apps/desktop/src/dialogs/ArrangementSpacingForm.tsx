import { useId, useRef, type KeyboardEvent } from "react";
import { detectDialogPlatform, type DialogPlatform, type SpacingSnapshot } from "./dialogProtocol";

/** Draft-only body shared by the native host and browser fallback. */
export function ArrangementSpacingForm({ title, minPercent, maxPercent, percent, preview, error, busy = false, modal = false,
  onChange, onSave, onCancel, platform = detectDialogPlatform() }: SpacingSnapshot & {
  percent: number; preview?: string; error?: string; busy?: boolean; modal?: boolean;
  onChange(percent: number): void; onSave(): void; onCancel(): void; platform?: DialogPlatform;
}) {
  const id = useId(), composing = useRef(false), form = useRef<HTMLFormElement>(null);
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" || (modifier && event.key.toLowerCase() === "w")) {
      event.preventDefault(); onCancel();
    } else if (event.key === "F5" || (modifier && event.key.toLowerCase() === "r")) event.preventDefault();
    else if (modal && event.key === "Tab") {
      const controls = form.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)');
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  return <form ref={form} className="arrangement-spacing-dialog" role="dialog" aria-modal={modal || undefined} aria-labelledby={id} aria-busy={busy}
    onSubmit={event => { event.preventDefault(); if (preview && !busy && !composing.current) onSave(); }}
    onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <h2 id={id}>Adjust arrangement spacing</h2>
    <p>Drawing: <strong>{title}</strong></p>
    {preview ? <img className="arrangement-spacing-preview" src={preview} alt="Arrangement spacing preview" />
      : <div className="arrangement-spacing-preview" role="status">{error ? "Preview unavailable" : "Updating preview…"}</div>}
    <label htmlFor={`${id}-spacing`}>Spacing <output>{percent}%</output></label>
    <input autoFocus id={`${id}-spacing`} type="range" min={minPercent} max={maxPercent} step="1" value={percent}
      disabled={busy} aria-valuetext={`${percent}% of original spacing`} onChange={event => onChange(Number(event.currentTarget.value))} />
    <div className="arrangement-spacing-scale" aria-hidden="true"><span>Closer</span><span>Farther apart</span></div>
    <p>Molecule sizes stay fixed. Only the spacing between selected compounds changes.</p>
    <p>The outlined white area is the page. Spacing stops at the page edge or 150%, whichever comes first.</p>
    <p role="status">{error}</p>
    <footer className="arrangement-spacing-actions">
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="submit" disabled={!preview || busy}>Save</button>
    </footer>
  </form>;
}
