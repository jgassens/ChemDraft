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
// Read by office_object_update in src-tauri/src/office_ole/bridge.rs.
const SESSION_PUBLISH_HEADER = "x-chemdraft-session-publish";
const SESSION_UNCHANGED_HEADER = "x-chemdraft-session-unchanged";
const SESSION_FAILED_HEADER = "x-chemdraft-session-failed";

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
  discard: boolean;
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
  const operationInFlight = useRef<Promise<void> | undefined>(undefined);
  const closed = useRef(false);
  const pendingUpdate = useRef(false);
  const closeRequest = useRef<OfficeCloseRequest | undefined>(undefined);
  const sessionPublish = useRef<{ id: number; done: Promise<void>; cancel: () => void } | undefined>(undefined);
  const containerRef = useRef<string | undefined>(undefined);
  const [container, setContainer] = useState<string>();

  const publish = useCallback(async (session?: number) => {
    const { readDocument, setStatus } = editorRef.current;
    const container = containerRef.current;
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
      if (session !== undefined) {
        if (sessionPublish.current?.id !== session) return false;
        await invoke("office_object_update", frame, { headers: { [SESSION_PUBLISH_HEADER]: String(session) } });
        return true;
      }
      pendingUpdate.current = true;
      await invoke("office_object_update", frame);
      pendingUpdate.current = false;
      publishedDocument.current = snapshot;
      const warnings = [...(selection.warnings ?? []), ...[...svg.warnings, ...raster.warnings].map(warning => warning.message)];
      setStatus([`Updated structure in ${container}.`, ...new Set(warnings)].join(" "));
      return true;
    } catch (error) {
      if (session === undefined || sessionPublish.current?.id === session) {
        setStatus(`Could not update the structure in ${container}: ${diagnostic(error)}`);
      }
      return false;
    }
  }, []);

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
          while (!disposed && sessionPublish.current) await sessionPublish.current.done;
          if (disposed || closed.current) return;
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

    // Windows waits on every editor's answer before it ends the session, so each one answers:
    // the whole drawing if Office may not hold it yet, otherwise "unchanged".
    const onSessionPublish = (event: Event) => {
      const id = (event as CustomEvent<number>).detail;
      if (closed.current || sessionPublish.current) return;
      const thaw = editorRef.current.freezeForClose();
      let resume!: () => void;
      const done = new Promise<void>(resolve => { resume = resolve; });
      sessionPublish.current = { id, done, cancel: () => { thaw(); resume(); } };
      // A drawing that could not be rendered or sent is reported to ChemDraft as unsent, so it
      // keeps the session end refused and writes a recovery copy, and the editor unlocks so the
      // user can update or close it again. Nothing resends this request.
      const fail = async () => {
        if (disposed || sessionPublish.current?.id !== id) return;
        try {
          await invoke("office_object_update", new Uint8Array(0), {
            headers: { [SESSION_PUBLISH_HEADER]: String(id), [SESSION_FAILED_HEADER]: "1" }
          });
        } catch {
          // The request expired or the app is going away; the unlock below still applies.
        }
        if (sessionPublish.current?.id !== id) return;
        sessionPublish.current.cancel();
        sessionPublish.current = undefined;
      };
      void ready.catch(() => undefined).then(async () => {
        if (disposed || sessionPublish.current?.id !== id) return;
        const published = publishedDocument.current;
        if (published && (pendingUpdate.current ||
            !assistantDocumentContentUnchanged(published, editorRef.current.readDocument()))) {
          // publish reports its own failure in the status line.
          if (!await publish(id)) await fail();
          return;
        }
        // Office already holds this drawing, or the editor never loaded one it could change.
        await invoke("office_object_update", new Uint8Array(0), {
          headers: { [SESSION_PUBLISH_HEADER]: String(id), [SESSION_UNCHANGED_HEADER]: "1" }
        });
      }).catch(async error => {
        if (!disposed && sessionPublish.current?.id === id) {
          editorRef.current.setStatus(`Could not answer the Windows session end: ${diagnostic(error)}`);
          await fail();
        }
      });
    };
    const onSessionCancel = (event: Event) => {
      if (sessionPublish.current?.id !== (event as CustomEvent<number>).detail) return;
      sessionPublish.current.cancel();
      sessionPublish.current = undefined;
    };
    window.addEventListener("chemdraft:office-toolset:office-session-publish", onSessionPublish);
    window.addEventListener("chemdraft:office-toolset:office-session-cancel", onSessionCancel);
    return () => {
      disposed = true;
      sessionPublish.current?.cancel();
      sessionPublish.current = undefined;
      window.removeEventListener("chemdraft:office-toolset:office-session-publish", onSessionPublish);
      window.removeEventListener("chemdraft:office-toolset:office-session-cancel", onSessionCancel);
    };
  }, [objectId, publish]);

  const run = useCallback(async (operation: "update" | "close") => {
    if (!objectId) return;
    const request = operation === "close" ? closeRequest.current : undefined;
    if (operation === "close") closeRequest.current = undefined;
    const previous = operationInFlight.current;
    if (operation === "update" && (previous || sessionPublish.current)) return;
    const current = (previous ?? Promise.resolve()).then(async () => {
      while (sessionPublish.current) await sessionPublish.current.done;
      if (closed.current) return;
      if (operation === "update") {
        if (publishedDocument.current) await publish();
        return;
      }
      let releaseClose: (() => void) | undefined;
      const container = containerRef.current;
      const { readDocument, setStatus } = editorRef.current;
      try {
        const isDirty = () => {
          const published = publishedDocument.current;
          return published !== undefined && !assistantDocumentContentUnchanged(published, readDocument());
        };
        let saveChanges = !request?.discard;
        if (saveChanges && (isDirty() || pendingUpdate.current || request?.unsaved)) {
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
        closed.current = true;
      } catch (error) {
        setStatus(`Could not close the Office structure${container ? ` in ${container}` : ""}: ${diagnostic(error)}`);
      } finally {
        if (!closed.current) {
          releaseClose?.();
          await cancelRequestedClose(objectId, request).catch(() => undefined);
        }
      }
    });
    operationInFlight.current = current;
    try {
      await current;
    } finally {
      if (operationInFlight.current === current) operationInFlight.current = undefined;
    }
  }, [objectId, publish]);

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
