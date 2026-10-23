import { useEffect, useId, useRef, useState } from "react";
import { nativeFormattedTextObjectSize, type ReactionConditionsDraft } from "@chemdraft/document-workflow-core";
import { nativeTextObjectLineMetrics, nativeTextSpanMetrics } from '@chemdraft/layout-engine';
import { detectDialogPlatform, validConditionsDraft, type DialogPlatform } from "./dialogProtocol";

type Script = ReactionConditionsDraft["spans"][number]["script"];
const characters = (draft: ReactionConditionsDraft) => draft.spans.flatMap(span => span.text.split("").map(text => ({ text, script: span.script })));
function pack(chars: { text: string; script: Script }[]): ReactionConditionsDraft["spans"] {
  const spans: ReactionConditionsDraft["spans"] = [];
  for (const char of chars) {
    const last = spans[spans.length - 1];
    if (last?.script === char.script) last.text += char.text;
    else spans.push({ ...char });
  }
  return spans;
}
export function changeConditionsText(draft: ReactionConditionsDraft, text: string, script: Script,
  edit?: { start: number; end: number }): ReactionConditionsDraft {
  const old = characters(draft), previous = old.map(char => char.text).join("");
  if (edit && edit.start >= 0 && edit.end >= edit.start && edit.end <= previous.length &&
      text.length >= edit.start + previous.length - edit.end &&
      text.startsWith(previous.slice(0, edit.start)) && text.endsWith(previous.slice(edit.end))) {
    const inserted = text.slice(edit.start, text.length - (previous.length - edit.end));
    return { ...draft, spans: pack([...old.slice(0, edit.start),
      ...inserted.split("").map(text => ({ text, script })), ...old.slice(edit.end)]) };
  }
  let prefix = 0, suffix = 0;
  while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
  while (suffix < previous.length - prefix && suffix < text.length - prefix && previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  return { ...draft, spans: pack([...old.slice(0, prefix), ...text.slice(prefix, text.length - suffix).split("").map(text => ({ text, script })), ...old.slice(old.length - suffix)]) };
}

export function ReactionConditionsForm({ title, draft, onChange, onSave, onCancel, busy = false, error,
  platform = detectDialogPlatform() }: { title: string; draft: ReactionConditionsDraft; onChange(draft: ReactionConditionsDraft): void;
  onSave(): void; onCancel(): void; busy?: boolean; error?: string; platform?: DialogPlatform }) {
  const id = useId(), textarea = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const pendingEdit = useRef<{ start: number; end: number; inputType: string } | undefined>(undefined);
  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const captureEdit = (event: InputEvent) => {
      pendingEdit.current = { start: field.selectionStart, end: field.selectionEnd, inputType: event.inputType };
    };
    field.addEventListener("beforeinput", captureEdit);
    return () => field.removeEventListener("beforeinput", captureEdit);
  }, []);
  const [script, setScript] = useState<Script>("normal");
  const text = draft.spans.map(span => span.text).join("");
  const valid = validConditionsDraft(draft);
  const selectScript = (value: Script) => {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    setScript(value);
    if (start !== end) onChange({ ...draft, spans: pack(characters(draft).map((char, i) => i >= start && i < end ? { ...char, script: value } : char)) });
    field.focus(); field.setSelectionRange(start, end);
  };
  const insert = (symbol: string) => {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    onChange({ ...draft, spans: pack([...characters(draft).slice(0, start), { text: symbol, script }, ...characters(draft).slice(end)]) });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + symbol.length, start + symbol.length); });
  };
  return <form className="reaction-conditions-form" role="dialog" aria-labelledby={id} aria-busy={busy}
    onSubmit={event => { event.preventDefault(); if (valid && !busy && !composing.current) onSave(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || composing.current) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape" || modifier && event.key.toLowerCase() === "w") { event.preventDefault(); onCancel(); }
      if (event.key === "F5" || modifier && event.key.toLowerCase() === "r") event.preventDefault();
    }}>
    <h2 id={id}>Reaction conditions</h2>
    <p>Drawing: <strong>{title}</strong></p>
    <label htmlFor={`${id}-text`}>Reagents, temperature, time, or yield</label>
    <div className="reaction-conditions-tools" role="group" aria-label="Conditions symbols and formatting">
      {["°", "±", "−", "Δ", "ν", "μ", "·", "×"].map(symbol => <button key={symbol} type="button" disabled={busy}
        aria-label={`Insert ${symbol}`} onPointerDown={event => event.preventDefault()} onClick={() => insert(symbol)}>{symbol}</button>)}
      {(["normal", "subscript", "superscript"] as const).map(value => <button key={value} type="button" disabled={busy}
        aria-label={value} aria-pressed={script === value} onPointerDown={event => event.preventDefault()} onClick={() => selectScript(value)}>
        {value === "normal" ? "Normal" : value === "subscript" ? <>X<sub>2</sub></> : <>X<sup>2</sup></>}
      </button>)}
    </div>
    <textarea id={`${id}-text`} ref={textarea} autoFocus rows={5} maxLength={2000} value={text} disabled={busy}
      placeholder={"e.g. K₂CO₃, THF\n80 °C, 2 h\n85% yield"}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={event => {
        let edit = pendingEdit.current; pendingEdit.current = undefined;
        if (edit && edit.start === edit.end && edit.inputType.startsWith("delete")) {
          const removed = Math.max(0, text.length - event.currentTarget.value.length);
          if (edit.inputType.endsWith("Backward")) edit = { ...edit, start: Math.max(0, edit.start - removed) };
          else if (edit.inputType.endsWith("Forward")) edit = { ...edit, end: Math.min(text.length, edit.end + removed) };
        }
        onChange(changeConditionsText(draft, event.currentTarget.value, script, edit));
      }} />
    <p>Select text to format it, or choose a format before typing.</p>
    <div className="reaction-conditions-preview" aria-label="Formatted preview">
      {text ? <ConditionsPreview draft={draft} /> : "Formatted preview"}
    </div>
    <label htmlFor={`${id}-side`}>Label position</label>
    <select id={`${id}-side`} value={draft.side} disabled={busy} onChange={event => onChange({ ...draft, side: event.currentTarget.value as ReactionConditionsDraft["side"] })}>
      <option value="above">Top / inside</option><option value="below">Bottom / outside</option>
    </select>
    <p>Labels follow their arrow. Top uses the inside of a curve; Bottom uses the outside. Straight arrows use page top and bottom. Drag a label to adjust crowded positions, or double-click to edit. Clear the text to remove it.</p>
    <p role="status">{error ?? (!valid ? "Shorten the conditions or use fewer formatting changes to save." : "")}</p>
    <footer><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy || !valid}>Save</button></footer>
  </form>;
}

function ConditionsPreview({draft}:{draft:ReactionConditionsDraft}) {
  const object={text:draft.spans.map(span=>span.text).join(''),spans:draft.spans.map(span=>({...span,style:{}})),style:{fontSizePx:16,textAlign:'center'}};
  const size=nativeFormattedTextObjectSize(object),layout=nativeTextObjectLineMetrics(object);
  return <svg width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={object.text}
    style={{display:'block',margin:'0 auto',overflow:'visible'}}><text textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fill="currentColor" xmlSpace="preserve">
      {layout.lines.map((line,i)=>{
        let previousOffset=0;
        return <tspan key={i} x={size.width/2} y={line.baseline}>{line.spans.map((span,j)=>{
          const metrics=nativeTextSpanMetrics(span,object.style),dy=metrics.offset-previousOffset;previousOffset=metrics.offset;
          return <tspan key={j} data-text-script={span.script} dy={dy||undefined} fontSize={metrics.fontSize}>{span.text}</tspan>;
        })}</tspan>;
      })}
    </text></svg>;
}
