import { useEffect, useRef, useState, useMemo, type CSSProperties, type FormEvent } from "react";
import { exportFormatDescriptors, getExportFormatDescriptor, type ExportFormatId, type ExportFormatDescriptor, type ExportFormatGroup } from "@chemdraft/export-engine";
import { useExportPreviewEnabled } from "./useExportPreviewEnabled";
import { isDesktopRuntime } from "../window-manager";
import type { NativeRasterExportFormat } from "../nativeRasterExport";
import type { ExportOptions, ExportFrame, ExportPreviewResult, ExportDialogState, ExportDialogFormat, SvgDialogExportOptions, PdfDialogExportOptions, RasterDialogExportOptions, CdxmlDialogExportOptions } from "./exportOptions";
import { exportOptions, validExportOptions } from "./exportOptionsValidation";
import { detectDialogPlatform, type DialogPlatform } from "./dialogProtocol";
import { defaultExportPresentation, exportDialogHeight, exportDialogSizeError } from "./exportPresentation";
const rasterExportFormatsByFormatId: Partial<Record<ExportFormatId, NativeRasterExportFormat>> = {
  png: "png",
  jpeg: "jpeg",
  bmp: "bmp",
  gif: "gif",
  tiff: "tiff"
};
const exportFormatGroups: readonly ExportFormatGroup[] = ["graphics", "chemistry", "compatibility", "legacy", "model3d"];
const exportFormatGroupLabels: Record<ExportFormatGroup, string> = {
  graphics: "Graphics",
  chemistry: "Chemistry",
  compatibility: "Compatibility",
  legacy: "Legacy",
  model3d: "3D"
};
const exportFormatOptionExtensions = [...new Set(exportFormatDescriptors.flatMap((descriptor) => descriptor.extensions))];
interface ExportDialogProps {
  state: ExportDialogState;
  previewEnabled: boolean;
  frame?: ExportFrame;
  renderPreview?: (options: ExportOptions, signal?: AbortSignal) => Promise<ExportPreviewResult>;
  onPresentationChange: (options: Partial<NonNullable<ExportDialogState["presentation"]>>) => void;
  onCancel: () => void;
  onChooseDestination: () => void | Promise<void>;
  onFilenameChange: (filename: string) => void;
  onFormatChange: (format: ExportDialogFormat) => void;
  onSvgOptionsChange: (options: Partial<SvgDialogExportOptions>) => void;
  onPdfOptionsChange: (options: Partial<PdfDialogExportOptions>) => void;
  onRasterOptionsChange: (options: Partial<RasterDialogExportOptions>) => void;
  onCdxmlOptionsChange: (options: Partial<CdxmlDialogExportOptions>) => void;
  title?: string;
  error?: string;
  notice?: string;
  completed?: boolean;
  platform?: DialogPlatform;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

function ExportFormBody({
  state, previewEnabled, frame, renderPreview, onPresentationChange,
  onCancel,
  onChooseDestination,
  onFilenameChange,
  onFormatChange,
  onSvgOptionsChange,
  onPdfOptionsChange,
  onRasterOptionsChange,
  onCdxmlOptionsChange,
  onSubmit, title, error, notice, completed, platform = detectDialogPlatform()
}: ExportDialogProps) {
  const composing = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (completed) closeButton.current?.focus(); }, [completed]);
  useEffect(() => {
    const closeOnKey = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if ((event.key === "Escape" && !(event.target instanceof HTMLSelectElement && keyboardPreset.current)) || (modifier && event.key.toLowerCase() === "w")) {
        event.preventDefault(); event.stopPropagation(); onCancel();
      }
    };
    document.addEventListener("keydown", closeOnKey, true);
    return () => document.removeEventListener("keydown", closeOnKey, true);
  }, [onCancel, platform]);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error || notice) feedback.current?.scrollIntoView?.({ block: "nearest" }); }, [error, notice]);
  const defaultPresentation = useMemo(() => defaultExportPresentation(frame?.page ?? { width: 800, height: 600 }), [frame?.page.width, frame?.page.height]);
  const presentation = state.presentation ?? defaultPresentation;
  const visual = state.format === "svg" || state.format === "pdf" || rasterExportFormatForDialogFormat(state.format) !== undefined;
  const dimensions = frame?.[presentation.crop] ?? frame?.page ?? { width: 800, height: 600 };
  const ratio = dimensions.height / dimensions.width;
  const sizeError = previewEnabled && visual ? exportDialogSizeError({ ...state, presentation }, ratio) : undefined;
  const width = presentation.width;
  const height = exportDialogHeight(presentation, ratio);
  const dpi = presentation.dpi;
  const [pendingPreset, setPendingPreset] = useState<string | undefined>();
  const [physicalDraft, setPhysicalDraft] = useState<{ axis: "width" | "height"; value: string } | undefined>();
  const keyboardPreset = useRef(false);
  useEffect(() => {
    keyboardPreset.current = false;
    setPendingPreset(undefined);
    setPhysicalDraft(undefined);
  }, [previewEnabled]);
  const presetValue = presentation.preset ?? "custom";
  useEffect(() => { setPendingPreset(undefined); }, [presentation]);
  const changePresentation = (options: Partial<NonNullable<ExportDialogState["presentation"]>>) => onPresentationChange({ ...options, ...(presentation.linked !== false && ("width" in options || "crop" in options) && !("height" in options) ? { height: undefined } : {}), preset: "custom" });
  const numberValue = (value: number) => Number.isFinite(value) && value !== 0 ? value : "";
  const readNumber = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const applyPreset = (value: string) => {
    keyboardPreset.current = false;
    setPendingPreset(undefined);
    const presets = { slide: { width: 1920, dpi: 96 }, poster: { width: 7200, dpi: 300 }, publication: { width: 2008, dpi: 600 } };
    const key = value as keyof typeof presets;
    const preset = presets[key];
    if (!preset) { onPresentationChange({ preset: "custom" }); return; }
    const presetRatio = (frame?.content.height ?? 1) / (frame?.content.width ?? 1);
    onPresentationChange({ ...preset, width: Math.max(1, Math.floor(preset.width / Math.max(1, presetRatio))), height: undefined, linked: true, preset: key, crop: "content", background: "white" });
  };
  const [preview, setPreview] = useState<{ result?: ExportPreviewResult; error?: string }>({});
  const previewRenderer = useRef(renderPreview);
  previewRenderer.current = renderPreview;
  const previewKey = previewEnabled ? JSON.stringify({ format: state.format, presentation, svg: state.svg, pdf: state.pdf, raster: state.raster, frame }) : "";
  const previewOptionsValid = previewEnabled && validExportOptions(exportOptions({ ...state, filename: "Preview" }));
  useEffect(() => {
    if (!previewEnabled) return;
    let active = true;
    const controller = new AbortController();
    setPreview({});
    if (state.busy || !visual || sizeError || !previewOptionsValid || !renderPreview) return;
    const timer = window.setTimeout(() => {
      void previewRenderer.current?.(exportOptions(state), controller.signal).then(result => {
        if (active) setPreview({ result });
      }).catch((error: unknown) => {
        if (active) setPreview({ error: error instanceof Error ? error.message : String(error) });
      });
    }, 250);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [previewEnabled, previewKey, state.busy, visual, sizeError, previewOptionsValid, !!renderPreview]);
  const descriptor = getExportFormatDescriptor(state.format);
  const implemented = descriptor.status === "implemented";
  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  const destinationLabel = state.destinationPath ?? (isDesktopRuntime() ? "Choose a location" : "Downloads");
  const exportDisabled = sizeError !== undefined || state.busy || !validExportOptions(exportOptions(state)) || !implemented;

  return (
    <section aria-label="Export" role="dialog" aria-modal={isDesktopRuntime() ? undefined : true} aria-busy={state.busy}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Tab") {
          const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled),object[tabindex="0"]'));
          const first = fields[0], last = fields.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement && (!previewEnabled || event.target.type !== "checkbox")) {
          event.preventDefault(); if (!exportDisabled) event.currentTarget.querySelector("form")?.requestSubmit();
        }
      }}>
      <form style={{ ...exportDialogPanelStyle, height: isDesktopRuntime() ? "100vh" : undefined, maxHeight: isDesktopRuntime() ? "100vh" : "calc(100vh - 64px)" }}
        onSubmit={event => { event.preventDefault(); if (!composing.current && !exportDisabled) void onSubmit(event); }}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Export</h2>
          <button
            aria-label="Close export"
            type="button"
            style={exportDialogIconButtonStyle}
            onClick={onCancel}
          >
            x
          </button>
        </div>

        <div style={exportDialogBodyStyle}>
        {title ? <p style={exportDialogHintStyle}>Drawing: <strong>{title}</strong></p> : null}
        {error ? <p ref={feedback} role="alert" style={exportDialogWarningStyle}>{error}</p> : null}
        {notice ? <p ref={error ? undefined : feedback} role="status" style={{ ...exportDialogHintStyle, whiteSpace: "pre-wrap" }}>{notice}</p> : null}
        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-filename">
          Save as
        </label>
        <input
          autoFocus
          id="chemdraft-export-filename"
          disabled={state.busy}
          value={state.filename}
          style={exportDialogInputStyle}
          onChange={(event) => onFilenameChange(event.currentTarget.value)}
        />

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-format">
          Export as
        </label>
        <select
          id="chemdraft-export-format"
          disabled={state.busy}
          value={state.format}
          style={exportDialogInputStyle}
          onChange={(event) => {
            onFormatChange(event.currentTarget.value as ExportDialogFormat);
          }}
        >
          {exportFormatGroups.map((group) => (
            <optgroup key={group} label={exportFormatGroupLabels[group]}>
              {exportFormatDescriptors
                .filter((candidate) => candidate.group === group)
                .map((candidate) => {
                  const rasterOnly = rasterExportFormatForDialogFormat(candidate.id) !== undefined;
                  const unavailableInBrowser = rasterOnly && !isDesktopRuntime();
                  return (
                    <option key={candidate.id} value={candidate.id} disabled={unavailableInBrowser}>
                      {candidate.label}
                      {candidate.status === "implemented" ? "" : ` (${candidate.status})`}
                      {unavailableInBrowser ? " (desktop only)" : ""}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
        {descriptor.warningSummary || !implemented ? (
          <p style={implemented ? exportDialogHintStyle : exportDialogWarningStyle}>
            {descriptor.warningSummary ?? `${descriptor.menuLabel} export is not available yet.`}
          </p>
        ) : null}

        {previewEnabled && visual ? <fieldset style={exportDialogFieldsetStyle}>
          <legend style={exportDialogLegendStyle}>Preview and size</legend>
          <label style={exportDialogLabelStyle}>Preset
            <select aria-label="Size preset" disabled={state.busy} value={pendingPreset ?? presetValue} style={exportDialogInputStyle}
              onPointerDown={() => { keyboardPreset.current = false; }}
              onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) keyboardPreset.current = true;
                if (event.key === "Enter" && keyboardPreset.current) { event.preventDefault(); event.stopPropagation(); applyPreset(event.currentTarget.value); }
                if (event.key === "Escape" && keyboardPreset.current) { event.preventDefault(); event.stopPropagation(); keyboardPreset.current = false; setPendingPreset(undefined); }
              }}
              onBlur={(event) => { if (keyboardPreset.current) applyPreset(event.currentTarget.value); }}
              onChange={(event) => { if (keyboardPreset.current) setPendingPreset(event.currentTarget.value); else applyPreset(event.currentTarget.value); }}
            ><option value="custom">Custom</option><option value="slide">Slide - 1920 px longest side, 96 DPI</option><option value="poster">Poster - 24 in longest side, 300 DPI</option><option value="publication">Publication - 85 mm longest side, 600 DPI</option></select>
          </label>
          <label style={exportDialogLabelStyle}>Crop
            <select disabled={state.busy} value={presentation.crop} onChange={(event) => changePresentation({ crop: event.currentTarget.value as "page" | "content" })}><option value="page">Page</option><option value="content">Content with padding</option></select>
          </label>
          <label style={exportDialogLabelStyle}><input type="checkbox" disabled={state.busy} checked={presentation.linked !== false} onChange={(event) => changePresentation({ linked: event.currentTarget.checked, height: event.currentTarget.checked ? undefined : height })} />Link width and height</label>
          <label style={exportDialogLabelStyle}>Width (px)<input disabled={state.busy} type="number" min={1} max={8192} value={numberValue(width)} onChange={(event) => changePresentation({ width: readNumber(event.currentTarget.value) })} /></label>
          <label style={exportDialogLabelStyle}>Height (px){presentation.linked !== false ? " (aspect ratio linked)" : ""}<input disabled={state.busy} type="number" min={1} max={8192} value={numberValue(height)} onChange={(event) => changePresentation(presentation.linked === false ? { height: readNumber(event.currentTarget.value) } : { height: readNumber(event.currentTarget.value), width: Math.round(readNumber(event.currentTarget.value) / ratio) })} /></label>
          <label style={exportDialogLabelStyle}>DPI<input disabled={state.busy} type="number" min={36} max={1200} step="any" value={numberValue(dpi)} onChange={(event) => changePresentation({ dpi: readNumber(event.currentTarget.value) })} /></label>
          <label style={exportDialogLabelStyle}>Physical width (mm)<input disabled={state.busy} type="text" inputMode="decimal" value={physicalDraft?.axis === "width" ? physicalDraft.value : numberValue(Number((width / dpi * 25.4).toFixed(2)))} onBlur={() => setPhysicalDraft(undefined)} onChange={(event) => {
            const value = event.currentTarget.value;
            setPhysicalDraft({ axis: "width", value });
            changePresentation({ width: Math.round(readNumber(value) / 25.4 * dpi) });
          }} /></label>
          <label style={exportDialogLabelStyle}>Physical height (mm)<input disabled={state.busy} type="text" inputMode="decimal" value={physicalDraft?.axis === "height" ? physicalDraft.value : numberValue(Number((height / dpi * 25.4).toFixed(2)))} onBlur={() => setPhysicalDraft(undefined)} onChange={(event) => {
            const value = event.currentTarget.value;
            const pixels = Math.round(readNumber(value) / 25.4 * dpi);
            setPhysicalDraft({ axis: "height", value });
            changePresentation(presentation.linked === false ? { height: pixels } : { height: pixels, width: Math.round(pixels / ratio) });
          }} /></label>
          {sizeError ? <p role="alert" style={exportDialogWarningStyle}>{sizeError}</p> : null}
          <p style={exportDialogHintStyle}>{numberValue(width)} × {numberValue(height)} px · {Number.isFinite(width / dpi) ? (width / dpi * 25.4).toFixed(1) : "--"} × {Number.isFinite(height / dpi) ? (height / dpi * 25.4).toFixed(1) : "--"} mm{state.format === "png" && state.presentation ? " · PNG density embedded" : " · physical size derived from DPI"}</p>
          {state.format === "svg" ? <label style={exportDialogLabelStyle}>Background<select disabled={state.busy} value={presentation.background} onChange={(event) => onPresentationChange({ background: event.currentTarget.value as "white" | "transparent" })}><option value="white">White</option><option value="transparent">Transparent</option></select></label> : null}
          <div style={{ background: "#ddd", minHeight: 160, padding: 8 }} aria-label="Actual export renderer preview">
            {preview.result ? preview.result.kind === "pdf"
              ? <object tabIndex={0} aria-label="PDF export preview" data={preview.result.url} type="application/pdf" width="100%" height="220">PDF preview</object>
              : <img src={preview.result.url} alt="Export preview" style={{ width: "100%", height: 220, objectFit: "contain" }} />
              : <p role="status">{preview.error ?? (sizeError ? "Correct the size to render a preview." : renderPreview ? "Rendering preview…" : "Preview unavailable")}</p>}
          </div>
          {(preview.result?.warnings ?? []).map((warning, index) => <p key={index} role="status" style={exportDialogWarningStyle}>{warning}</p>)}
        </fieldset> : null}
        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-destination">
          Where
        </label>
        <div style={exportDialogDestinationRowStyle}>
          <input
            id="chemdraft-export-destination"
            readOnly
            value={destinationLabel}
            style={{ ...exportDialogInputStyle, ...exportDialogDestinationInputStyle }}
          />
          <button
            disabled={(previewEnabled ? exportDisabled : state.busy || !implemented) || !isDesktopRuntime()}
            type="button"
            style={exportDialogButtonStyle}
            onClick={() => {
              void onChooseDestination();
            }}
          >
            Choose...
          </button>
        </div>

        {state.format === "svg" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>SVG</legend>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includeWarnings}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includeWarnings: event.currentTarget.checked })}
              />
              Include warning metadata
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {state.format === "pdf" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>PDF</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-type">
              PDF type
            </label>
            <select
              id="chemdraft-export-pdf-type"
              disabled={state.busy}
              value={state.pdf.pdfType}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="vector">Vector PDF</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-page">
              Page
            </label>
            <select
              id="chemdraft-export-pdf-page"
              disabled={state.busy}
              value={state.pdf.page}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="current">Current page</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-background">
              Background
            </label>
            <select
              id="chemdraft-export-pdf-background"
              disabled={state.busy}
              value={state.pdf.background}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="white">White page</option>
            </select>

            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.compress}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ compress: event.currentTarget.checked })}
              />
              Compress PDF
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {rasterFormat ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>{descriptor.menuLabel}</legend>
            {!previewEnabled ? <>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-scale">
              Scale
            </label>
            <select
              id="chemdraft-export-raster-scale"
              disabled={state.busy}
              value={String(state.raster.scale)}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ scale: Number(event.currentTarget.value) })}
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
              <option value="4">4x</option>
            </select>

            </> : null}
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-background">
              Background
            </label>
            <select
              id="chemdraft-export-raster-background"
              disabled={state.busy}
              value={state.raster.background}
              style={exportDialogInputStyle}
              onChange={(event) => {
                const value = event.currentTarget.value === "transparent" ? "transparent" : "white";
                onRasterOptionsChange({ background: value });
              }}
            >
              <option value="white">White page</option>
              <option value="transparent" disabled={rasterFormat !== "png"}>
                Transparent
              </option>
            </select>

            {!previewEnabled ? <>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-max">
              Max dimension
            </label>
            <input
              id="chemdraft-export-raster-max"
              disabled={state.busy}
              min={256}
              max={8192}
              step={256}
              type="number"
              value={state.raster.maxDimensionPx}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ maxDimensionPx: Number(event.currentTarget.value) })}
            />

            </> : null}
            {rasterFormat === "jpeg" ? (
              <>
                <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-jpeg-quality">
                  JPEG quality
                </label>
                <input
                  id="chemdraft-export-jpeg-quality"
                  disabled={state.busy}
                  min={1}
                  max={100}
                  step={1}
                  type={previewEnabled ? "number" : "range"}
                  value={state.raster.jpegQuality}
                  style={exportDialogInputStyle}
                  onChange={(event) => onRasterOptionsChange({ jpegQuality: Number(event.currentTarget.value) })}
                />
              </>
            ) : null}
          </fieldset>
        ) : null}

        {state.format === "cdxml" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>CDXML</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-cdxml-program">
              Creation program
            </label>
            <input
              id="chemdraft-export-cdxml-program"
              disabled={state.busy}
              value={state.cdxml.creationProgram}
              style={exportDialogInputStyle}
              onChange={(event) => onCdxmlOptionsChange({ creationProgram: event.currentTarget.value })}
            />
          </fieldset>
        ) : null}

        </div>
        <div style={exportDialogFooterStyle}>
          <button ref={closeButton} type="button" style={exportDialogButtonStyle} onClick={onCancel}>
            {completed ? "Close" : "Cancel"}
          </button>
          <button disabled={exportDisabled} type="submit" style={exportDialogPrimaryButtonStyle}>
            {completed ? "Exported" : state.busy ? "Exporting..." : "Export"}
          </button>
        </div>
      </form>
    </section>
  );
}


