import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assistantDocumentContentUnchanged } from "./assistant/historyPort";
import type { CommandSpec } from "./commands";
import {
  createPhase4Document, createSelectionClipboardPayload, parseSelectionClipboardPayload,
  pasteSelectionClipboardPayload, selectDocumentObjects, type ChemDraftSelectionClipboardPayload
} from "./documentWorkflow";
import { nativePrompt } from "./nativePrompt";
import { bytesToBase64 } from "./rasterPictureDecode";
import { renderSelectionClipboardPng } from "./selectionClipboard";
import { safeTauriWindowListen } from "./window-manager/tauriEvents";

export const OFFICE_UPDATE_COMMAND_ID = "office.updateEmbeddedObject";
export const OFFICE_CLOSE_COMMAND_ID = "office.closeEmbeddedObject";

interface OfficeObjectOpen {
  objectId: string;
  json: string;
  containerApp: string;
  containerDocument: string;
}

export function officeObjectIdFromSearch(search: string): string | undefined {
  return new URLSearchParams(search).get("officeObject") || undefined;
}

const emptySelection: ChemDraftSelectionClipboardPayload = {
  kind: "chemdraft-selection", version: 1, objects: [], selectionIds: [],
  bounds: { x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0 }
};

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OfficeObjectEditor {
  installDocument: (document: ChemDraftDocument) => ChemDraftDocument;
  readDocument: () => ChemDraftDocument;
  setStatus: (message: string) => void;
  invokeClose: () => void;
}

