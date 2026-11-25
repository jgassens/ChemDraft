import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { CommandSpec } from "../commands";
import type { useOfficeObject as useDesktopOfficeObject } from "../officeObject";
import type { OfficePaneSession } from "./session";

export { OFFICE_CLOSE_COMMAND_ID, OFFICE_UPDATE_COMMAND_ID } from "../officeObject";
import { OFFICE_CLOSE_COMMAND_ID, OFFICE_UPDATE_COMMAND_ID, officeCommandAvailability as desktopAvailability } from "../officeObject";

export const OfficeSessionContext = createContext<OfficePaneSession | undefined>(undefined);

export function useOfficeSession() {
  const session = useContext(OfficeSessionContext);
  if (!session) throw new Error("The Office editor needs a task-pane session.");
  return session;
}

export function officeObjectIdFromSearch() {
  return "office-task-pane";
}

export function officeCommandAvailability(spec: CommandSpec, inspectorToggle: string) {
  if (spec.id.startsWith("file.") || spec.id.startsWith("app.") || spec.id.startsWith("help.") ||
      spec.id.startsWith("clipboard.copyAs.") || spec.id === "view.toggle3dDebugger" || spec.id === "view.toggleToolPalette") {
    return { ...spec, enabled: false, disabledReason: "This command is unavailable in the Office task pane." };
  }
  return desktopAvailability(spec, inspectorToggle);
}

// MainWindow passes the same typed document port to its native Office bridge. This build binds
// that port to the pane session and uses the regular editor commands for all drawing edits.
export function useOfficeObject(_id: string | undefined, editor: Parameters<typeof useDesktopOfficeObject>[1]):
  ReturnType<typeof useDesktopOfficeObject> {
  const session = useOfficeSession();
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const { document, loadId } = session.snapshot();
  useLayoutEffect(() => {
    if (!document) return;
    // Use the Office install path that preserves native electron marks while initializing history.
    editorRef.current.installDocument(structuredClone(document));
    editorRef.current.setStatus("");
    return session.attachEditor(loadId, () => editorRef.current.readDocument());
  }, [document, loadId, session]);
  useLayoutEffect(() => { session.observeEditor(); });

  return {
    // MainWindow also uses this existing Office command flag to enable the canvas and tools.
    // The pane controls additionally check the current selection, dirty state and host support.
    update: { id: OFFICE_UPDATE_COMMAND_ID, title: "Update", source: "core", icon: "save", enabled: true },
    close: { id: OFFICE_CLOSE_COMMAND_ID, title: "Cancel", source: "core", icon: "close", enabled: true },
    run: operation => operation === "update" ? session.update() : session.cancel(),
  };
}
