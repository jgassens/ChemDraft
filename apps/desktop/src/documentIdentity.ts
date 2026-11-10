/** The first migrated native window keeps its existing label and identity. */
export function documentWindowId(search = typeof window === "undefined" ? "" : window.location.search): string {
  const route = new URLSearchParams(search);
  return route.get("window") === "doc" ? route.get("id") || "main" : "main";
}

export function createDocumentTabId(): string {
  return crypto.randomUUID();
}

/** Revisions belong to tabs, so a future hand-off can carry them with the tab's other state. */
export class DocumentIdentities {
  private readonly revisions = new Map<string, number>();

  constructor(readonly windowId: string) {}

  key(tabId: string): string {
    return `${this.windowId}:${tabId}:${this.revisions.get(tabId) ?? 0}`;
  }

  /** A replacement or activation invalidates work captured before it, including switch-away/back. */
  advance(tabId: string): void {
    this.revisions.set(tabId, (this.revisions.get(tabId) ?? 0) + 1);
  }

  remove(tabId: string): void {
    this.revisions.delete(tabId);
  }
}
