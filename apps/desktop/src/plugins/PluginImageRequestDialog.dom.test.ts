// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ImageSourceError,
  ImageSourceRegistry,
  type ImageSourceProvider
} from "./ImageSourceProvider";
import { PluginImageRequestController, type OpenPluginImageRequest } from "./PluginImageRequestController";
import { PluginImageRequestDialog } from "./PluginImageRequestDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  container = undefined;
  root = undefined;
});

function mount(
  request: OpenPluginImageRequest,
  callbacks: Partial<{
    onAcquire: ReturnType<typeof vi.fn>;
    onOpenPermissionSettings: ReturnType<typeof vi.fn>;
    onPermissionFocus: ReturnType<typeof vi.fn>;
    onRelaunch: ReturnType<typeof vi.fn>;
    onCancel: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const onAcquire = callbacks.onAcquire ?? vi.fn();
  const onOpenPermissionSettings = callbacks.onOpenPermissionSettings ?? vi.fn();
  const onPermissionFocus = callbacks.onPermissionFocus ?? vi.fn();
  const onRelaunch = callbacks.onRelaunch ?? vi.fn();
  const onCancel = callbacks.onCancel ?? vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(PluginImageRequestDialog, {
    request,
    onAcquire,
    onOpenPermissionSettings,
    onPermissionFocus,
    onRelaunch,
    onCancel
  })));
  return { onAcquire, onOpenPermissionSettings, onPermissionFocus, onRelaunch, onCancel };
}

function rerender(request: OpenPluginImageRequest, callbacks: ReturnType<typeof mount>) {
  act(() => root!.render(createElement(PluginImageRequestDialog, { request, ...callbacks })));
}

function imageDialog(): HTMLElement {
  return document.querySelector<HTMLElement>(".plugin-image-dialog")!;
}

const baseRequest: OpenPluginImageRequest = {
  id: 1,
  pluginId: "org.test.image",
  pluginName: "Image Plugin",
  request: { title: "Recognize structure from image", sources: ["file", "screenRegion"] },
  providers: [
    { id: "file", label: "Choose Image File…" },
    { id: "screenRegion", label: "Capture Screen Region…" }
  ]
};

describe("PluginImageRequestDialog", () => {
  it("renders exactly one button per available provider and never submits a source blindly", () => {
    const { onAcquire } = mount(baseRequest);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-image-source]")];
    expect(buttons.map((button) => button.dataset.imageSource)).toEqual(["file", "screenRegion"]);
    expect(document.body.textContent).toContain("Requested by Image Plugin (org.test.image)");

    act(() => {
      document.querySelector<HTMLElement>(".plugin-image-dialog")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onAcquire).not.toHaveBeenCalled();

    act(() => buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAcquire).toHaveBeenCalledWith(1, "screenRegion");
  });

  it("cancels on Escape", () => {
    const { onCancel } = mount(baseRequest);
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-image-source="file"]')!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it("keeps the keyboard on the dialog while the focused source is disabled for acquiring, and after it fails", () => {
    const callbacks = mount(baseRequest);
    const file = document.querySelector<HTMLButtonElement>('[data-image-source="file"]')!;
    act(() => file.focus());
    act(() => file.click());
    expect(callbacks.onAcquire).toHaveBeenCalledWith(1, "file");

    // Acquiring: every source button is disabled, including the focused one.
    rerender({ ...baseRequest, acquiringSource: "file" }, callbacks);
    expect(file.disabled).toBe(true);
    expect(document.activeElement).toBe(imageDialog());

    // An oversized file (or a failed capture) re-enables the sources with an error; focus stays put.
    rerender(
      {
        ...baseRequest,
        error: "The selected image is 9000 × 10 pixels; images must be at most 8192 pixels on each side."
      },
      callbacks
    );
    expect(imageDialog().contains(document.activeElement)).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("8192 pixels");

    // Tab still cycles inside the dialog, and Escape still cancels.
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(file);
    act(() => imageDialog().focus());
    act(() =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(callbacks.onCancel).toHaveBeenCalledWith(1);
  });

  it("refocuses the dialog when focus drops to the page body", () => {
    const callbacks = mount(baseRequest);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    rerender({ ...baseRequest, acquiringSource: "screenRegion" }, callbacks);
    expect(document.activeElement).toBe(imageDialog());
  });

  it("shows unavailable messages", () => {
    mount({ ...baseRequest, providers: [], unavailableReason: "Screen capture is unavailable." });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  });

  it("shows actionable permission controls while keeping the file source available", () => {
    const onOpenPermissionSettings = vi.fn();
    const onRelaunch = vi.fn();
    mount({
      ...baseRequest,
      permissionPanel: {
        source: "screenRegion",
        status: "denied",
        message: "ChemDraft needs Screen Recording permission to capture part of the screen.",
        openSettingsLabel: "Open Screen Recording Settings",
        restartNote: "macOS applies the permission after ChemDraft restarts.",
        showRelaunch: true
      }
    }, { onOpenPermissionSettings, onRelaunch });

    const fileButton = document.querySelector<HTMLButtonElement>('[data-image-source="file"]')!;
    expect(fileButton.disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Screen Recording permission");
    const settings = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Open Screen Recording Settings"
    )!;
    const relaunch = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Quit & Reopen ChemDraft"
    )!;
    act(() => settings.click());
    act(() => relaunch.click());
    expect(onOpenPermissionSettings).toHaveBeenCalledWith(1);
    expect(onRelaunch).toHaveBeenCalledWith(1);
  });

  it("rechecks provider permission when the window regains focus", () => {
    const onPermissionFocus = vi.fn();
    mount({
      ...baseRequest,
      permissionPanel: {
        source: "screenRegion",
        status: "denied",
        message: "Permission needed.",
        openSettingsLabel: "Open Settings",
        showRelaunch: true
      }
    }, { onPermissionFocus });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(onPermissionFocus).toHaveBeenCalledWith(1);
  });
});

