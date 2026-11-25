import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { assistantDocumentContentUnchanged } from "../assistant/historyPort";
import { openOfficeDrawing, prepareOfficePicture } from "./drawing";
import {
  errorMessage, noStructure, officeAsync, refuse, selectionChanged, type OfficeDocument, type OfficeHostAdapter,
  type SelectedStructure, type SelectionResult,
} from "./host";

export const selectStructure = "Select a ChemDraft structure";

const sameStructure = (a: SelectedStructure, b: SelectionResult): b is SelectedStructure =>
  b.kind === "structure" && a.key === b.key && a.json === b.json;

interface PaneState {
  status: string;
  document?: ChemDraftDocument;
  loadId: number;
  dirty: boolean;
  busy: boolean;
  selected: boolean;
  updateRefusal?: string;
  confirmDiscard: boolean;
}

export class OfficePaneSession {
  private listeners = new Set<() => void>();
  private state: PaneState = {
    status: selectStructure, loadId: 0, dirty: false, busy: false, selected: false, confirmDiscard: false,
  };
  private active?: SelectedStructure;
  private baseline?: ChemDraftDocument;
  private readEditor?: () => ChemDraftDocument;
  private selectionVersion = 0;
  private writing = false;
  /** Retain the Update result until the latest selection read completes. */
  private updateNotice?: { message: string; failed: boolean };
  private disposed = false;

  constructor(
    private readonly adapter: OfficeHostAdapter,
    private readonly prepare = prepareOfficePicture,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private patch(values: Partial<PaneState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }

  connect(document: OfficeDocument) {
    this.disposed = false;
    let disconnected = false;
    const changed = () => { if (!disconnected) void this.refresh(); };
    const installed = officeAsync<void>(done => document.addHandlerAsync("documentSelectionChanged", changed, done));
    void installed.then(changed, error => {
      if (!disconnected) this.patch({ status: "Could not watch the Office selection. " + errorMessage(error) });
    });
    return () => {
      disconnected = true;
      this.disposed = true;
      this.selectionVersion++;
      void installed.then(() => officeAsync<void>(done =>
        document.removeHandlerAsync("documentSelectionChanged", { handler: changed }, done))).catch(() => undefined);
    };
  }

  attachEditor(loadId: number, read: () => ChemDraftDocument) {
    if (loadId !== this.state.loadId) return () => undefined;
    this.readEditor = read;
    this.baseline ??= read();
    return () => {
      if (this.readEditor === read) this.readEditor = undefined;
    };
  }

  observeEditor() {
    const dirty = this.isDirty();
    if (dirty !== this.state.dirty) this.patch({ dirty });
  }

  private isDirty() {
    if (!this.baseline || !this.readEditor) return false;
    try {
      return !assistantDocumentContentUnchanged(this.baseline, this.readEditor(), { checkBracketIdentity: true });
    } catch {
      // An incomplete inline draft may still contain unsaved input.
      return true;
    }
  }

  private load(result: SelectionResult, notice?: string) {
    this.active = undefined;
    this.baseline = undefined;
    this.readEditor = undefined;
    const unloaded = {
      document: undefined, loadId: this.state.loadId + 1, busy: false, dirty: false,
      selected: false, confirmDiscard: false, updateRefusal: undefined,
    };
    if (result.kind !== "structure") {
      const status = result.kind === "refusal" ? result.reason : selectStructure;
      this.patch({ ...unloaded, status: notice ? notice + " " + status : status });
      return;
    }
    try {
      const opened = openOfficeDrawing(result.json);
      this.active = result;
      this.patch({
        ...unloaded, document: opened.document, selected: true, updateRefusal: result.updateRefusal,
        status: [notice ?? (result.updateRefusal ? undefined : "Structure ready to edit."),
          result.updateRefusal, ...opened.warnings].filter(Boolean).join(" "),
      });
    } catch (error) {
      this.patch({ ...unloaded, status: [notice, errorMessage(error)].filter(Boolean).join(" ") });
    }
  }

  async refresh() {
    const request = ++this.selectionVersion;
    if (this.writing || this.disposed) return;
    this.patch({ busy: true, selected: false });
    let result: SelectionResult;
    try {
      result = await this.adapter.readSelectedStructure();
    } catch (error) {
      result = refuse("Could not read the Office selection. " + errorMessage(error));
    }
    if (this.disposed || request !== this.selectionVersion) return;
    const notice = this.updateNotice;
    this.updateNotice = undefined;
    if (this.active && sameStructure(this.active, result)) {
      this.active = result;
      this.patch({
        busy: false, selected: true, confirmDiscard: false, updateRefusal: result.updateRefusal,
        status: [notice?.message, result.updateRefusal ??
          (!notice || notice.failed ? "Structure ready to edit." : undefined)].filter(Boolean).join(" "),
      });
    } else if (this.isDirty()) {
      this.patch({
        busy: false, selected: false, confirmDiscard: true,
        status: [notice?.message, "Discard your edits and open the Office selection?"].filter(Boolean).join(" "),
      });
    } else {
      this.load(result, notice?.message);
    }
  }

  keepEditing() {
    this.patch({ confirmDiscard: false, status: "Edits kept. Select the original picture in Office to update it." });
  }

  /**
   * Cancel and "Discard edits" share the editor's close command. After a selection change asked
   * whether to discard, it discards and opens the new Office selection. Otherwise it discards any
   * edits and closes the editor; the Office picture is unchanged, and selecting a picture opens it again.
   */
  cancel = async () => {
    if (this.writing) return;
    this.active = undefined;
    this.baseline = undefined;
    if (this.state.confirmDiscard) {
      await this.refresh();
      return;
    }
    // Drop a selection read still in flight, so it cannot reopen the editor after Cancel.
    this.selectionVersion++;
    this.updateNotice = undefined;
    this.load(noStructure, "Editing cancelled.");
  };

  update = async () => {
    if (this.writing || this.state.busy || !this.state.selected || this.state.updateRefusal ||
        !this.readEditor || !this.isDirty()) return;
    const version = this.selectionVersion;
    this.writing = true;
    this.patch({ busy: true, status: "Updating structure…" });
    let resultMessage: string;
    let updated = false;
    try {
      const document = this.readEditor();
      const { png, json, size, warnings } = await this.prepare(document);
      if (version !== this.selectionVersion || this.disposed) throw new Error(selectionChanged);
      const result = await this.adapter.replaceSelectedStructure(png, json, size);
      if (result.kind === "refusal") throw new Error(result.reason);
      updated = true;
      this.baseline = document;
      this.active = result.key === undefined ? undefined : { kind: "structure", key: result.key, json };
      resultMessage = ["Structure updated.", ...warnings, ...(result.warnings ?? [])].join(" ");
    } catch (error) {
      resultMessage = errorMessage(error);
    } finally {
      this.writing = false;
    }
    if (updated || version !== this.selectionVersion) {
      this.updateNotice = { message: resultMessage, failed: !updated };
      await this.refresh();
    } else {
      this.patch({ busy: false, status: resultMessage });
    }
  };
}
