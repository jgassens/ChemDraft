import { useEffect, useMemo, useRef, useState } from "react";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { adjustArrangementSpacing, arrangementSpacingRange, arrangementSpacingPreviewBounds } from "./documentWorkflow";
import { ArrangementSpacingForm } from "./dialogs/ArrangementSpacingForm";

export function frameArrangementSpacingPreviewSvg(svg: string, pageWidth: number, pageHeight: number): string {
  const padding = Math.max(pageWidth, pageHeight) * 0.025;
  const width = pageWidth + padding * 2, height = pageHeight + padding * 2;
  const root = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) throw new Error("SVG export did not contain a root element.");
  const attributes: [string, number | string][] = [["width", width], ["height", height], ["viewBox", `${-padding} ${-padding} ${width} ${height}`]];
  const framedRoot = attributes.reduce((tag, [name, value]) => {
    const attribute = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, "i");
    if (attribute.test(tag)) return tag.replace(attribute, `$1"${value}"`);
    return tag.replace(/\/?>(?=$)/, ` ${name}="${value}"$&`);
  }, root);
  return svg.replace(root, `${framedRoot}\n<rect x="${-padding}" y="${-padding}" width="${width}" height="${height}" fill="#e5e7eb" />`)
    .replace("</svg>", `<rect data-arrangement-page-boundary="true" x="0" y="0" width="${pageWidth}" height="${pageHeight}" fill="none" stroke="#64748b" stroke-width="1" vector-effect="non-scaling-stroke" />\n</svg>`);
}

/** Runs only in the document owner; native forms receive previews, never documents. */
export function arrangementSpacingPreviewSvg(source: ChemDraftDocument, percent: number): string {
  const result = adjustArrangementSpacing(source, percent / 100);
  if (!result.ok) throw new Error(result.status);
  if (!arrangementSpacingPreviewBounds(source)) throw new Error("Select at least two compounds or groups.");
  const pageIndex = source.pages.findIndex(page => page.id === source.selection.pageId);
  if (pageIndex < 0) throw new Error("The selected page is unavailable.");
  const page = source.pages[pageIndex];
  // Keep the whole page and its scale fixed while the compounds move. These decorations belong
  // only to the preview: document geometry and ordinary exports remain untouched.
  return frameArrangementSpacingPreviewSvg(
    exportDocumentToSvg(result.document, { pageIndex, includePageGuides: false, includeWarnings: false }).contents,
    page.width, page.height
  );
}

/** Browser-only fallback. Desktop opens the same form through DialogCoordinator. */
export function ArrangementSpacingDialog({ document: source, onSave, onCancel }: {
  document: ChemDraftDocument; onSave(factor: number): void; onCancel(): void;
}) {
  const [percent, setPercent] = useState(100);
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const range = useMemo(() => arrangementSpacingRange(source), [source]);
  const preview = useMemo(() => {
    try { return { image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(arrangementSpacingPreviewSvg(source, percent))}` }; }
    catch (error) { return { error: String(error) }; }
  }, [source, percent]);
  useEffect(() => {
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); };
  }, []);
  return <div className="plugin-prompt-backdrop" role="presentation"><ArrangementSpacingForm modal title={source.title}
    minPercent={Math.round(range.min * 100)} maxPercent={Math.round(range.max * 100)} percent={percent}
    onChange={setPercent} preview={preview.image} error={preview.error} onCancel={onCancel} onSave={() => onSave(percent / 100)} /></div>;
}