describe("PluginImageRequestController", () => {
  it("returns provided bytes and cancellation through provider-neutral registry entries", async () => {
    const image = {
      mediaType: "image/png" as const,
      bytes: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 20,
      source: "file" as const,
      fileName: "chosen.png"
    };
    const file: ImageSourceProvider = {
      id: "file",
      label: "File",
      isAvailable: async () => true,
      acquire: async () => image
    };
    const screen: ImageSourceProvider = {
      id: "screenRegion",
      label: "Screen",
      isAvailable: async () => false,
      acquire: async () => "cancelled"
    };
    const controller = new PluginImageRequestController(new ImageSourceRegistry([file, screen]));
    const first = controller.requestImage(
      { id: "org.test.image", name: "Image" },
      { title: "Image", sources: ["file", "screenRegion"] },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(controller.getOpenRequest()?.providers).toEqual([{ id: "file", label: "File" }]));
    await controller.acquire(controller.getOpenRequest()!.id, "file");
    await expect(first).resolves.toEqual({ status: "provided", image });

    const second = controller.requestImage(
      { id: "org.test.image", name: "Image" },
      { title: "Image", sources: ["file"] },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(controller.getOpenRequest()).toBeDefined());
    controller.cancel(controller.getOpenRequest()!.id);
    await expect(second).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps the dialog open with a permission message when a provider fails", async () => {
    const provider: ImageSourceProvider = {
      id: "screenRegion",
      label: "Screen",
      isAvailable: async () => true,
      acquire: async () => {
        throw new ImageSourceError(
          "permissionDenied",
          "Allow ChemDraft in System Settings → Privacy & Security → Screen Recording."
        );
      }
    };
    const controller = new PluginImageRequestController(new ImageSourceRegistry([provider]));
    const pending = controller.requestImage(
      { id: "org.test.image", name: "Image" },
      { title: "Image", sources: ["screenRegion"] },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(controller.getOpenRequest()).toBeDefined());
    await controller.acquire(controller.getOpenRequest()!.id, "screenRegion");
    expect(controller.getOpenRequest()?.error).toContain("Screen Recording");
    controller.cancel(controller.getOpenRequest()!.id);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("requests not-determined permission before the first capture", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    const acquire = vi.fn(async () => "cancelled" as const);
    const provider: ImageSourceProvider = {
      id: "screenRegion",
      label: "Screen",
      isAvailable: async () => true,
      permission: {
        status: async () => "notDetermined",
        request: requestPermission,
        openSettings: async () => undefined,
        requiresRestartAfterGrant: true
      },
      acquire
    };
    const controller = new PluginImageRequestController(new ImageSourceRegistry([provider]));
    const pending = controller.requestImage(
      { id: "org.test.image", name: "Image" },
      { title: "Image", sources: ["screenRegion"] },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(controller.getOpenRequest()).toBeDefined());
    await controller.acquire(controller.getOpenRequest()!.id, "screenRegion");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("drives denied settings, relaunch, and focus-regain state through the provider", async () => {
    let status: "denied" | "granted" = "denied";
    const openSettings = vi.fn(async () => undefined);
    const relaunch = vi.fn(async () => undefined);
    const file: ImageSourceProvider = {
      id: "file",
      label: "File",
      isAvailable: async () => true,
      acquire: async () => "cancelled"
    };
    const screen: ImageSourceProvider = {
      id: "screenRegion",
      label: "Screen",
      isAvailable: async () => true,
      permission: {
        status: async () => status,
        request: async () => status,
        openSettings,
        requiresRestartAfterGrant: true,
        deniedMessage: "ChemDraft needs Screen Recording permission to capture part of the screen.",
        grantedRestartMessage: "Permission granted; restart ChemDraft.",
        openSettingsLabel: "Open Screen Recording Settings",
        restartNote: "macOS applies the permission after ChemDraft restarts."
      },
      acquire: async () => "cancelled"
    };
    const controller = new PluginImageRequestController(
      new ImageSourceRegistry([file, screen]),
      relaunch
    );
    const pending = controller.requestImage(
      { id: "org.test.image", name: "Image" },
      { title: "Image", sources: ["file", "screenRegion"] },
      new AbortController().signal
    );
    await vi.waitFor(() => expect(controller.getOpenRequest()).toBeDefined());
    const id = controller.getOpenRequest()!.id;
    await controller.acquire(id, "screenRegion");
    expect(controller.getOpenRequest()?.permissionPanel?.status).toBe("denied");
    expect(controller.getOpenRequest()?.providers.map((provider) => provider.id)).toEqual([
      "file",
      "screenRegion"
    ]);

    await controller.openPermissionSettings(id);
    await controller.relaunch(id);
    expect(openSettings).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();

    status = "granted";
    await controller.refreshPermission(id);
    expect(controller.getOpenRequest()?.permissionPanel).toMatchObject({
      status: "restartRequired",
      message: "Permission granted; restart ChemDraft.",
      showRelaunch: true
    });
    controller.cancel(id);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });
});
