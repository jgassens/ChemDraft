import type {
  NormalizedPluginPromptTextRequest,
  PluginPromptTextResult
} from "@chemdraft/plugin-api";

export interface OpenPluginTextPrompt {
  id: number;
  pluginId: string;
  pluginName: string;
  request: NormalizedPluginPromptTextRequest;
}

interface PendingPluginTextPrompt extends OpenPluginTextPrompt {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (result: PluginPromptTextResult) => void;
}

/**
 * Desktop-owned rendezvous between the persistent PluginHost and React. The host injects requests;
 * the shell subscribes and renders the first as a modal. Requests from different plugins queue so
 * the app never stacks modal dialogs, while plugin-host independently enforces one per plugin.
 */
export class PluginPromptTextController {
  private nextId = 1;
  private readonly pending: PendingPluginTextPrompt[] = [];
  private readonly listeners = new Set<() => void>();

  promptText(
    plugin: { id: string; name: string },
    request: NormalizedPluginPromptTextRequest,
    signal: AbortSignal
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

  submit(value: string): void {
    const prompt = this.pending[0];
    if (!prompt || value.length === 0 || value.length > prompt.request.maxLength) {
      return;
    }
    this.settle(prompt, { status: "submitted", value });
  }

  cancel(): void {
    const prompt = this.pending[0];
    if (prompt) {
      this.settle(prompt, { status: "cancelled" });
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(prompt: PendingPluginTextPrompt, result: PluginPromptTextResult): void {
    const index = this.pending.indexOf(prompt);
    if (index < 0) {
      return;
    }
    this.pending.splice(index, 1);
    prompt.signal.removeEventListener("abort", prompt.onAbort);
    prompt.resolve(result);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
