import { useEffect, useRef, useState } from "react";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { currentWindowLogicalPosition, isDesktopRuntime } from "./window-manager";
import type { OpenWarningsReport, OpenWarningSelection } from "./openWarnings";
import { createFileWarningsSession, fileWarningsSnapshot, routeFileWarningsAction } from "./fileWarningsProtocol";

export function useNativeFileWarnings(shown: boolean, tabId: string, reports: readonly OpenWarningsReport[], document: ChemDraftDocument,
  show: (selection: OpenWarningSelection, label: string) => void, close: () => void, error: (message: string) => void) {
  const current = useRef({ reports, document, show, close, error, tabId });
  current.current = { reports, document, show, close, error, tabId };
  const session = useRef<ReturnType<typeof createFileWarningsSession> | undefined>(undefined);
  const snapshot = useRef<ReturnType<typeof fileWarningsSnapshot> | undefined>(undefined);
  const snapshotReports = useRef(reports);
  const [fallbackSession, setFallbackSession] = useState<string>();
  const opening = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isDesktopRuntime() || !shown) return;
    let disposed = false;
    const sessionId = crypto.randomUUID();
    opening.current = sessionId;
    setFallbackSession(undefined);
    snapshot.current = fileWarningsSnapshot(sessionId, 1, current.current.reports, current.current.document);
    snapshotReports.current = current.current.reports;
    const button = window.document.querySelector<HTMLElement>("[data-open-warnings-button]");
    const bounds = button?.getBoundingClientRect();
    const focus = window.document.activeElement === button;
    const fail = (reason: unknown) => {
      if (disposed) return;
      current.current.error(`Native file warnings unavailable: ${String(reason)}. Showing warnings in this window.`);
      // Keep the toggle open and render the same rows in HTML if native presentation fails.
      setFallbackSession(sessionId);
      session.current?.dispose();
      session.current = undefined;
    };
    void currentWindowLogicalPosition("inner").then(origin => {
      if (disposed) return;
      if (!origin) throw new Error("Document position is unavailable");
      const active = createFileWarningsSession(snapshot.current!, { x: origin.x + (bounds?.left ?? 8), y: origin.y + (bounds?.top ?? window.innerHeight) }, focus,
        action => {
          if (disposed || current.current.tabId !== tabId || !snapshot.current || opening.current !== sessionId) return;
          if (action.kind === "unavailable") {
            if (action.sessionId === snapshot.current.sessionId && action.revision === snapshot.current.revision) fail(action.message);
            return;
          }
          // A report replacement can render before its publishing effect. An old
          // row index must never resolve into the replacement report in that gap.
          if (action.kind === "show" && current.current.reports !== snapshotReports.current) return;
          routeFileWarningsAction(action, snapshot.current, current.current.reports, current.current.document,
            current.current.show, () => {
              current.current.close();
              if (focus) button?.focus();
            });
        }, fail);
      session.current = active;
    }).catch(fail);
    return () => {
      disposed = true;
      opening.current = undefined;
      session.current?.dispose();
      session.current = undefined;
      snapshot.current = undefined;
    };
  }, [shown, tabId]);
  useEffect(() => {
    if (!snapshot.current) return;
    snapshot.current = fileWarningsSnapshot(snapshot.current.sessionId, snapshot.current.revision + 1, reports, document);
    snapshotReports.current = reports;
    session.current?.publish(snapshot.current);
  }, [reports, document]);
  return !isDesktopRuntime() || (shown && fallbackSession !== undefined && fallbackSession === opening.current);
}
