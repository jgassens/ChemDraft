import { useEffect, useRef, useState } from "react";
import { CMYK_APPROXIMATION_NOTE, hexToRgb, parseCmykColorInput, parseHexColorInput, parseRgbColorInput, rgbToCmyk } from "../customColorSwatches";
import { detectDialogPlatform, type CustomColorSnapshot, type DialogPlatform } from "./dialogProtocol";

type Mode = "Hex" | "RGB" | "CMYK";
function valuesFor(mode: Mode, hex: string): string[] {
  const rgb = hexToRgb(hex)!;
  return mode === "Hex" ? [hex] : mode === "RGB" ? Object.values(rgb).map(String) : Object.values(rgbToCmyk(rgb.r, rgb.g, rgb.b)).map(String);
}

export function CustomColorForm({ initial, onSubmit, onCancel, onClear, onReady, busy = false, error,
  platform = detectDialogPlatform() }: {
  initial: CustomColorSnapshot; onSubmit(hex: string): void; onCancel(): void; onClear(): void;
  onReady?(form: HTMLFormElement): void; busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const form = useRef<HTMLFormElement>(null);
  const readyReported = useRef(false);
  const submitting = useRef(false);
  const composing = useRef(false);
  const [mode, setMode] = useState<Mode>("Hex");
  const [values, setValues] = useState([initial.color ?? "#111111"]);
  const lastValid = useRef(initial.color ?? "#111111");
  const parsed = mode === "Hex" ? parseHexColorInput(values[0]) : mode === "RGB" ? parseRgbColorInput(values[0], values[1], values[2])
    : parseCmykColorInput(values[0], values[1], values[2], values[3]);
  if (parsed.ok) lastValid.current = parsed.hex;
  useEffect(() => { if (!busy) submitting.current = false; }, [busy, error]);
  useEffect(() => {
    if (readyReported.current || !form.current) return;
    readyReported.current = true; onReady?.(form.current);
  }, [onReady]);
  const labels = mode === "Hex" ? ["Hex color"] : mode === "RGB" ? ["Red", "Green", "Blue"] : ["Cyan", "Magenta", "Yellow", "Black"];
  return <form ref={form} className="cd-page-size-form cd-dialog-fit cd-custom-color-form" aria-label="Custom Color" aria-busy={busy}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape" || modifier && event.key.toLowerCase() === "w") { event.preventDefault(); event.stopPropagation(); onCancel(); }
      if (event.key === "F5" || modifier && event.key.toLowerCase() === "r") event.preventDefault();
    }} onSubmit={event => { event.preventDefault(); if (!parsed.ok || busy || submitting.current || composing.current) return; submitting.current = true; onSubmit(parsed.hex); }}>
    <div className="cd-dialog-fit-body"><h2>Custom Color {initial.swatch}, Slot {initial.slot}</h2>
      <label>Color mode<select autoFocus value={mode} disabled={busy} onChange={event => {
        const next = event.target.value as Mode; setMode(next); setValues(valuesFor(next, lastValid.current));
      }}>{(["Hex", "RGB", "CMYK"] as const).map(value => <option key={value}>{value}</option>)}</select></label>
      <div className="cd-page-size-fields">{labels.map((label, index) => <label key={label}>{label}<input type="text" inputMode={mode === "Hex" ? "text" : "decimal"}
        value={values[index]} disabled={busy} aria-invalid={!parsed.ok} aria-describedby="custom-color-error" onChange={event => {
          setValues(current => current.map((value, i) => i === index ? event.target.value : value));
        }} /></label>)}</div>
      <div className="custom-color-preview" role="img" aria-label={`Color preview: ${parsed.ok ? parsed.hex : "invalid color"}`}
        style={{ backgroundColor: parsed.ok ? parsed.hex : "transparent" }} />
      {mode === "CMYK" && <p>{CMYK_APPROXIMATION_NOTE}</p>}
      <p id="custom-color-error" role="status">{error ?? (!parsed.ok ? parsed.message : "")}</p>
    </div><div className="cd-page-size-buttons cd-dialog-fit-footer">
      {initial.color !== null && <button type="button" disabled={busy} onClick={() => { if (submitting.current) return; submitting.current = true; onClear(); }}>Clear</button>}
      <button type="button" onClick={onCancel}>Cancel</button><button type="submit" disabled={!parsed.ok || busy}>OK</button>
    </div>
  </form>;
}
