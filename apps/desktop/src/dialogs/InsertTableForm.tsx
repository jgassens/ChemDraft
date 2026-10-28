import { useRef, useState } from "react";
import { detectDialogPlatform, validInsertTableOptions, type DialogPlatform, type InsertTableOptions } from "./dialogProtocol";

export function InsertTableForm({ title, initial, onSubmit, onCancel, busy = false, error,
  platform = detectDialogPlatform() }: {
  title: string; initial: InsertTableOptions; onSubmit(options: InsertTableOptions): void; onCancel(): void;
  busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const [rows, setRows] = useState(String(initial.rows));
  const [columns, setColumns] = useState(String(initial.columns));
  const [headerRows, setHeaderRows] = useState(String(initial.headerRows));
  const [preset, setPreset] = useState(initial.preset);
  const composing = useRef(false);
  const options = { rows: Number(rows), columns: Number(columns), headerRows: Number(headerRows), preset };
  const valid = [rows, columns, headerRows].every(value => value.trim() !== "") && validInsertTableOptions(options);
  return <form className="cd-page-size-form" aria-label="Insert Table" aria-busy={busy}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape" || modifier && event.key.toLowerCase() === "w") {
        event.preventDefault(); event.stopPropagation(); onCancel();
      }
      if (event.key === "F5" || modifier && event.key.toLowerCase() === "r") event.preventDefault();
    }} onSubmit={event => { event.preventDefault(); if (valid && !busy && !composing.current) onSubmit(options); }}>
    <h2>Insert Table</h2><p>Drawing: <strong>{title}</strong></p>
    <div className="cd-page-size-fields">
      <label>Rows<input autoFocus type="number" min={1} max={500} step={1} value={rows} onChange={e => setRows(e.target.value)} /></label>
      <label>Columns<input type="number" min={1} max={64} step={1} value={columns} onChange={e => setColumns(e.target.value)} /></label>
      <label>Header rows<input type="number" min={0} max={options.rows} step={1} value={headerRows} onChange={e => setHeaderRows(e.target.value)} /></label>
      <label>Style<select value={preset} onChange={e => setPreset(e.target.value as InsertTableOptions["preset"])}>
        <option value="three-line">Three-line</option><option value="grid">Grid</option>
      </select></label>
    </div>
    <p role="status">{error ?? (!valid ? "Enter 1–500 rows, 1–64 columns, and a header count between 0 and the row count." : "")}</p>
    <div className="cd-page-size-buttons"><button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" disabled={!valid || busy}>Insert</button></div>
  </form>;
}
