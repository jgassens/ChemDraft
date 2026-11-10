import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { fileWarningsAssembler, type FileWarningsAction, type FileWarningsChunk, type FileWarningsSnapshot } from "./fileWarningsProtocol";

export function FileWarningsWindow({ platform = detectShortcutPlatform() }: { platform?: ShortcutPlatform }) {
  const [snapshot, setSnapshot] = useState<FileWarningsSnapshot>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusedSession = useRef<string | undefined>(undefined);
  const current = useRef(snapshot);
  current.current = snapshot;
  const send = (action: { kind: "close" } | { kind: "show"; reportIndex: number; warningIndex: number }) => {
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
    const preventReload = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        send({ kind: "close" });
      }
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      if (event.key === "F5" || event.key === "BrowserRefresh" || (modifier && event.key.toLowerCase() === "r")) event.preventDefault();
    };
    window.addEventListener("keydown", preventReload);
    return () => window.removeEventListener("keydown", preventReload);
  }, [platform]);
  useEffect(() => {
    if (!snapshot) return;
    const frame = requestAnimationFrame(() => {
      if (focusedSession.current !== snapshot.sessionId) {
        closeButton.current?.focus();
        focusedSession.current = snapshot.sessionId;
      }
      void invoke("file_warnings_ready", { sessionId: snapshot.sessionId, revision: snapshot.revision });
    });
    return () => cancelAnimationFrame(frame);
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
