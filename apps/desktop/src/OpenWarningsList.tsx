import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { MouseEvent } from "react";
import {
  describeOpenWarningTarget,
  OPEN_WARNINGS_LIST_ID,
  openWarningsHeading,
  type OpenWarningSelection,
  type OpenWarningsReport
} from "./openWarnings";

/** A press on a list button must not take keyboard focus from the canvas, or tool shortcuts stop. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

/**
 * The warnings a file open reported, above the status line in the document window. Each row gives
 * the importer's own message, what it is about, and its code; Show selects what it names. The text
 * stays selectable so a warning can be copied into a report.
 */
export function OpenWarningsList({
  report,
  document,
  onShow,
  onClose
}: {
  report: OpenWarningsReport;
  document: ChemDraftDocument;
  onShow: (selection: OpenWarningSelection, label: string) => void;
  onClose: () => void;
}) {
  const heading = openWarningsHeading(report);
  return (
    <div id={OPEN_WARNINGS_LIST_ID} className="open-warnings-list" data-open-warnings-list role="dialog" aria-label={heading}>
      <div className="open-warnings-header">
        <h2 className="open-warnings-heading">{heading}</h2>
        <button type="button" className="open-warnings-close" aria-label="Close the warnings list" onMouseDown={keepFocus} onClick={onClose}>
          ×
        </button>
      </div>
      <ol className="open-warnings-items">
        {report.warnings.map((warning, index) => {
          const target = describeOpenWarningTarget(document, warning);
          const selection = target.selection;
          return (
            <li key={index} className="open-warnings-item" data-open-warning-row data-warning-code={warning.code}>
              <p className="open-warnings-message">{warning.message}</p>
              <div className="open-warnings-meta">
                <span className={target.missing ? "open-warnings-target missing" : "open-warnings-target"} data-open-warning-target>
                  {target.label}
                </span>
                <code className="open-warnings-code">{warning.code}</code>
                {selection ? (
                  <button
                    type="button"
                    className="open-warnings-show"
                    data-open-warning-show
                    onMouseDown={keepFocus}
                    onClick={() => onShow(selection, target.label)}
                  >
                    Show
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
