import type { PluginPanelReport, PluginPanelSection } from "@chemdraft/plugin-api";

import { LinkedFigureView } from "./LinkedFigureView";
import { useState, type KeyboardEvent } from "react";
import { writeClipboardText } from "../clipboard";
import type { PluginPanelActionHandler } from "./pluginPanelActionTypes";

export type { PluginPanelActionHandler, PluginPanelActionRequest, PluginPanelActionResult } from "./pluginPanelActionTypes";

/**
 * Renders a validated {@link PluginPanelReport} with core desktop UI. Plugins never ship components;
 * they describe results as data, and this is the single renderer for all of them. SVG sections are
 * drawn through an `<img>` data URL so any embedded script is inert (an `<img>` never executes
 * script), matching the security contract documented on the panel-report schema.
 */
export function PluginReportRenderer({ report, copyText = writeClipboardText, onAction }: {
  report: PluginPanelReport;
  copyText?: (text: string) => Promise<boolean>;
  onAction?: PluginPanelActionHandler;
}) {
  return (
    <div className="plugin-report">
      {report.sections.map((section, index) => (
        <PluginReportSectionView
          key={(section.kind === "prompt" || section.kind === "actions") ? section.id : index}
          section={section}
          copyText={copyText}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

function PluginReportSectionView({ section, copyText, onAction }: {
  section: PluginPanelSection;
  copyText: (text: string) => Promise<boolean>;
  onAction?: PluginPanelActionHandler;
}) {
  switch (section.kind) {
    case "prompt":
      return <PromptSection section={section} onAction={onAction} />;
    case "actions":
      return <ActionsSection section={section} onAction={onAction} />;
    case "image":
      return (
        <section className="plugin-report-section plugin-report-image">
          {section.title ? <h4>{section.title}</h4> : null}
          <img
            className="plugin-report-image-content"
            src={section.dataUri}
            alt={section.alt}
            style={section.maxWidthPx ? { maxWidth: `${section.maxWidthPx}px` } : undefined}
          />
          {section.caption ? <p className="plugin-report-caption">{section.caption}</p> : null}
        </section>
      );
    case "chemicalName":
      return <ChemicalNameSection section={section} copyText={copyText} />;
    case "text":
      return (
        <section className="plugin-report-section plugin-report-text">
          {section.title ? <h4>{section.title}</h4> : null}
          <p>{section.body}</p>
        </section>
      );
    case "keyValue":
      return (
        <section className="plugin-report-section plugin-report-keyvalue">
          {section.title ? <h4>{section.title}</h4> : null}
          <dl>
            {section.rows.map((row, index) => (
              <div key={index} className="plugin-report-kv-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section className="plugin-report-section plugin-report-table">
          {section.title ? <h4>{section.title}</h4> : null}
          <div className="plugin-report-table-scroll">
            <table>
              <thead>
                <tr>
                  {section.columns.map((column, index) => (
                    <th key={index}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "svg":
      return (
        <section className="plugin-report-section plugin-report-svg">
          {section.title ? <h4>{section.title}</h4> : null}
          <img
            className="plugin-report-svg-image"
            alt={section.title ?? section.caption ?? "Plugin visualization"}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(section.svg)}`}
          />
          {section.caption ? <p className="plugin-report-caption">{section.caption}</p> : null}
        </section>
      );
    case "linkedFigure":
      return (
        <section className="plugin-report-section plugin-report-figure">
          {section.title ? <h4>{section.title}</h4> : null}
          <LinkedFigureView spectrum={section.spectrum} structure={section.structure} />
          {section.caption ? <p className="plugin-report-caption">{section.caption}</p> : null}
        </section>
      );
  }
  return <section className="plugin-report-section"><pre>{JSON.stringify(section, null, 2)}</pre></section>;
}

function PromptSection({ section, onAction }: {
  section: Extract<PluginPanelSection, { kind: "prompt" }>;
  onAction?: PluginPanelActionHandler;
}) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const canSubmit = !!onAction && !section.disabled && !pending;
  const submit = async (): Promise<void> => {
    if (!canSubmit || !onAction) return;
    setPending(true);
    setMessage(undefined);
    try {
      const result = await onAction({ sectionId: section.id, control: "prompt", text: draft });
      if (result.ok) setDraft("");
      else setMessage(result.message);
    } catch {
      setMessage("The action could not be completed.");
    } finally {
      setPending(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const nativeEvent = event.nativeEvent;
    if (event.key !== "Enter" || event.shiftKey || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };
  const select = section.select;
  return <section className="plugin-report-section plugin-report-composer">
    {section.title ? <h4>{section.title}</h4> : null}
    {section.label ? <label className="plugin-report-composer-label" htmlFor={`plugin-prompt-${section.id}`}>{section.label}</label> : null}
    <textarea
      id={`plugin-prompt-${section.id}`}
      value={draft}
      placeholder={section.placeholder}
      maxLength={section.maxLength}
      rows={section.rows}
      onChange={(event) => setDraft(event.target.value.slice(0, section.maxLength))}
      onKeyDown={keyDown}
    />
    <div className="plugin-report-composer-controls">
      {select ? <label className="plugin-report-composer-select">
        <span>{select.label}</span>
        <select
          value={select.value}
          disabled={section.disabled || !onAction || pending}
          onChange={(event) => {
            if (!onAction) return;
            void onAction({ sectionId: section.id, control: "select", controlId: select.id, selected: event.target.value })
              .catch(() => undefined);
          }}
        >
          {select.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label> : null}
      <button type="button" className="plugin-report-action plugin-report-action-primary" disabled={!canSubmit} onClick={() => void submit()}>
        {section.submitLabel}
      </button>
    </div>
    {section.hint ? <p className="plugin-report-composer-hint">{section.hint}</p> : null}
    {message ? <p className="plugin-report-composer-error" role="alert">{message}</p> : null}
  </section>;
}

function ActionsSection({ section, onAction }: {
  section: Extract<PluginPanelSection, { kind: "actions" }>;
  onAction?: PluginPanelActionHandler;
}) {
  return <section className="plugin-report-section plugin-report-actions">
    {section.title ? <h4>{section.title}</h4> : null}
    <div className="plugin-report-actions-buttons">
      {section.buttons.map((button) => (
        <button
          key={button.id}
          type="button"
          className={`plugin-report-action plugin-report-action-${button.tone}`}
          disabled={button.disabled || !onAction}
          onClick={() => {
            if (!onAction) return;
            void onAction({ sectionId: section.id, control: "button", controlId: button.id }).catch(() => undefined);
          }}
        >
          {button.label}
        </button>
      ))}
    </div>
  </section>;
}

function ChemicalNameSection({ section, copyText }: {
  section: Extract<PluginPanelSection, { kind: "chemicalName" }>;
  copyText: (text: string) => Promise<boolean>;
}) {
  const [error, setError] = useState<string>();
  const copy = async () => {
    try {
      const written = await copyText(section.name);
      setError(written ? undefined : "The name could not be copied to the clipboard.");
    } catch { setError("The name could not be copied to the clipboard."); }
  };
  return <section className="plugin-report-section plugin-report-chemical-name">
    <h4>{section.label}</h4>
    <pre style={{ userSelect: "text", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{section.name}</pre>
    <button type="button" onClick={() => void copy()}>Copy</button>
    <p>{section.kindLabel}</p>
    {section.warnings.map((warning, index) => <p key={index}>{warning.message}</p>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
