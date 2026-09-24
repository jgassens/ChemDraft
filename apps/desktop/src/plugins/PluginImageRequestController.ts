import type {
  NormalizedPluginImageRequest,
  PluginImageRequestResult,
  PluginImageSource
} from "@chemdraft/plugin-api";

import type { ImageSourceProvider } from "./ImageSourceProvider";
import { ImageSourceRegistry } from "./ImageSourceProvider";

export interface OpenPluginImageRequest {
  id: number;
  pluginId: string;
  pluginName: string;
  request: NormalizedPluginImageRequest;
  providers: readonly Pick<ImageSourceProvider, "id" | "label">[];
  acquiringSource?: PluginImageSource;
  error?: string;
  unavailableReason?: string;
}

interface PendingPluginImageRequest extends OpenPluginImageRequest {
  providerInstances: readonly ImageSourceProvider[];
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (result: PluginImageRequestResult) => void;
}

/** Persistent rendezvous between PluginHost and the provider-neutral React modal. */
export class PluginImageRequestController {
  private nextId = 1;
  private readonly pending: PendingPluginImageRequest[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly registry: ImageSourceRegistry) {}

  async requestImage(
    plugin: { id: string; name: string },
    request: NormalizedPluginImageRequest,
    signal: AbortSignal
  ): Promise<PluginImageRequestResult> {
    if (signal.aborted) return { status: "cancelled" };
    const providers = await this.registry.available(request.sources);
    if (signal.aborted) return { status: "cancelled" };
    return new Promise<PluginImageRequestResult>((resolve) => {
      const pending: PendingPluginImageRequest = {
        id: this.nextId++,
        pluginId: plugin.id,
        pluginName: plugin.name,
        request,
        providers: providers.map(({ id, label }) => ({ id, label })),
        providerInstances: providers,
        signal,
        resolve,
        unavailableReason:
          providers.length === 0
            ? "None of the requested image sources are available on this platform."
            : undefined,
        onAbort: () => this.settle(pending, { status: "cancelled" })
      };
      this.pending.push(pending);
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.notify();
    });
  }

  getOpenRequest(): OpenPluginImageRequest | undefined {
    const request = this.pending[0];
    if (!request) return undefined;
    const { providerInstances: _providers, signal: _signal, onAbort: _onAbort, resolve: _resolve, ...open } = request;
    return open;
  }

  async acquire(id: number, source: PluginImageSource): Promise<void> {
    const request = this.pending[0];
    if (!request || request.id !== id || request.acquiringSource) return;
    const provider = request.providerInstances.find((candidate) => candidate.id === source);
    if (!provider) return;
    request.acquiringSource = source;
    request.error = undefined;
    this.notify();
    try {
      const image = await provider.acquire(request.signal);
      if (request.signal.aborted) {
        this.settle(request, { status: "cancelled" });
      } else if (image === "cancelled") {
        this.settle(request, { status: "cancelled" });
      } else {
        this.settle(request, { status: "provided", image });
      }
    } catch (error) {
      if (request.signal.aborted) {
        this.settle(request, { status: "cancelled" });
        return;
      }
      request.acquiringSource = undefined;
      request.error = error instanceof Error ? error.message : String(error);
      this.notify();
    }
  }

  cancel(id: number): void {
    const request = this.pending[0];
    if (!request || request.id !== id) return;
    this.settle(
      request,
      request.unavailableReason
        ? { status: "unavailable", reason: request.unavailableReason }
        : { status: "cancelled" }
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(request: PendingPluginImageRequest, result: PluginImageRequestResult): void {
    const index = this.pending.indexOf(request);
    if (index < 0) return;
    this.pending.splice(index, 1);
    request.signal.removeEventListener("abort", request.onAbort);
    request.resolve(result);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
