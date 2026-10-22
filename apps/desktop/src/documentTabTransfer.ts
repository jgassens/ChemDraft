import { ChemDraftDocumentSchema, type DocumentHistory } from "@chemdraft/chem-core";

/** Session recovery deliberately stores only the present drawing. A live move retains history. */
export interface TabTransfer<T> {
  version: 1;
  title: string;
  pristine: boolean;
  browserFileKey?: string;
  undoLabels: Array<string | null>;
  state: T;
}

export function transferHistoryDocuments(history: DocumentHistory) {
  return [...history.past, history.present, ...history.future];
}

/** Validate without replacing document objects: history and undo labels must share identity. */
export function validateTabTransfer<T>(raw: unknown): TabTransfer<T> {
  if (!raw || typeof raw !== "object") throw new Error("The moved document is missing");
  const value = raw as TabTransfer<{ history: DocumentHistory; file: { dirty: boolean; path?: string }; viewport: { scale: number }; parts: unknown[] }>;
  if (value.version !== 1 || typeof value.title !== "string" || typeof value.pristine !== "boolean" ||
      !value.state || !value.state.history || !Array.isArray(value.state.history.past) ||
      !Array.isArray(value.state.history.future) || !Array.isArray(value.undoLabels) ||
      !value.undoLabels.every((label) => label === null || typeof label === "string") ||
      typeof value.state.file?.dirty !== "boolean" ||
      (value.state.file.path !== undefined && typeof value.state.file.path !== "string") ||
      !Number.isFinite(value.state.viewport?.scale) || !Array.isArray(value.state.parts)) {
    throw new Error("The moved document has invalid state");
  }
  const documents = transferHistoryDocuments(value.state.history);
  if (documents.length !== value.undoLabels.length) throw new Error("The moved document history is incomplete");
  for (const document of documents) ChemDraftDocumentSchema.parse(document);
  return raw as TabTransfer<T>;
}