export function ExportForm({ state: ownerState, onChange: publish, onReady, ...props }: {
  state: ExportDialogState; onChange(state: ExportDialogState): void; onReady?(): void;
} & Pick<ExportDialogProps, "onCancel" | "onChooseDestination" | "onSubmit" | "title" | "error" | "notice" | "completed" | "platform" | "frame" | "renderPreview">) {
  const previewEnabled = useExportPreviewEnabled();
  const [draft, setDraft] = useState<ExportDialogState>();
  // Turning the feature off returns to legacy options; no hidden size draft affects export.
  useEffect(() => {
    if (!previewEnabled) {
      setDraft(undefined);
      if (ownerState.presentation) publish({ ...ownerState, presentation: undefined });
    }
  }, [previewEnabled, ownerState, publish]);
  const source = previewEnabled && draft ? { ...draft, busy: ownerState.busy } : ownerState;
  const state = previewEnabled ? source : { ...source, presentation: undefined };
  const onChange = (next: ExportDialogState) => {
    const dimensions = props.frame?.[next.presentation?.crop ?? "page"] ?? props.frame?.page ?? { width: 800, height: 600 };
    if (previewEnabled && (!validExportOptions(exportOptions(next)) || (next.presentation && exportDialogSizeError(next, dimensions.height / dimensions.width)))) {
      // Invalid drafts stay local: the native protocol accepts only valid options.
      setDraft(next);
    } else {
      setDraft(undefined);
      publish(next);
    }
  };
  useEffect(() => { onReady?.(); }, [onReady]);
  return <ExportFormBody {...props} state={state} previewEnabled={previewEnabled}
    onPresentationChange={presentation => onChange({ ...state, presentation: { ...(state.presentation ?? defaultExportPresentation(props.frame?.page ?? { width: 800, height: 600 })), ...presentation }, ...(presentation.preset && presentation.preset !== "custom" ? { raster: { ...state.raster, background: "white", maxDimensionPx: 8192, jpegQuality: 90 } } : {}) })}
    onFilenameChange={filename => onChange({ ...state, filename, destinationPath: undefined })}
    onFormatChange={format => {
      const visual = format === "svg" || format === "pdf" || rasterExportFormatForDialogFormat(format) !== undefined;
      // Hidden size fields must not leave a chemistry export trapped in an invalid draft.
      const next = !visual && draft ? { ...state, presentation: ownerState.presentation, raster: ownerState.raster } : state;
      onChange(updateExportDialogFormat(next, format));
    }}
    onSvgOptionsChange={svg => onChange({ ...state, svg: { ...state.svg, ...svg } })}
    onPdfOptionsChange={pdf => onChange({ ...state, pdf: { ...state.pdf, ...pdf } })}
    onRasterOptionsChange={raster => onChange({ ...state, raster: { ...state.raster, ...raster } })}
    onCdxmlOptionsChange={cdxml => onChange({ ...state, cdxml: { ...state.cdxml, ...cdxml } })} />;
}
export function updateExportDialogFormat(state: ExportDialogState, format: ExportDialogFormat): ExportDialogState {
  const descriptor = getExportFormatDescriptor(format);
  const rasterFormat = rasterExportFormatForDialogFormat(format);
  const filename = replaceExportFileExtension(state.filename, descriptor);
  return {
    ...state,
    format,
    filename,
    destinationPath: undefined,
    raster: {
      ...state.raster,
      background: rasterFormat === "png" ? state.raster.background : "white"
    }
  };
}

