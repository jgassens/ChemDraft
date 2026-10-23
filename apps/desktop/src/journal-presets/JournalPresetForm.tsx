import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "../window-manager";
import { useEffect, useId, useRef, useState } from "react";
import { JournalRequestSchema, type JournalRequest } from "@chemdraft/chem-core";
import type { ExportPreviewResult } from "../dialogs/exportOptions";
import { detectDialogPlatform, type DialogPlatform } from "../dialogs/dialogProtocol";
import { initialCustomSettings, initialJournalRequest, isJournalPackLoaded, loadJournalStylePack, journals, resolveJournalProfile, searchJournals } from "./catalog";

export function journalFontWarning(family: string, check: (font: string) => boolean): string | undefined {
  const names = family.split(",").map(name => name.trim().replace(/^["']|["']$/g, "")).filter(name => !["serif", "sans-serif", "monospace", "system-ui"].includes(name));
  return names.length && !names.some(name => check(`12px "${name}"`))
    ? `Requested fonts (${names.join(", ")}) are unavailable. A fallback font will be used; check the exported figure.` : undefined;
}
/** Local drafts only. Native and browser hosts supply the same owner-authorized callbacks. */
export function JournalPresetForm({ title, selectionCount, renderPreview, onApply, onCancel, onReady, busy = false, error,
  platform = detectDialogPlatform() }: {
  title: string; selectionCount: number; renderPreview(request: JournalRequest, signal: AbortSignal): Promise<ExportPreviewResult>;
  onApply(request: JournalRequest): void; onCancel(): void; onReady?(): void; busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const id = useId(), form = useRef<HTMLFormElement>(null), composing = useRef(false);
  const initial = { ...initialJournalRequest, scope: selectionCount ? "selection" as const : "document" as const };
  const [query, setQuery] = useState(""), [request, setRequest] = useState<JournalRequest>(initial);
  const [preview, setPreview] = useState<{ key: string; result: ExportPreviewResult }>();
  const [previewError, setPreviewError] = useState<string>();
  const [packLoaded, setPackLoaded] = useState(isJournalPackLoaded), [packLoading, setPackLoading] = useState(false), [packError, setPackError] = useState<string>();
  const renderer = useRef(renderPreview); renderer.current = renderPreview;
  const ready = useRef(onReady); ready.current = onReady;
  const key = JSON.stringify(request), valid = JournalRequestSchema.safeParse(request).success;
  let profile: ReturnType<typeof resolveJournalProfile> | undefined;
  try { if (valid) profile = resolveJournalProfile(request); } catch { /* Invalid drafts stay local. */ }
  const journal = journals.find(journal => journal.id === profile?.journalId);
  useEffect(() => { ready.current?.(); }, []);
  useEffect(() => {
    setPreview(undefined); setPreviewError(undefined);
    if (!valid || profile?.status === "unverified" || !profile?.figures.some(figure => figure.id === request.figureType)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void renderer.current(request, controller.signal).then(result => {
        if (!controller.signal.aborted) setPreview({ key, result });
      }).catch(e => { if (!controller.signal.aborted) setPreviewError(String(e)); });
    }, 180);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, valid]);
  const choose = (profileId: string) => {
    const next = resolveJournalProfile(profileId === "custom"
      ? { ...request, profileId, custom: initialCustomSettings } : { ...request, profileId, custom: undefined });
    setRequest({ ...request, profileId, figureType: next.figures[0].id, resizeBonds: false,
      ...(profileId === "custom" ? { custom: { ...initialCustomSettings } } : { custom: undefined }) });
  };
  const fontFamily = String(profile?.rules.fontFamily?.value ?? "");
  const fontWarning = typeof document.fonts?.check === "function" ? journalFontWarning(fontFamily, font => document.fonts.check(font)) : "Font availability could not be checked on this host.";
  const applicable = valid && profile?.status !== "unverified" && preview?.key === key && !busy;
  return <form className="journal-preset-form" ref={form} role="dialog" aria-labelledby={`${id}-title`} aria-busy={busy}
    onClick={event => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor && isDesktopRuntime()) {
        event.preventDefault();
        void invoke("dialog_open_journal_source", { url: anchor.href }).catch(error => setPreviewError(String(error)));
      }
    }}
    onSubmit={event => { event.preventDefault(); if (applicable && !composing.current) onApply(request); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "Escape" || modifier && event.key.toLowerCase() === "w") { event.preventDefault(); onCancel(); }
      if (event.key === "F5" || modifier && event.key.toLowerCase() === "r") event.preventDefault();
    }}>
    <h2 id={`${id}-title`}>Journal Presets</h2>
    <p>Drawing: <strong>{title}</strong></p>
    <p>{journals.length} journals available. Source checks cover only the listed rules; they do not certify your drawing or journal acceptance.</p>
    <button type="button" disabled={packLoaded || packLoading} onClick={() => {
      setPackLoading(true); setPackError(undefined);
      void loadJournalStylePack().then(() => setPackLoaded(true)).catch(error => setPackError(String(error))).finally(() => setPackLoading(false));
    }}>{packLoaded ? "Additional journal pack loaded" : packLoading ? "Loading journal pack…" : "Load additional journal pack (15 journals)"}</button>
    {packError ? <p role="alert">{packError}</p> : null}
    <label>Search journals<input autoFocus value={query} placeholder="Journal, publisher, or ISSN" onChange={event => setQuery(event.target.value)} /></label>
    <label>Journal<select aria-label="Journal" value={request.profileId} onChange={event => choose(event.target.value)}>
      {searchJournals(query).map(journal => <option key={journal.id} value={journal.id}>{journal.publisher} — {journal.title}</option>)}
      {request.profileId !== "custom" && !searchJournals(query).some(j => j.id === request.profileId)
        ? <option value={request.profileId}>{journal?.title} (outside search results)</option> : null}
      <option value="custom">Custom preset</option>
    </select></label>
    {!searchJournals(query).length ? <p>No matching journals. You can use Custom preset.</p> : null}
    {journal ? <p>{journal.issns.join(" / ")} · <a href={journal.guidelinesUrl} target="_blank" rel="noreferrer">Official guidelines</a></p> : null}
    <p>{profile?.status === "custom" ? "Custom — no journal verification" : profile?.status === "unverified" ? `Unverified — Apply disabled · verification attempted ${profile.checkedAt}` : `Partial coverage · source rules checked ${profile?.checkedAt ?? "—"}`} · version {profile?.version ?? "—"}</p>
    <p>No journal compliance certificate. Unknown values remain unchanged. Review retained overrides, all pages and the final exported file manually.</p>
    {profile?.status === "unverified" ? <ul>{profile.limitations.map((notice, index) => <li key={index}>{notice}</li>)}</ul> : null}
    <label>Figure type<select value={request.figureType} onChange={event => setRequest({ ...request, figureType: event.target.value })}>
      {profile?.figures.map(figure => <option key={figure.id} value={figure.id}>{figure.label}</option>)}
    </select></label>
    <p>Figure limits: {profile?.figures.find(figure => figure.id === request.figureType)?.maxWidthMm?.toFixed(1) ?? "unspecified"} mm wide × {profile?.figures.find(figure => figure.id === request.figureType)?.maxHeightMm?.toFixed(1) ?? "unspecified"} mm high.
      Formats: {profile?.figures.find(figure => figure.id === request.figureType)?.formats?.join(", ").toUpperCase() ?? "check official instructions"}. Set final dimensions in Export; this preset does not resize the page.</p>
    <label>Apply to<select value={request.scope} onChange={event => setRequest({ ...request, scope: event.target.value as JournalRequest["scope"] })}>
      <option value="document">Whole document (all pages)</option><option value="selection" disabled={!selectionCount}>Selected objects ({selectionCount})</option>
    </select></label>
    {request.profileId === "custom" ? <fieldset><legend>Custom settings (user-defined defaults)</legend>
      {(["fontFamily", "fontSizePt", "lineWidthPt", "bondLengthPt"] as const).map(field => <label key={field}>
        {({ fontFamily: "Font family", fontSizePt: "Font size (pt)", lineWidthPt: "Bond width (pt)", bondLengthPt: "Target bond length (pt)" })[field]}
        <input type={field === "fontFamily" ? "text" : "number"} step="any" min="0.01" value={request.custom?.[field] ?? ""}
          onChange={event => setRequest({ ...request, custom: { ...request.custom!, [field]: field === "fontFamily" ? event.target.value : Number(event.target.value) } })} />
      </label>)}
    </fieldset> : null}
    <label className="journal-resize"><input type="checkbox" checked={request.resizeBonds} disabled={!profile?.rules.bondLength}
      onChange={event => setRequest({ ...request, resizeBonds: event.target.checked })} />Resize molecule coordinates to the target bond length</label>
    <p>{request.resizeBonds ? "Resizing changes molecule sizes around their centres. Review spacing and annotations in the preview." : "Existing molecule coordinates stay fixed. Target bond lengths apply to later drawing operations."}</p>
    <details open><summary>Proposed changes</summary><ul>
      {Object.entries(profile?.rules ?? {}).map(([name, rule]) => rule ? <li key={name}>{({fontFamily:"Font",fontSize:"Font size",lineWidth:"Bond width",bondLength:"Target bond length",boldWidth:"Bold bond width",hashSpacing:"Hash spacing",marginWidth:"Label margin",bondSpacing:"Double-bond spacing"} as Record<string,string>)[name]}: {rule.relation === "minimum" ? "at least " : ""}{rule.value} {rule.unit === "font-stack" ? "" : rule.unit}
        {rule.sourceUrl ? <> · <a href={rule.sourceUrl} target="_blank" rel="noreferrer">Source: {rule.section}</a></> : " · user-defined"}</li> : null)}
    </ul><p>Only molecules and plain text are styled. Existing per-atom, per-bond and rich-text overrides are retained.</p></details>
    <div className="journal-preview">{preview?.key === key ? <img src={preview.result.url} alt="Journal formatting preview of the drawing" /> : <p role="status">{previewError ?? (profile?.status === "unverified" ? "Preview unavailable: journal instructions are unverified." : valid ? "Preparing preview…" : "Enter positive custom values within the allowed range.")}</p>}</div>
    {fontWarning ? <p role="status">{fontWarning}</p> : null}
    <ul className="journal-notices">{preview?.key === key ? preview.result.warnings.map((warning, index) => <li key={index}>{warning}</li>) : null}</ul>
    <p role="alert">{error}</p>
    <footer><button type="button" disabled={busy} onClick={() => { setQuery(""); setRequest(initial); }}>Reset</button>
      <button type="button" onClick={() => choose("custom")} disabled={busy}>Custom preset</button>
      <button type="button" onClick={onCancel}>Cancel</button><button type="submit" disabled={!applicable}>Apply</button></footer>
  </form>;
}
