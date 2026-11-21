import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
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
import { renderSelectionClipboardPng } from "./selectionClipboard";

export const OFFICE_UPDATE_COMMAND_ID = "office.updateEmbeddedObject";
export const OFFICE_CLOSE_COMMAND_ID = "office.closeEmbeddedObject";

const standaloneCommands = new Set([
  "document.new", "document.open", "document.saveAs", "export.open",
  "view.customizeToolbars", "view.customizeMainToolbar", "view.togglePreferences", "view.toggle3dDebugger",
  "help.reportBug", "app.checkForUpdates", "drawnStructureSettings.template.import", "drawnStructureSettings.template.export",
  "structure.spin3d", "structure.openInteractive3d", "structure.cleanup3d", "analyze.molecularProperties"
]);

export function officeCommandAvailability(spec: CommandSpec, molecularInspectorToggle: string): CommandSpec {
  if (!standaloneCommands.has(spec.id) && spec.id !== molecularInspectorToggle &&
      !/^(?:plugins\.|search\.|document\..*UnrestoredTabs)/.test(spec.id)) {
    return spec;
  }
  return { ...spec, enabled: false, disabledReason: "This command is available in the main ChemDraft window." };
}

interface OfficeObjectOpen {
  objectId: string;
  json: string;
  containerApp: string;
  containerDocument: string;
}

interface OfficeCloseRequest {
  requestId: number | null;
  prompt: boolean;
  unsaved: boolean;
}

function updateFrame(json: string, png: Uint8Array): Uint8Array {
  const selection = new TextEncoder().encode(json);
  const limit = 25 * 1024 * 1024;
  if (selection.byteLength > limit) throw new Error("ChemDraftDocument exceeds 25 MiB");
  if (png.byteLength > limit) throw new Error("Preview PNG exceeds 25 MiB");
  const frame = new Uint8Array(4 + selection.byteLength + png.byteLength);
  new DataView(frame.buffer).setUint32(0, selection.byteLength, true);
  frame.set(selection, 4);
  frame.set(png, 4 + selection.byteLength);
  return frame;
}

function cancelRequestedClose(objectId: string, request?: OfficeCloseRequest): Promise<void> {
  if (request?.requestId == null) return Promise.resolve();
  return invoke("office_object_close", { objectId, requestId: request.requestId });
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
  invokeClose: () => void | Promise<void>;
  freezeForClose: () => () => void;
}

export function useOfficeObject(objectId: string | undefined, editor: OfficeObjectEditor) {
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const publishedDocument = useRef<ChemDraftDocument | undefined>(undefined);
  const busy = useRef(false);
  const pendingUpdate = useRef(false);
  const closeRequest = useRef<OfficeCloseRequest | undefined>(undefined);
  const containerRef = useRef<string | undefined>(undefined);
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
    const currentWindow = getCurrentWindow();
    if (currentWindow.label !== `office-object-${objectId}`) {
      reportOpenError("The Office object ID does not match this window.");
      return;
    }
    const install = (payload: OfficeObjectOpen) => {
      if (disposed || payload.objectId !== objectId || publishedDocument.current) return;
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
        containerRef.current = name;
        setContainer(name);
        document.title = windowTitle;
        editorRef.current.setStatus([`Opened structure from ${name}.`, ...warnings].join(" "));
        void currentWindow.setTitle(windowTitle).catch(error => {
          if (!disposed) editorRef.current.setStatus(`Could not set the Office editor title: ${diagnostic(error)}`);
        });
      } catch (error) {
        reportOpenError(error);
      }
    };
    // Strict Mode can dispose the effect before its first connection is needed.
    const ready = Promise.resolve().then(async () => {
      if (disposed) return;
      const channel = new Channel<OfficeCloseRequest>();
      channel.onmessage = request => {
        void ready.then(async () => {
          if (disposed) return;
          closeRequest.current = request;
          try {
            await editorRef.current.invokeClose();
          } finally {
            if (closeRequest.current === request) {
              closeRequest.current = undefined;
              await cancelRequestedClose(objectId, request);
            }
          }
        }).catch(error => {
          if (!disposed) editorRef.current.setStatus(`Could not close the Office structure: ${diagnostic(error)}`);
        });
      };
      install(await invoke<OfficeObjectOpen>("office_object_connect", { channel }));
    });
    void ready.catch(reportOpenError);
    return () => { disposed = true; };
  }, [objectId]);

  const run = useCallback(async (operation: "update" | "close") => {
    if (!objectId) return;
    const request = operation === "close" ? closeRequest.current : undefined;
    if (operation === "close") closeRequest.current = undefined;
    if (busy.current) {
      await cancelRequestedClose(objectId, request);
      return;
    }
    busy.current = true;
    let closed = false;
    let releaseClose: (() => void) | undefined;
    const container = containerRef.current;
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
        const frame = updateFrame(json, png);
        pendingUpdate.current = true;
        await invoke("office_object_update", frame);
        pendingUpdate.current = false;
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
      let saveChanges = true;
      if (isDirty() || pendingUpdate.current || request?.unsaved) {
        const choice = request?.prompt === false ? "update" : await nativePrompt({
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
        if (saveChanges && (isDirty() || pendingUpdate.current)) {
          if (!await publish()) return;
        }
      }
      releaseClose = editorRef.current.freezeForClose();
      if (saveChanges && isDirty()) {
        setStatus("The Office structure changed during the update. Close again to review the remaining changes.");
        return;
      }
      await invoke("office_object_close", {
        objectId, saveChanges, ...(request?.requestId == null ? {} : { requestId: request.requestId })
      });
      closed = true;
    } catch (error) {
      setStatus(`Could not close the Office structure${container ? ` in ${container}` : ""}: ${diagnostic(error)}`);
    } finally {
      busy.current = false;
      if (!closed) {
        releaseClose?.();
        await cancelRequestedClose(objectId, request).catch(() => undefined);
      }
    }
  }, [objectId]);

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
