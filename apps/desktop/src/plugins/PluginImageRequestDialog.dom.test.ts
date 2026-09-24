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

function mount(request: OpenPluginImageRequest, onAcquire = vi.fn(), onCancel = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(PluginImageRequestDialog, { request, onAcquire, onCancel })));
  return { onAcquire, onCancel };
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

  it("shows unavailable and actionable permission-denied messages", () => {
    mount({ ...baseRequest, providers: [], unavailableReason: "Screen capture is unavailable." });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("unavailable");

    act(() => root!.render(createElement(PluginImageRequestDialog, {
      request: {
        ...baseRequest,
        error:
          "Screen capture permission is denied. Allow ChemDraft in System Settings → Privacy & Security → Screen Recording, then try again."
      },
      onAcquire: vi.fn(),
      onCancel: vi.fn()
    })));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("System Settings");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Screen Recording");
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
});
