import type {
  NormalizedPluginImageRequest,
  PluginImageRequestResult,
  PluginImageSource
} from "@chemdraft/plugin-api";
import { invoke } from "@tauri-apps/api/core";

import type {
  ImageSourcePermission,
  ImageSourcePermissionStatus,
  ImageSourceProvider
} from "./ImageSourceProvider";
import { ImageSourceRegistry } from "./ImageSourceProvider";

export interface OpenImagePermissionPanel {
  source: PluginImageSource;
  status: "denied" | "restartRequired";
  message: string;
  openSettingsLabel: string;
  restartNote?: string;
  showRelaunch: boolean;
}

export interface OpenPluginImageRequest {
  id: number;
  pluginId: string;
  pluginName: string;
  request: NormalizedPluginImageRequest;
  providers: readonly Pick<ImageSourceProvider, "id" | "label">[];
  acquiringSource?: PluginImageSource;
  permissionPanel?: OpenImagePermissionPanel;
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

  constructor(
    private readonly registry: ImageSourceRegistry,
    private readonly relaunchApplication: () => Promise<unknown> = () => invoke("relaunch_app")
  ) {}

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
      if (!(await this.preparePermission(request, provider))) return;
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
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "permissionDenied" &&
        provider.permission
      ) {
        const status = await this.permissionStatusAfterCaptureDenial(provider.permission);
        this.showPermissionPanel(request, provider, status === "granted");
        return;
      }
      request.error = error instanceof Error ? error.message : String(error);
      this.notify();
    }
  }

  async openPermissionSettings(id: number): Promise<void> {
    const selection = this.permissionSelection(id);
    if (!selection) return;
    try {
      await selection.permission.openSettings();
    } catch (error) {
      selection.request.error = error instanceof Error ? error.message : String(error);
      this.notify();
    }
  }

  async refreshPermission(id: number): Promise<void> {
    const selection = this.permissionSelection(id);
    if (!selection) return;
    try {
      const status = await selection.permission.status();
      if (status === "granted") {
        if (selection.permission.requiresRestartAfterGrant) {
          this.showPermissionPanel(selection.request, selection.provider, true);
        } else {
          selection.request.permissionPanel = undefined;
          selection.request.error = undefined;
          this.notify();
        }
      } else if (status === "denied") {
        this.showPermissionPanel(selection.request, selection.provider, false);
      }
    } catch (error) {
      selection.request.error = error instanceof Error ? error.message : String(error);
      this.notify();
    }
  }

  async relaunch(id: number): Promise<void> {
    const request = this.pending[0];
    if (!request || request.id !== id || !request.permissionPanel?.showRelaunch) return;
    try {
      await this.relaunchApplication();
    } catch (error) {
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

  private async preparePermission(
    request: PendingPluginImageRequest,
    provider: ImageSourceProvider
  ): Promise<boolean> {
    if (!provider.permission) return true;
    let status = await provider.permission.status();
    if (status === "notDetermined") {
      status = await provider.permission.request();
    }
    if (status === "denied" || status === "notDetermined") {
      request.acquiringSource = undefined;
      this.showPermissionPanel(request, provider, false);
      return false;
    }
    if (
      status === "granted" &&
      request.permissionPanel?.source === provider.id &&
      request.permissionPanel.status === "restartRequired"
    ) {
      request.acquiringSource = undefined;
      this.notify();
      return false;
    }
    request.permissionPanel = undefined;
    return true;
  }

  private async permissionStatusAfterCaptureDenial(
    permission: ImageSourcePermission
  ): Promise<ImageSourcePermissionStatus> {
    try {
      return await permission.status();
    } catch {
      return "denied";
    }
  }

  private showPermissionPanel(
    request: PendingPluginImageRequest,
    provider: ImageSourceProvider,
    restartRequired: boolean
  ): void {
    const permission = provider.permission;
    if (!permission) return;
    request.acquiringSource = undefined;
    request.error = undefined;
    request.permissionPanel = {
      source: provider.id,
      status: restartRequired ? "restartRequired" : "denied",
      message: restartRequired
        ? permission.grantedRestartMessage ??
          "Permission is granted. Quit and reopen ChemDraft before using this image source."
        : permission.deniedMessage ?? "ChemDraft needs permission to use this image source.",
      openSettingsLabel: permission.openSettingsLabel ?? "Open Permission Settings",
      restartNote: permission.requiresRestartAfterGrant ? permission.restartNote : undefined,
      showRelaunch: permission.requiresRestartAfterGrant
    };
    this.notify();
  }

  private permissionSelection(id: number): {
    request: PendingPluginImageRequest;
    provider: ImageSourceProvider;
    permission: ImageSourcePermission;
  } | undefined {
    const request = this.pending[0];
    if (!request || request.id !== id || !request.permissionPanel) return undefined;
    const provider = request.providerInstances.find(
      (candidate) => candidate.id === request.permissionPanel?.source
    );
    if (!provider?.permission) return undefined;
    return { request, provider, permission: provider.permission };
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
