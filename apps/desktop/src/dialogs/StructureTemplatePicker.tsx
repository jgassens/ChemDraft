import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { structureTemplateFamilyNames } from "@chemdraft/template-library";
import { detectDialogPlatform, type DialogPlatform, type StructureTemplatesSnapshot } from "./dialogProtocol";
import { structureTemplatePickerFamilies } from "./structureTemplatePickerModel";
import { structureTemplateThumbnail } from "./structureTemplateThumbnail";
import "./StructureTemplatePicker.css";

/** Native dialog body and browser fallback. Insertion is a typed owner action, never a document write. */
export function StructureTemplatePicker({ title, templateIds, onInsert, onClose, onReady, busy = false, error,
  platform = detectDialogPlatform() }: StructureTemplatesSnapshot & {
  onInsert(id: string): void; onClose(): void; onReady?(): void; busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const composing = useRef(false);
  const families = structureTemplatePickerFamilies(query, templateIds);
  const ids = families.flatMap(family => family.templates.map(template => template.id));
  const tabStopId = focusedId && ids.includes(focusedId) ? focusedId : ids[0];
  const rows: string[][] = [];
  for (const { templates } of families) {
    let row: string[] = [];
    for (const template of templates) {
      if (template.id.startsWith("pillar-") && row.length) { rows.push(row); row = []; }
      row.push(template.id);
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
  }
  useEffect(() => { search.current?.focus(); onReady?.(); }, [onReady]);
  const focus = (id: string | undefined) => { if (id) { setFocusedId(id); tiles.current.get(id)?.focus(); } };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
    if (event.key === "Escape" || modifier && event.key.toLowerCase() === "w") {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === "F5" || modifier && event.key.toLowerCase() === "r") event.preventDefault();
    else if (event.target === search.current && event.key === "ArrowDown") { event.preventDefault(); focus(ids[0]); }
  };
  const tileKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
    const index = ids.indexOf(id);
    if (event.key === "Enter") {
      event.preventDefault();
      if (!busy) onInsert(id);
      return;
    }
    // Preserve the column across family headings and incomplete rows.
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const rowIndex = rows.findIndex(row => row.includes(id));
      const next = rows[rowIndex + (event.key === "ArrowUp" ? -1 : 1)];
      if (next) focus(next[Math.min(rows[rowIndex]!.indexOf(id), next.length - 1)]);
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step !== undefined || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focus(ids[event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, index + (step ?? 0)))]);
    }
    // Space uses native button activation; Enter's default is suppressed above.
  };
  return <section className="cd-template-picker" role="dialog" aria-label="Structure templates" aria-busy={busy}
    onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <header><h2>Templates</h2><p>Drawing: <strong>{title}</strong></p>
      <label>Search templates<input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </header>
    <div className="cd-template-families">
      {families.map(({ family, templates }) => <section key={family} aria-labelledby={`template-family-${family}`}>
        <h3 id={`template-family-${family}`}>{structureTemplateFamilyNames[family]}</h3>
        <div className="cd-template-grid" role="group" aria-label={structureTemplateFamilyNames[family]}>
          {templates.map((template, index) => {
            const description = [template.formula, ...template.synonyms].join("; ");
            return <button key={template.id} type="button" data-template-id={template.id} aria-label={template.name}
              aria-describedby={`template-description-${template.id}`} title={description} aria-disabled={busy}
              style={template.id.startsWith("pillar-") && index % 2 === 1 ? { gridColumnStart: 1 } : undefined}
              tabIndex={template.id === tabStopId ? 0 : -1} ref={element => { if (element) tiles.current.set(template.id, element); else tiles.current.delete(template.id); }}
              onFocus={() => setFocusedId(template.id)} onKeyDown={event => tileKeyDown(event, template.id)}
              onClick={() => { if (!busy && !composing.current) onInsert(template.id); }}>
              <img src={structureTemplateThumbnail(template)} alt="" draggable={false} />
              <span>{template.name}</span><span className="cd-template-description" id={`template-description-${template.id}`}>{description}</span>
            </button>;
          })}
        </div>
      </section>)}
      {!ids.length && <p role="status">No templates match this search.</p>}
    </div>
    <footer>{error && <p role="alert">{error}</p>}<button type="button" onClick={onClose}>Close</button></footer>
  </section>;
}
