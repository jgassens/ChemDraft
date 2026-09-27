import { describe, expect, it, vi } from "vitest";

import { ImageSourceRegistry, type ImageSourceProvider } from "./ImageSourceProvider";
import { PluginImageRequestController } from "./PluginImageRequestController";

// Tauri commands reject with the serialized Rust error, a plain object — never an `Error`.
const tauriRejection = { kind: "failed", message: "Screen Recording settings could not be opened." };

async function openRequest(provider: ImageSourceProvider, relaunch = vi.fn(async () => undefined)) {
  const controller = new PluginImageRequestController(new ImageSourceRegistry([provider]), relaunch);
  const pending = controller.requestImage(
    { id: "org.test.image", name: "Image" },
    { title: "Image", sources: [provider.id] },
    new AbortController().signal
  );
  await vi.waitFor(() => expect(controller.getOpenRequest()).toBeDefined());
  return { controller, pending, id: controller.getOpenRequest()!.id };
}

describe("image dialog errors from native commands are readable", () => {
  it("shows the message of a plain rejected object from acquiring an image", async () => {
    const provider: ImageSourceProvider = {
      id: "file",
      label: "File",
      isAvailable: async () => true,
      acquire: async () => {
        throw tauriRejection;
      }
    };
    const { controller, id } = await openRequest(provider);
    await controller.acquire(id, "file");
    expect(controller.getOpenRequest()?.error).toBe(tauriRejection.message);
  });

  it("shows readable messages from the permission panel's settings, refresh and relaunch commands", async () => {
    let failStatus = false;
    const provider: ImageSourceProvider = {
      id: "screenRegion",
      label: "Screen",
      isAvailable: async () => true,
      permission: {
        status: async () => {
          if (failStatus) throw { kind: "failed", message: "Permission status is unavailable." };
          return "denied";
        },
        request: async () => "denied",
        openSettings: async () => {
          throw tauriRejection;
        },
        requiresRestartAfterGrant: true
      },
      acquire: async () => "cancelled"
    };
    const relaunch = vi.fn(async () => {
      throw { kind: "failed", message: "ChemDraft could not restart itself." };
    });
    const { controller, id } = await openRequest(provider, relaunch);
    await controller.acquire(id, "screenRegion");
    expect(controller.getOpenRequest()?.permissionPanel?.status).toBe("denied");

    await controller.openPermissionSettings(id);
    expect(controller.getOpenRequest()?.error).toBe(tauriRejection.message);

    failStatus = true;
    await controller.refreshPermission(id);
    expect(controller.getOpenRequest()?.error).toBe("Permission status is unavailable.");

    await controller.relaunch(id);
    expect(controller.getOpenRequest()?.error).toBe("ChemDraft could not restart itself.");
    expect(controller.getOpenRequest()?.error).not.toContain("[object Object]");
  });
});
