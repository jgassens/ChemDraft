import { useRef, type KeyboardEvent } from "react";
import { detectDialogPlatform, validPageSize, type DialogPlatform, type PageSize, type PageUnit } from "./dialogProtocol";

export interface PageSizeDraft { width: string; height: string; unit: PageUnit }
export const formatPageSizeFieldValue = (value: number): string => Number(value.toFixed(2)).toString();
export const pageSizeUnitShortLabel = (unit: PageUnit): string => unit === "inch" ? "in" : unit === "css-px" ? "px" : unit;
export function pageSizeFromDraft(draft: PageSizeDraft): PageSize | undefined {
  const size = { width: Number(draft.width), height: Number(draft.height), unit: draft.unit };
  return draft.width.trim() && draft.height.trim() && validPageSize(size) ? size : undefined;
}
const cssPxPerUnit: Record<PageUnit, number> = { inch: 96, mm: 96 / 25.4, "css-px": 1 };
export function convertPageSizeDraft(draft: PageSizeDraft, unit: PageUnit): PageSizeDraft {
  const convert = (raw: string) => raw.trim() && Number.isFinite(Number(raw))
    ? formatPageSizeFieldValue(Number(raw) * cssPxPerUnit[draft.unit] / cssPxPerUnit[unit]) : raw;
  return { width: convert(draft.width), height: convert(draft.height), unit };
}
/** Shared body for the native route and browser-only in-page fallback. Holds no document state. */
export function PageSizeForm({ state, title, onChange, onCancel, onApply, busy = false, error,
  platform = detectDialogPlatform() }: {
  state: PageSizeDraft; title: string; onChange(next: PageSizeDraft): void; onCancel(): void;
  onApply(size: PageSize): void; busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const composing = useRef(false);
  const size = pageSizeFromDraft(state);
  const submit = () => { if (size && !busy && !composing.current) onApply(size); };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" || (modifier && event.key.toLowerCase() === "w")) {
      event.preventDefault(); event.stopPropagation(); onCancel();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault(); submit();
    } else if (event.key === "F5" || (modifier && event.key.toLowerCase() === "r")) {
      event.preventDefault();
    }
  };
  return <section className="cd-page-size-form" aria-label="Custom page size" role="dialog" aria-busy={busy}
    onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <h2>Custom Page Size</h2>
    <p>Drawing: <strong>{title}</strong></p>
    <p>Enter the page width and height. Margins are kept from the current page.</p>
    <div className="cd-page-size-fields">
      <label>Width<input autoFocus type="number" min="0" max="100000" step="any" value={state.width}
        onChange={e => onChange({ ...state, width: e.target.value })} aria-describedby={!size ? "page-size-error" : undefined} /></label>
      <span aria-hidden="true">×</span>
      <label>Height<input type="number" min="0" max="100000" step="any" value={state.height}
        onChange={e => onChange({ ...state, height: e.target.value })} aria-describedby={!size ? "page-size-error" : undefined} /></label>
      <label>Units<select value={state.unit} onChange={e => onChange(convertPageSizeDraft(state, e.target.value as PageUnit))}>
        <option value="inch">Inches</option><option value="mm">Millimeters</option>
        {state.unit === "css-px" ? <option value="css-px">Pixels</option> : null}
      </select></label>
    </div>
    <p id="page-size-error" role="status">{error ?? (!size ? "Enter positive width and height (at most 100000)." : "")}</p>
    <div className="cd-page-size-buttons"><button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" disabled={!size || busy} onClick={submit}>Apply</button></div>
  </section>;
}
