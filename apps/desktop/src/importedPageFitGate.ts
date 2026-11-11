/** Holds the file-open queue until the current imported document's page choice is settled. */
export class ImportedPageFitGate {
  private pending: { tabId: string; resolve: () => void } | undefined;

  wait(tabId: string): Promise<void> {
    if (this.pending) throw new Error("An imported page-size choice is already pending.");
    return new Promise(resolve => { this.pending = { tabId, resolve }; });
  }

  dismiss(tabId: string): void {
    if (this.pending?.tabId !== tabId) return;
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve();
  }
}