export function rasterExportFormatForDialogFormat(format: ExportFormatId): NativeRasterExportFormat | undefined {
  return rasterExportFormatsByFormatId[format];
}

function replaceExportFileExtension(filename: string, descriptor: ExportFormatDescriptor): string {
  const extension = descriptor.extensions[0] ?? descriptor.id;
  const trimmed = filename.trim() || "Untitled";
  const escapedExtensions = exportFormatOptionExtensions.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const knownExportExtension = new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
  return `${trimmed.replace(knownExportExtension, "")}.${extension}`;
}

const exportDialogPanelStyle: CSSProperties = {
  background: "#f7f9fb",
  border: "1px solid #b7c1ca",
  borderRadius: 8,
  boxShadow: "0 18px 48px rgba(20, 30, 40, 0.22)",
  color: "#18212a",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  gap: 8,
  maxHeight: "100vh",
  maxWidth: "100%",
  overflow: "hidden",
  padding: 16,
  width: "100%",
  boxSizing: "border-box"
};

const exportDialogBodyStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  minHeight: 0,
  overflowY: "auto"
};

const exportDialogHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 4
};

const exportDialogTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 650,
  lineHeight: 1.2,
  margin: 0
};

const exportDialogLabelStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogInputStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  boxSizing: "border-box",
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 8px",
  width: "100%"
};