export function useOfficeObject(objectId: string | undefined, editor: OfficeObjectEditor) {
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const publishedDocument = useRef<ChemDraftDocument | undefined>(undefined);
  const busy = useRef(false);
  const [container, setContainer] = useState<string>();

  useEffect(() => {
    if (!objectId) return;
    let disposed = false;
    const reportOpenError = (error: unknown) => {
      if (!disposed) editorRef.current.setStatus(`Could not open the Office structure: ${diagnostic(error)}`);
    };
    if (!isTauri()) {
      reportOpenError("The Office editing bridge is unavailable in this window.");
      return;
    }
    const webview = getCurrentWebviewWindow();
    if (webview.label !== `office-object-${objectId}`) {
      reportOpenError("The Office object ID does not match this window.");
      return;
    }
    const currentWindow = getCurrentWindow();
    // Tauri defers destruction when this window has a close-request listener. The Office
    // close command completes the session and destroys the window after the user's choice.
    const close = safeTauriWindowListen(currentWindow, TauriEvent.WINDOW_CLOSE_REQUESTED,
      () => editorRef.current.invokeClose());
    const open = safeTauriWindowListen<OfficeObjectOpen>(webview, "office-object://open", ({ payload }) => {
      if (payload.objectId !== objectId || publishedDocument.current) return;
      try {
        const selection = parseSelectionClipboardPayload(payload.json, { allowEmpty: true });
        if (!selection) throw new Error("The embedded drawing contains invalid or unsupported ChemDraft selection JSON.");
        const name = payload.containerDocument.trim() || payload.containerApp.trim() || "Office";
        const title = `ChemDraft Structure in ${name}`;
        const windowTitle = `${title}${__WORKTREE_LABEL__ ? ` — ${__WORKTREE_LABEL__}` : ""}`;
        const warnings: string[] = [];
        const pasted = pasteSelectionClipboardPayload(createPhase4Document(title), selection,
          { x: selection.bounds.centerX, y: selection.bounds.centerY }, warnings);
        if (pasted.pages[0]!.objects.length !== selection.objects.length) {
          throw new Error("The embedded drawing contains objects that could not be restored.");
        }
        publishedDocument.current = editorRef.current.installDocument(selectDocumentObjects(pasted, pasted.pages[0]!.id, []));
        setContainer(name);
        document.title = windowTitle;
        editorRef.current.setStatus([`Opened structure from ${name}.`, ...warnings].join(" "));
        void currentWindow.setTitle(windowTitle).catch(error => {
          if (!disposed) editorRef.current.setStatus(`Could not set the Office editor title: ${diagnostic(error)}`);
        });
      } catch (error) {
        reportOpenError(error);
      }
    });
    void Promise.all([open.attached, close.attached]).then(async () => {
      if (!disposed) await emitTo(webview.label, "office-object://ready");
    }).catch(reportOpenError);
    return () => { disposed = true; open.stop(); close.stop(); };
  }, [objectId]);

  const run = useCallback(async (operation: "update" | "close") => {
    if (!objectId || busy.current) return;
    busy.current = true;
    const { readDocument, setStatus } = editorRef.current;
    const publish = async () => {
      try {
        const snapshot = readDocument();
        const page = snapshot.pages[0]!;
        const wholeDrawing = selectDocumentObjects(snapshot, page.id, page.objects.map(object => object.id));
        const selection = page.objects.length ? createSelectionClipboardPayload(wholeDrawing) : emptySelection;
        if (!selection || selection.objects.length !== page.objects.length) {
          throw new Error("The whole drawing could not be included in the Office selection.");
        }
        const { json, png, svg, raster } = await renderSelectionClipboardPng(snapshot, selection, { requireFullResolution: true });
        await invoke("office_object_update", { objectId, json, pngBase64: bytesToBase64(png) });
        publishedDocument.current = snapshot;
        const warnings = [...(selection.warnings ?? []), ...[...svg.warnings, ...raster.warnings].map(warning => warning.message)];
        setStatus([`Updated structure in ${container}.`, ...new Set(warnings)].join(" "));
        return true;
      } catch (error) {
        setStatus(`Could not update the structure in ${container}: ${diagnostic(error)}`);
        return false;
      }
    };

    try {
      if (operation === "update") {
        if (publishedDocument.current) await publish();
        return;
      }
      const isDirty = () => {
        const published = publishedDocument.current;
        return published !== undefined && !assistantDocumentContentUnchanged(published, readDocument());
      };
      let saveChanges = publishedDocument.current !== undefined;
      if (isDirty()) {
        const choice = await nativePrompt({
          owner: "office-object",
          title: "Update the Office structure before closing?",
          message: `Apply your changes to the structure in ${container}?`,
          kind: "warning",
          choices: [
            { id: "update", label: "Update" },
            { id: "discard", label: "Don't update", destructive: true },
            { id: "cancel", label: "Cancel", cancel: true }
          ]
        }, async () => { throw new Error("The native Office update confirmation is unavailable."); });
        if (choice === "cancel") return;
        saveChanges = choice === "update";
        if (saveChanges) {
          if (!await publish()) return;
          if (isDirty()) {
            setStatus("The Office structure changed during the update. Close again to review the remaining changes.");
            return;
          }
        }
      }
      await invoke("office_object_close", { objectId, saveChanges });
    } catch (error) {
      setStatus(`Could not close the Office structure${container ? ` in ${container}` : ""}: ${diagnostic(error)}`);
    } finally {
      busy.current = false;
    }
  }, [container, objectId]);

  return useMemo(() => {
    const outsideOffice = "This window is not editing an Office structure.";
    const update: CommandSpec = {
      id: OFFICE_UPDATE_COMMAND_ID, title: container ? `Update ${container}` : "Update Office Structure",
      source: "core", icon: "save", enabled: container !== undefined,
      disabledReason: !objectId ? outsideOffice : !container ? "The Office structure has not loaded." : undefined
    };
    const close: CommandSpec = {
      id: OFFICE_CLOSE_COMMAND_ID, title: "Close", source: "core", icon: "close", enabled: !!objectId,
      disabledReason: objectId ? undefined : outsideOffice
    };
    return { update, close, run };
  }, [container, objectId, run]);
}
