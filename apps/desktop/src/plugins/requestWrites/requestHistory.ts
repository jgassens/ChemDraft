import { adoptDerivedDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { RequestWriteError, type RequestDocument, type RequestHistory } from "@chemdraft/plugin-host";
import { assertNormalizedWriteScope, verifyDesktopRequestWrite } from "./normalizedWrite";
import { normalizeCommittedDocument } from "../../documentWorkflow";

export function selectRequestChanges(document: ChemDraftDocument, ids: ReadonlySet<string>): ChemDraftDocument {
  const page = document.pages.find(candidate => candidate.objects.some(object => ids.has(object.id))) ??
    document.pages.find(candidate => candidate.id === document.selection.pageId) ?? document.pages[0];
  const existing = new Set(document.pages.flatMap(candidate => candidate.objects.map(object => object.id)));
  return adoptDerivedDocument(document, { ...document,
    selection: { ...(page ? { pageId: page.id } : {}), objectIds: [...ids].filter(id => existing.has(id)) } });
}

export interface RequestHistoryPort {
  run<T>(apply: () => T): Promise<T>;
  revision?(): object | undefined;
  onEdit(listener: () => void): () => void;
  commit(after: ChemDraftDocument, label: string, amend: boolean,
    assertFinalDocument: (document: ChemDraftDocument) => void): void;
}

export function createRequestHistory(document: RequestDocument, port: RequestHistoryPort, label: string): RequestHistory {
  let written = false;
  let interrupted = false;
  let revision: object | undefined;
  let touched = new Set<string>();
  const unsubscribe = port.onEdit(() => { if (written) interrupted = true; });
  const check = () => {
    if (interrupted || (written && port.revision && port.revision() !== revision)) throw new RequestWriteError("interrupted", "The drawing was edited after this request's last write.");
    if (!document.read()) throw new RequestWriteError("stale", "The request document was closed or replaced.");
  };
  return {
    check,
    checkFinal: assertNormalizedWriteScope,
    run: apply => port.run(apply),
    verify: verifyDesktopRequestWrite,
    normalize: normalizeCommittedDocument,
    write: (after, ids, guard) => {
      check();
      const nextTouched = new Set([...touched, ...ids]);
      port.commit(selectRequestChanges(after, nextTouched), label, written, guard);
      revision = port.revision?.();
      touched = nextTouched;
      written = true;
    },
    close: unsubscribe
  };
}