const exportDialogHintStyle: CSSProperties = {
  color: "#52606d",
  fontSize: 12,
  lineHeight: 1.3,
  margin: "0 0 2px"
};

const exportDialogWarningStyle: CSSProperties = {
  ...exportDialogHintStyle,
  color: "#875300"
};

const exportDialogDestinationRowStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 8,
  gridTemplateColumns: "minmax(0, 1fr) auto"
};

const exportDialogDestinationInputStyle: CSSProperties = {
  color: "#52606d",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const exportDialogFieldsetStyle: CSSProperties = {
  border: "1px solid #c8d0d8",
  borderRadius: 8,
  display: "grid",
  gap: 8,
  margin: "8px 0 0",
  padding: "10px 12px 12px"
};

const exportDialogLegendStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 650,
  padding: "0 4px"
};

const exportDialogCheckboxRowStyle: CSSProperties = {
  alignItems: "center",
  color: "#28343f",
  display: "flex",
  fontSize: 13,
  gap: 8,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogFooterStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 10
};

const exportDialogButtonStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 12px"
};

const exportDialogPrimaryButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  background: "#1967d2",
  borderColor: "#1967d2",
  color: "#ffffff"
};

const exportDialogIconButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  borderRadius: 999,
  height: 28,
  minHeight: 28,
  padding: 0,
  width: 28
};
