import { lazy, Suspense, useEffect, useMemo, useSyncExternalStore } from "react";
import type { OfficeDocument, OfficeHostAdapter } from "./host";
import { OfficeSessionContext } from "./editorHost";
import { OfficePaneSession } from "./session";

const Editor = lazy(async () => ({ default: (await import("../MainWindow")).MainWindow }));

export function OfficePane({ adapter, document }: { adapter: OfficeHostAdapter; document: OfficeDocument }) {
  const session = useMemo(() => new OfficePaneSession(adapter), [adapter]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => session.connect(document), [document, session]);
  if (!state.document) return <p className="office-message" role="status">{state.busy ? "Reading Office selection…" : state.status}</p>;
  return (
    <OfficeSessionContext.Provider value={session}>
      <Suspense fallback={<p className="office-message" role="status">Opening ChemDraft…</p>}>
        <Editor key={state.loadId} initialDocument={state.document} nativePalette={false}
          initialRulersVisible={false} initialCrosshairsVisible={false} />
      </Suspense>
    </OfficeSessionContext.Provider>
  );
}
