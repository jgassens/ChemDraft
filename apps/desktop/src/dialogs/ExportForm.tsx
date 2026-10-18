import { useEffect, useRef, type CSSProperties, type FormEvent } from "react";
import { exportFormatDescriptors, getExportFormatDescriptor, type ExportFormatId, type ExportFormatDescriptor, type ExportFormatGroup } from "@chemdraft/export-engine";
import { isDesktopRuntime } from "../window-manager";
import type { NativeRasterExportFormat } from "../nativeRasterExport";
import type { ExportDialogState, ExportDialogFormat, SvgDialogExportOptions, PdfDialogExportOptions, RasterDialogExportOptions, CdxmlDialogExportOptions } from "./exportOptions";
import { exportOptions, validExportOptions } from "./exportOptionsValidation";
import { detectDialogPlatform, type DialogPlatform } from "./dialogProtocol";
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
  state,
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
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error || notice) feedback.current?.scrollIntoView?.({ block: "nearest" }); }, [error, notice]);
  const descriptor = getExportFormatDescriptor(state.format);
  const implemented = descriptor.status === "implemented";
  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  const destinationLabel = state.destinationPath ?? (isDesktopRuntime() ? "Choose a location" : "Downloads");
  const exportDisabled = state.busy || !validExportOptions(exportOptions(state)) || !implemented;

  return (
    <section aria-label="Export" role="dialog" aria-modal={isDesktopRuntime() ? undefined : true} aria-busy={state.busy}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
        if (event.key === "Escape" || (modifier && event.key.toLowerCase() === "w")) {
          event.preventDefault(); event.stopPropagation(); onCancel();
        } else if (event.key === "Tab") {
          const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)'));
          const first = fields[0], last = fields.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault(); if (!exportDisabled) event.currentTarget.querySelector("form")?.requestSubmit();
        }
      }}>
      <form style={{ ...exportDialogPanelStyle, maxHeight: isDesktopRuntime() ? "100vh" : "calc(100vh - 64px)" }}
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
            disabled={state.busy || !isDesktopRuntime() || !implemented}
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
                  type="range"
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

        <div style={exportDialogFooterStyle}>
          <button type="button" style={exportDialogButtonStyle} onClick={onCancel}>
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


export function ExportForm({ state, onChange, onReady, ...props }: {
  state: ExportDialogState; onChange(state: ExportDialogState): void; onReady?(): void;
} & Pick<ExportDialogProps, "onCancel" | "onChooseDestination" | "onSubmit" | "title" | "error" | "notice" | "completed" | "platform">) {
  useEffect(() => { onReady?.(); }, [onReady]);
  return <ExportFormBody {...props} state={state}
    onFilenameChange={filename => onChange({ ...state, filename, destinationPath: undefined })}
    onFormatChange={format => onChange(updateExportDialogFormat(state, format))}
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
  gap: 8,
  maxHeight: "100vh",
  maxWidth: "100%",
  overflow: "auto",
  padding: 16,
  width: "100%",
  boxSizing: "border-box"
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

