import { useSyncExternalStore } from "react";
import type { MenuBar as DesktopMenuBar } from "../MenuBar";
import { OFFICE_CLOSE_COMMAND_ID, OFFICE_UPDATE_COMMAND_ID, useOfficeSession } from "./editorHost";

// The Office build supplies these controls wherever the Office editor would render a file menu.
// onInvoke routes both buttons through MainWindow's registered Office commands.
export function MenuBar({ onInvoke }: Parameters<typeof DesktopMenuBar>[0]) {
  const session = useOfficeSession();
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <div className="office-controls">
      <div className="office-actions">
        <button type="button" className="office-update" disabled={!state.selected || !state.dirty || state.busy || !!state.updateRefusal}
          onClick={() => void onInvoke(OFFICE_UPDATE_COMMAND_ID)}>Update</button>
        <button type="button" disabled={state.busy} onClick={() => void onInvoke(OFFICE_CLOSE_COMMAND_ID)}>Cancel</button>
      </div>
      <p role="status">{state.status}</p>
      {state.confirmDiscard && (
        <div className="office-actions" role="group" aria-label="Unsaved drawing edits">
          <button type="button" disabled={state.busy} onClick={() => void onInvoke(OFFICE_CLOSE_COMMAND_ID)}>Discard edits</button>
          <button type="button" disabled={state.busy} onClick={() => session.keepEditing()}>Keep editing</button>
        </div>
      )}
    </div>
  );
}
