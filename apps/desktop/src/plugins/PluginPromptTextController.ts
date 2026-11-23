import type {
  NormalizedPluginPromptTextRequest,
  PluginPromptTextResult
} from "@chemdraft/plugin-api";

export interface OpenPluginTextPrompt {
  id: number;
  pluginId: string;
  pluginName: string;
  request: NormalizedPluginPromptTextRequest;
  /** The active-document key the asking command was invoked on; undefined when the host gave none. */
  documentKey?: string;
}

interface PendingPluginTextPrompt extends OpenPluginTextPrompt {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (result: PluginPromptTextResult) => void;
}

/**
 * Desktop-owned rendezvous between the persistent PluginHost and the shell. The host injects
 * requests; the desktop shell presents the first in its own native dialog window
 * (presentPluginTextPromptsNatively), the browser build as an in-page fallback. Requests from
 * different plugins queue so only one prompt is on screen at a time, while plugin-host
 * independently enforces one per plugin.
 *
 * A prompt belongs to the document its command was invoked on: that command's writes may land only
 * there (plugin-host refuses them while another document is active). The prompt is modeless: the
 * user may switch tabs while it is open and keeps what they typed, but an answer is accepted only
 * while the prompt's own document is active again. It ends as cancelled when that document closes
 * or is replaced (`cancelDocument`).
 */
export class PluginPromptTextController {
  private nextId = 1;
  private readonly pending: PendingPluginTextPrompt[] = [];
  private readonly listeners = new Set<() => void>();

  /** @param getActiveDocumentKey the host's active-document key, the same one commands capture. */
  constructor(private readonly getActiveDocumentKey?: () => string | undefined) {}

  promptText(
    plugin: { id: string; name: string },
    request: NormalizedPluginPromptTextRequest,
    signal: AbortSignal,
    documentKey?: string
  ): Promise<PluginPromptTextResult> {
    if (signal.aborted) {
      return Promise.resolve({ status: "cancelled" });
    }
    return new Promise<PluginPromptTextResult>((resolve) => {
      const prompt: PendingPluginTextPrompt = {
        id: this.nextId++,
        pluginId: plugin.id,
        pluginName: plugin.name,
        request,
        documentKey,
        signal,
        resolve,
        onAbort: () => this.settle(prompt, { status: "cancelled" })
      };
      this.pending.push(prompt);
      signal.addEventListener("abort", prompt.onAbort, { once: true });
      this.notify();
    });
  }

  getOpenPrompt(): OpenPluginTextPrompt | undefined {
    return this.pending[0];
  }

  submit(id: number, value: string): void {
    const prompt = this.pending[0];
    if (!prompt || prompt.id !== id || value.length === 0 || value.length > prompt.request.maxLength || !this.isActive(prompt)) {
      return;
    }
    this.settle(prompt, { status: "submitted", value });
  }

  cancel(id: number): void {
    const prompt = this.pending[0];
    if (prompt?.id === id) {
      this.settle(prompt, { status: "cancelled" });
    }
  }

  /** Whether the prompt's document is the active one, so an answer to it may be accepted. */
  isActive(prompt: OpenPluginTextPrompt): boolean {
    return prompt.documentKey === undefined || !this.getActiveDocumentKey || this.getActiveDocumentKey() === prompt.documentKey;
  }

  /** The active document changed: presenters re-check which prompt may be answered now. */
  activeDocumentChanged(): void {
    this.notify();
  }

  /**
   * Cancels every prompt bound to `documentKey`: its tab closed or its document was replaced. With
   * `null` (the window is going away) every document-bound prompt is cancelled.
   */
  cancelDocument(documentKey: string | null): void {
    const ended = this.pending.filter(prompt =>
      prompt.documentKey !== undefined && (documentKey === null || prompt.documentKey === documentKey));
    if (ended.length === 0) return;
    // Remove them all before telling the presenter, so an ended prompt queued behind the open one is
    // never shown on the way out.
    for (const prompt of ended) this.settle(prompt, { status: "cancelled" }, false);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(prompt: PendingPluginTextPrompt, result: PluginPromptTextResult, notify = true): void {
    const index = this.pending.indexOf(prompt);
    if (index < 0) {
      return;
    }
    this.pending.splice(index, 1);
    prompt.signal.removeEventListener("abort", prompt.onAbort);
    prompt.resolve(result);
    if (notify) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
