import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { fileWarningsAssembler, type FileWarningsAction, type FileWarningsChunk, type FileWarningsSnapshot } from "./fileWarningsProtocol";
import { installSecondaryWindowEditHistory, stripForcedDocumentHistorySuffix } from "./editHistoryRouting";
import { DOM_COMMAND_EVENT } from "./window-manager";

export function FileWarningsWindow({ platform = detectShortcutPlatform() }: { platform?: ShortcutPlatform }) {
  const [snapshot, setSnapshot] = useState<FileWarningsSnapshot>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusedSession = useRef<string | undefined>(undefined);
  const current = useRef(snapshot);
  current.current = snapshot;
  const send = (action: { kind: "close" } | { kind: "show"; reportIndex: number; warningIndex: number } | { kind: "command"; commandId: "edit.undo" | "edit.redo" | "edit.selectAll" }) => {
    const value = current.current;
    if (value) void invoke("file_warnings_action", { action: { sessionId: value.sessionId, revision: value.revision, ...action } satisfies FileWarningsAction });
  };
  useEffect(() => {
    window.document.body.classList.add("file-warnings-window");
    const onSnapshot = new Channel<FileWarningsChunk>();
    onSnapshot.onmessage = fileWarningsAssembler(setSnapshot);
    void invoke("file_warnings_request", { onSnapshot });
    return () => { onSnapshot.onmessage = () => {}; window.document.body.classList.remove("file-warnings-window"); };
  }, []);
  useEffect(() => {
    // Use the same forced-document history routing as palettes, including native Edit menu clicks.
    return installSecondaryWindowEditHistory({ forwardToMain: forwarded => {
      const commandId = stripForcedDocumentHistorySuffix(forwarded);
      if (commandId === "edit.undo" || commandId === "edit.redo" || commandId === "edit.selectAll") send({ kind: "command", commandId });
    } });
  }, []);
  useEffect(() => {
    const preventReload = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        send({ kind: "close" });
      }
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "F5" || event.key === "BrowserRefresh" || (modifier && event.key.toLowerCase() === "r")) event.preventDefault();
      if (event.defaultPrevented || event.isComposing || !modifier || event.altKey ||
        (platform === "macos" ? event.ctrlKey : event.metaKey)) return;
      const key = event.key.toLowerCase();
      const commandId = key === "z" ? (event.shiftKey ? "edit.redo" : "edit.undo")
        : !event.shiftKey && key === "a" ? "edit.selectAll"
        : platform !== "macos" && !event.shiftKey && key === "y" ? "edit.redo" : undefined;
      if (commandId) {
        event.preventDefault(); // Suppress a second delivery through the native menu accelerator.
        window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
      }
    };
    window.addEventListener("keydown", preventReload);
    return () => window.removeEventListener("keydown", preventReload);
  }, [platform]);
  useEffect(() => {
    if (!snapshot) return;
    // Like PalettePopoverWindow, reveal after commit without rAF: hidden reused webviews suspend it.
    if (focusedSession.current !== snapshot.sessionId) {
      closeButton.current?.focus();
      focusedSession.current = snapshot.sessionId;
    }
    void invoke("file_warnings_ready", { sessionId: snapshot.sessionId, revision: snapshot.revision }).catch(reason => {
      // Creation can succeed while native reveal is refused or fails. Let the owner show HTML.
      void invoke("file_warnings_action", { action: { kind: "unavailable", sessionId: snapshot.sessionId,
        revision: snapshot.revision, message: String(reason) } satisfies FileWarningsAction }).catch(() => undefined);
    });
  }, [snapshot]);
  if (!snapshot) return null;
  return <div className="open-warnings-list" data-open-warnings-list role="dialog" aria-label="File warnings">
    <div className="open-warnings-header">
      <h2 className="open-warnings-heading">{snapshot.reports.length > 1 ? "Open and save warnings" : snapshot.reports[0]?.heading}</h2>
      <button ref={closeButton} type="button" className="open-warnings-close" aria-label="Close the warnings list" onClick={() => send({ kind: "close" })}>×</button>
    </div>
    <div className="open-warnings-items">
      {snapshot.reports.map((report, reportIndex) => <section key={reportIndex} aria-label={report.heading}>
        {snapshot.reports.length > 1 ? <h3 className="open-warnings-heading open-warnings-header">{report.heading}</h3> : null}
        <ol className="open-warnings-items">{report.rows.map((row, warningIndex) => <li key={warningIndex} className="open-warnings-item" data-open-warning-row data-warning-code={row.code}>
          <p className="open-warnings-message">{row.message}</p>
          <div className="open-warnings-meta">
            <span className={row.missing ? "open-warnings-target missing" : "open-warnings-target"} data-open-warning-target>{row.target}</span>
            <code className="open-warnings-code">{row.code}</code>
            {row.canShow ? <button type="button" className="open-warnings-show" data-open-warning-show onClick={() => send({ kind: "show", reportIndex, warningIndex })}>Show</button> : null}
          </div>
        </li>)}</ol>
      </section>)}
    </div>
  </div>;
}
