import { useId, useRef, type KeyboardEvent } from "react";
import { detectDialogPlatform, type DialogPlatform, type SpacingSnapshot } from "./dialogProtocol";
import { ArrangementLayouts, type ArrangementDraft } from "@chemdraft/layout-engine";

/** Draft-only body shared by the native host and browser fallback. */
export function ArrangementSpacingForm({ title, minPercent, maxPercent, percent, preview, error, busy = false, modal = false,
  arrangement, onArrangementChange, onChange, onSave, onCancel, platform = detectDialogPlatform() }: SpacingSnapshot & {
  percent: number; preview?: string; error?: string; busy?: boolean; modal?: boolean;
  onChange(percent: number): void; onSave(): void; onCancel(): void; platform?: DialogPlatform;
  onArrangementChange?(draft: ArrangementDraft): void;
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
      const controls = form.current?.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)');
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  return <form ref={form} className="arrangement-spacing-dialog" role="dialog" aria-modal={modal || undefined} aria-labelledby={id} aria-busy={busy}
    onSubmit={event => { event.preventDefault(); if (preview && !busy && !composing.current) onSave(); }}
    onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <h2 id={id}>{arrangement ? "Arrange selection" : "Adjust arrangement spacing"}</h2>
    <p>Drawing: <strong>{title}</strong></p>
    {arrangement ? <fieldset disabled={busy} className="arrangement-options">
      <label>Layout <select autoFocus value={arrangement.layout} onChange={e => onArrangementChange?.({ ...arrangement, layout: e.currentTarget.value as ArrangementDraft["layout"] })}>
        {ArrangementLayouts.map(layout => <option key={layout} value={layout}>{layout[0].toUpperCase() + layout.slice(1)}</option>)}
      </select></label>
      {arrangement.layout === "grid" ? <label>Last row alignment <select value={arrangement.gridAlignment} onChange={e => onArrangementChange?.({ ...arrangement, gridAlignment: e.currentTarget.value as ArrangementDraft["gridAlignment"] })}>
        <option value="left">Left</option><option value="center">Centered</option><option value="right">Right</option>
      </select></label> : null}
      <label><input type="checkbox" checked={arrangement.arrows} onChange={e => onArrangementChange?.({ ...arrangement, arrows: e.currentTarget.checked })} /> Add connecting arrows</label>
      {arrangement.arrows ? <>
        <label htmlFor={`${id}-arrow-length`}>Arrow length <output>{arrangement.arrowLength??100}%</output></label>
        <input id={`${id}-arrow-length`} type="range" min={30} max={100} step={5} value={arrangement.arrowLength??100}
          aria-valuetext={`${arrangement.arrowLength??100}% of the clear connecting route`}
          onChange={event=>onArrangementChange?.({...arrangement,arrowLength:Number(event.currentTarget.value)})} />
        <p>Shorter arrows leave more space at both ends. Molecule positions and sizes stay fixed.</p>
        {arrangement.layout === "grid" ? <label>Connection order <select value={arrangement.gridOrder} onChange={e => onArrangementChange?.({ ...arrangement, gridOrder: e.currentTarget.value as ArrangementDraft["gridOrder"] })}>
          <option value="rows">Each row separately</option><option value="snake">Snake through rows</option>
        </select></label> : null}
        <label>Direction <select value={String(arrangement.reverse)} onChange={e => onArrangementChange?.({ ...arrangement, reverse: e.currentTarget.value === "true" })}>
          <option value="false">{arrangement.layout === "circle" || arrangement.layout === "oval" ? "Clockwise" : arrangement.layout === "column" ? "Top to bottom" : "Left to right"}</option>
          <option value="true">{arrangement.layout === "circle" || arrangement.layout === "oval" ? "Counterclockwise" : "Reverse"}</option>
        </select></label>
        {arrangement.layout === "circle" || arrangement.layout === "oval" ? <label><input type="checkbox" checked={arrangement.closeCycle} onChange={e => onArrangementChange?.({ ...arrangement, closeCycle: e.currentTarget.checked })} /> Close the loop</label> : null}
        <p>Arrows remain editable. No reaction roles are assigned.</p>
      </> : null}
    </fieldset> : null}
    {preview ? <img className="arrangement-spacing-preview" src={preview} alt="Arrangement spacing preview" />
      : <div className="arrangement-spacing-preview" role="status">{error ? "Preview unavailable" : "Updating preview…"}</div>}
    <label htmlFor={`${id}-spacing`}>Spacing <output>{percent}%</output></label>
    <input autoFocus={!arrangement} id={`${id}-spacing`} type="range" min={minPercent} max={maxPercent} step="1" value={percent}
      disabled={busy} aria-valuetext={`${percent}% of ${arrangement ? "chosen layout" : "original spacing"}`} onChange={event => onChange(Number(event.currentTarget.value))} />
    <div className="arrangement-spacing-scale" aria-hidden="true"><span>Closer</span><span>Farther apart</span></div>
    <p>Molecule sizes stay fixed. Only the spacing between selected compounds changes.</p>
    {arrangement ? <p>Spacing is relative to the chosen layout at 100%. Arrows follow the compounds. Overlapping or off-page previews cannot be saved.</p>
      : <p>The outlined white area is the page. Spacing stops at the page edge or 150%, whichever comes first.</p>}
    <p role="status">{error}</p>
    <footer className="arrangement-spacing-actions">
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="submit" disabled={!preview || busy}>Save</button>
    </footer>
  </form>;
}
