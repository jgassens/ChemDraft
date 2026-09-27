import { applyPatch, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { PluginApiVersion } from "@chemdraft/plugin-api";
import type {
  PluginCommandContext,
  PluginImageRequestResult,
  PluginManifest,
  PluginPanelReport,
  PluginPermission,
  PluginProvidedImage,
  PluginPromptTextResult
} from "@chemdraft/plugin-api";
import { PluginImageMaxBytes } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import pluginHostPackage from "../package.json";
import {
  CommandRegistry,
  CommandRegistryError,
  PluginHost,
  PluginHostError,
  PluginPermissionError,
  validateTrustedPluginManifest
} from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

function moleculeObject(id = "mol_001"): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 80,
    y: 96,
    width: 160,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

describe("CommandRegistry", () => {
  it("registers, lists, and invokes a command definition", async () => {
    const registry = new CommandRegistry();

    registry.register({ id: "document.new", title: "New Document", source: "core" }, () => {
      return "new-document";
    });

    await expect(registry.invoke("document.new")).resolves.toBe("new-document");
    expect(registry.list()).toEqual([
      {
        id: "document.new",
        title: "New Document",
        source: "core",
        requiredPermissions: [],
        enabled: true
      }
    ]);
  });

  it("rejects duplicate, disabled, missing, and permission-gated commands", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "plugin.secure.run", title: "Run", requiredPermissions: ["native.execute"] }, () => "ok");
    registry.register({ id: "plugin.disabled.run", title: "Disabled", enabled: false }, () => "ok");

    expect(() => registry.register({ id: "plugin.secure.run", title: "Duplicate" }, () => "ok")).toThrow(
      CommandRegistryError
    );
    await expect(registry.invoke("plugin.missing.run")).rejects.toThrow(CommandRegistryError);
    await expect(registry.invoke("plugin.disabled.run")).rejects.toThrow(CommandRegistryError);
    await expect(registry.invoke("plugin.secure.run")).rejects.toThrow(PluginPermissionError);
    await expect(
      registry.invoke("plugin.secure.run", {
        permissions: new Set(["native.execute"])
      })
    ).resolves.toBe("ok");
  });
});

describe("PluginHost", () => {
  it("keeps the published package version aligned with the plugin API contract", () => {
    expect(pluginHostPackage.version).toBe(PluginApiVersion);
  });

  it("exposes dialogs only to plugins that declared ui.panel", async () => {
    const promptText = vi.fn(async () => ({ status: "cancelled" as const }));
    const host = new PluginHost({ promptText });
    let dialogs: PluginCommandContext["dialogs"] | "unset" = "unset";
    host.registerPlugin(
      {
        id: "org.test.no-dialogs",
        name: "No Dialogs",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "plugin.noDialogs.run", title: "Run" }] }
      },
      { commandHandlers: { "plugin.noDialogs.run": (context) => (dialogs = context.dialogs) } }
    );

    await host.invokeCommand("plugin.noDialogs.run");
    expect(dialogs).toBeUndefined();
    expect(promptText).not.toHaveBeenCalled();
  });

  it("rejects dialogs.promptText outside the command invocation that received the context", async () => {
    const promptText = vi.fn(async () => ({ status: "cancelled" as const }));
    const host = new PluginHost({ promptText });
    let retainedDialogs: PluginCommandContext["dialogs"];
    host.registerPlugin(
      {
        id: "org.test.retained-dialogs",
        name: "Retained Dialogs",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.retainedDialogs.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.retainedDialogs.run": (context) => {
            retainedDialogs = context.dialogs;
          }
        }
      }
    );

    await host.invokeCommand("plugin.retainedDialogs.run");
    await expect(
      retainedDialogs!.promptText({ title: "Late", label: "Value" })
    ).rejects.toThrow(/org\.test\.retained-dialogs.*only while.*own commands.*executing/i);
    expect(promptText).not.toHaveBeenCalled();
  });

  it("rejects a concurrent second prompt in the same command invocation", async () => {
    let resolvePrompt!: (result: PluginPromptTextResult) => void;
    const promptText = vi.fn(
      () => new Promise<PluginPromptTextResult>((resolve) => (resolvePrompt = resolve))
    );
    const host = new PluginHost({ promptText });
    let firstResult: PluginPromptTextResult | undefined;
    host.registerPlugin(
      {
        id: "org.test.concurrent-dialogs",
        name: "Concurrent Dialogs",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.concurrentDialogs.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.concurrentDialogs.run": async (context) => {
            const first = context.dialogs!.promptText({ title: "First", label: "Value" });
            await expect(
              context.dialogs!.promptText({ title: "Second", label: "Value" })
            ).rejects.toThrow(/org\.test\.concurrent-dialogs.*at most once per command invocation/i);
            resolvePrompt({ status: "submitted", value: "first answer" });
            firstResult = await first;
          }
        }
      }
    );

    await host.invokeCommand("plugin.concurrentDialogs.run");
    expect(firstResult).toEqual({ status: "submitted", value: "first answer" });
    expect(promptText).toHaveBeenCalledTimes(1);
  });

  it("rejects a second prompt after the first settled in the same command invocation", async () => {
    const promptText = vi.fn(async () => ({ status: "cancelled" as const }));
    const host = new PluginHost({ promptText });
    host.registerPlugin(
      {
        id: "org.test.repeated-dialogs",
        name: "Repeated Dialogs",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.repeatedDialogs.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.repeatedDialogs.run": async (context) => {
            await context.dialogs!.promptText({ title: "First", label: "Value" });
            await context.dialogs!.promptText({ title: "Second", label: "Value" });
          }
        }
      }
    );

    const error = await host.invokeCommand("plugin.repeatedDialogs.run").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PluginHostError);
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(/org\.test\.repeated-dialogs.*at most once per command invocation/i)
    );
    expect(promptText).toHaveBeenCalledTimes(1);
  });

  it("validates prompt requests before opening host UI", async () => {
    const promptText = vi.fn(async () => ({ status: "cancelled" as const }));
    const host = new PluginHost({ promptText });
    host.registerPlugin(
      {
        id: "org.test.invalid-dialog",
        name: "Invalid Dialog",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.invalidDialog.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.invalidDialog.run": (context) =>
            context.dialogs!.promptText({ title: "", label: "Value", maxLength: 0 })
        }
      }
    );

    await expect(host.invokeCommand("plugin.invalidDialog.run")).rejects.toThrow();
    expect(promptText).not.toHaveBeenCalled();
  });

  it("spends the once-per-invocation prompt only when a prompt is shown, so a corrected retry works", async () => {
    const promptText = vi.fn(async () => ({ status: "submitted" as const, value: "benzene" }));
    const host = new PluginHost({ promptText });
    let invalid: unknown;
    host.registerPlugin(
      {
        id: "org.test.retry-dialog",
        name: "Retry Dialog",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.retryDialog.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.retryDialog.run": async (context) => {
            invalid = await context.dialogs!.promptText({ title: "", label: "Name" }).catch((error: unknown) => error);
            const answer = await context.dialogs!.promptText({ title: "Name", label: "Name" });
            // That one was shown, so the allowance is now spent.
            await expect(context.dialogs!.promptText({ title: "Again", label: "Name" })).rejects.toThrow(
              /at most once per command invocation/
            );
            return answer;
          }
        }
      }
    );

    await expect(host.invokeCommand("plugin.retryDialog.run")).resolves.toEqual({
      status: "submitted",
      value: "benzene"
    });
    expect(invalid).toBeInstanceOf(Error);
    expect(promptText).toHaveBeenCalledTimes(1);
  });

  it("does not spend the prompt allowance when another invocation's prompt is still open", async () => {
    let resolveFirst!: (result: PluginPromptTextResult) => void;
    const promptText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<PluginPromptTextResult>((resolve) => (resolveFirst = resolve)))
      .mockImplementation(async () => ({ status: "submitted" as const, value: "second" }));
    const host = new PluginHost({ promptText });
    let refused: unknown;
    let firstOpen!: () => void;
    const opened = new Promise<void>((resolve) => (firstOpen = resolve));
    host.registerPlugin(
      {
        id: "org.test.overlapping-dialogs",
        name: "Overlapping Dialogs",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: {
          commands: [
            { id: "plugin.overlappingDialogs.first", title: "First" },
            { id: "plugin.overlappingDialogs.second", title: "Second" }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.overlappingDialogs.first": (context) => {
            const pending = context.dialogs!.promptText({ title: "First", label: "Value" });
            firstOpen();
            return pending;
          },
          "plugin.overlappingDialogs.second": async (context) => {
            refused = await context.dialogs!.promptText({ title: "Second", label: "Value" }).catch((error: unknown) => error);
            await opened;
            resolveFirst({ status: "cancelled" });
            await first;
            // The refused call showed nothing, so this invocation may still prompt once.
            return context.dialogs!.promptText({ title: "Second", label: "Value" });
          }
        }
      }
    );

    const first = host.invokeCommand("plugin.overlappingDialogs.first");
    await opened;
    await expect(host.invokeCommand("plugin.overlappingDialogs.second")).resolves.toEqual({
      status: "submitted",
      value: "second"
    });
    expect(refused).toHaveProperty("message", expect.stringMatching(/concurrent prompts are not allowed/));
    expect(promptText).toHaveBeenCalledTimes(2);
  });

  it("rejects a host UI result longer than the request maxLength", async () => {
    const promptText = vi.fn(async () => ({ status: "submitted" as const, value: "12345" }));
    const host = new PluginHost({ promptText });
    host.registerPlugin(
      {
        id: "org.test.long-dialog-result",
        name: "Long Dialog Result",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.longDialogResult.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.longDialogResult.run": (context) =>
            context.dialogs!.promptText({ title: "Prompt", label: "Value", maxLength: 4 })
        }
      }
    );

    await expect(host.invokeCommand("plugin.longDialogResult.run")).rejects.toThrow(
      /org\.test\.long-dialog-result.*more than 4 characters/i
    );
    expect(promptText).toHaveBeenCalledOnce();
  });

  it("passes submitted text through exactly and preserves cancellation", async () => {
    const promptText = vi
      .fn()
      .mockResolvedValueOnce({ status: "submitted", value: "  cyclohexane  " })
      .mockResolvedValueOnce({ status: "cancelled" });
    const host = new PluginHost({ promptText });
    const results: PluginPromptTextResult[] = [];
    host.registerPlugin(
      {
        id: "org.test.dialog-results",
        name: "Dialog Results",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: {
          commands: [
            { id: "plugin.dialogResults.submit", title: "Submit" },
            { id: "plugin.dialogResults.cancel", title: "Cancel" }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.dialogResults.submit": async (context) => {
            results.push(await context.dialogs!.promptText({ title: "Submit", label: "Value" }));
          },
          "plugin.dialogResults.cancel": async (context) => {
            results.push(await context.dialogs!.promptText({ title: "Cancel", label: "Value" }));
          }
        }
      }
    );

    await host.invokeCommand("plugin.dialogResults.submit");
    await host.invokeCommand("plugin.dialogResults.cancel");
    expect(results).toEqual([
      { status: "submitted", value: "  cyclohexane  " },
      { status: "cancelled" }
    ]);
  });

  it("exposes images only with image.read and normalizes requests before host acquisition", async () => {
    const requestImage = vi.fn(async (): Promise<PluginImageRequestResult> => ({
      status: "provided",
      image: {
        mediaType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
        width: 20,
        height: 10,
        source: "file",
        fileName: "structure.png"
      }
    }));
    const host = new PluginHost({ requestImage });
    let withoutPermission: PluginCommandContext["images"] | "unset" = "unset";
    host.registerPlugin(
      {
        id: "org.test.no-image",
        name: "No Image",
        version: "0.0.1",
        apiVersion: "^0.1.5",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "plugin.noImage.run", title: "Run" }] }
      },
      { commandHandlers: { "plugin.noImage.run": (context) => (withoutPermission = context.images) } }
    );
    host.registerPlugin(
      {
        id: "org.test.image",
        name: "Image Reader",
        version: "0.0.1",
        apiVersion: "^0.1.5",
        entry: "dist/plugin.js",
        permissions: ["image.read"],
        contributes: {
          commands: [
            { id: "plugin.image.run", title: "Run", requiredPermissions: ["image.read"] }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.image.run": (context) => context.images!.requestImage({ title: "Choose image" })
        }
      }
    );

    await host.invokeCommand("plugin.noImage.run");
    expect(withoutPermission).toBeUndefined();
    await expect(host.invokeCommand("plugin.image.run")).resolves.toMatchObject({
      status: "provided",
      image: { width: 20, height: 10, source: "file" }
    });
    expect(requestImage).toHaveBeenCalledWith(
      { id: "org.test.image", name: "Image Reader" },
      { title: "Choose image", sources: ["file", "screenRegion"] },
      expect.any(AbortSignal)
    );
  });

  it("rejects a retained images.requestImage call outside its owning command", async () => {
    const requestImage = vi.fn(async (): Promise<PluginImageRequestResult> => ({ status: "cancelled" }));
    const host = new PluginHost({ requestImage });
    let retained: PluginCommandContext["images"];
    host.registerPlugin(
      {
        id: "org.test.late-image",
        name: "Late Image",
        version: "0.0.1",
        apiVersion: "^0.1.5",
        entry: "dist/plugin.js",
        permissions: ["image.read"],
        contributes: { commands: [{ id: "plugin.lateImage.run", title: "Run" }] }
      },
      { commandHandlers: { "plugin.lateImage.run": (context) => (retained = context.images) } }
    );

    await host.invokeCommand("plugin.lateImage.run");
    await expect(retained!.requestImage({ title: "Too late" })).rejects.toThrow(
      /images\.requestImage only while one of its own commands is executing/i
    );
    expect(requestImage).not.toHaveBeenCalled();
  });

  it("enforces host image byte and dimension limits with explicit errors", async () => {
    const requestImage = vi
      .fn<() => Promise<PluginImageRequestResult>>()
      .mockResolvedValueOnce({
        status: "provided",
        image: {
          mediaType: "image/png",
          bytes: new Uint8Array(PluginImageMaxBytes + 1),
          width: 1,
          height: 1,
          source: "file"
        }
      })
      .mockResolvedValueOnce({
        status: "provided",
        image: {
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
          width: 8_193,
          height: 1,
          source: "file"
        }
      });
    const host = new PluginHost({ requestImage });
    host.registerPlugin(
      {
        id: "org.test.image-limits",
        name: "Image Limits",
        version: "0.0.1",
        apiVersion: "^0.1.5",
        entry: "dist/plugin.js",
        permissions: ["image.read"],
        contributes: {
          commands: [
            { id: "plugin.imageLimits.bytes", title: "Bytes" },
            { id: "plugin.imageLimits.dimensions", title: "Dimensions" }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.imageLimits.bytes": (context) => context.images!.requestImage({ title: "Bytes" }),
          "plugin.imageLimits.dimensions": (context) =>
            context.images!.requestImage({ title: "Dimensions" })
        }
      }
    );

    await expect(host.invokeCommand("plugin.imageLimits.bytes")).rejects.toThrow(/25 MB/i);
    await expect(host.invokeCommand("plugin.imageLimits.dimensions")).rejects.toThrow(/8192 pixels/i);
  });

  it.each(["image.read", "ml.inference", "model.load", "native.execute"] as const)(
    "omits recognition when %s is missing",
    async (missing) => {
      const required = ["image.read", "ml.inference", "model.load", "native.execute"] as const;
      const permissions = required.filter((permission) => permission !== missing);
      const host = new PluginHost();
      let recognition: PluginCommandContext["recognition"] | "unset" = "unset";
      host.registerPlugin(
        {
          id: `org.test.recognition-missing-${missing.replace(".", "-")}`,
          name: "Recognition Permission Probe",
          version: "0.0.1",
          apiVersion: "^0.1.6",
          entry: "dist/plugin.js",
          permissions,
          contributes: { commands: [{ id: `plugin.recognitionMissing.${missing.replace(".", "-")}`, title: "Run" }] }
        },
        {
          commandHandlers: {
            [`plugin.recognitionMissing.${missing.replace(".", "-")}`]: (context) => {
              recognition = context.recognition;
            }
          }
        }
      );
      await host.invokeCommand(`plugin.recognitionMissing.${missing.replace(".", "-")}`);
      expect(recognition).toBeUndefined();
    }
  );

  it("accepts only an image handed out in the same active invocation", async () => {
    const provided: PluginProvidedImage = {
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      width: 20,
      height: 10,
      source: "file"
    };
    const recognizeStructure = vi.fn(async () => ({ status: "engineNotInstalled" as const }));
    const host = new PluginHost({
      requestImage: async () => ({ status: "provided", image: provided }),
      recognizeStructure
    });
    const permissions: PluginPermission[] = ["image.read", "ml.inference", "model.load", "native.execute"];
    host.registerPlugin(
      {
        id: "org.test.recognition-image-scope",
        name: "Recognition Scope",
        version: "0.0.1",
        apiVersion: "^0.1.6",
        entry: "dist/plugin.js",
        permissions,
        contributes: { commands: [{ id: "plugin.recognitionScope.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.recognitionScope.run": async (context) => {
            const acquired = await context.images!.requestImage({ title: "Choose image" });
            if (acquired.status !== "provided") throw new Error("fixture image missing");
            await expect(
              context.recognition!.recognizeStructure({
                ...acquired.image,
                bytes: new Uint8Array([9, 9, 9])
              })
            ).rejects.toThrow(/only an image returned by images\.requestImage in this command invocation/i);
            return context.recognition!.recognizeStructure(acquired.image);
          }
        }
      }
    );

    await expect(host.invokeCommand("plugin.recognitionScope.run")).resolves.toEqual({ status: "engineNotInstalled" });
    expect(recognizeStructure).toHaveBeenCalledOnce();
  });

  it("reports cancelled, not engineNotInstalled, when recognition is abandoned mid-call", async () => {
    const provided: PluginProvidedImage = {
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
      width: 1,
      height: 1,
      source: "file"
    };
    let recognitionStarted!: () => void;
    const started = new Promise<void>((resolve) => (recognitionStarted = resolve));
    const recognizeStructure = vi.fn(() => {
      recognitionStarted();
      return new Promise<never>(() => undefined); // the engine never answers on its own
    });
    const host = new PluginHost({
      requestImage: async () => ({ status: "provided", image: provided }),
      recognizeStructure
    });
    host.registerPlugin(
      {
        id: "org.test.abandoned-recognition",
        name: "Abandoned Recognition",
        version: "0.0.1",
        apiVersion: "^0.1.6",
        entry: "dist/plugin.js",
        permissions: ["image.read", "ml.inference", "model.load", "native.execute"],
        contributes: { commands: [{ id: "plugin.abandonedRecognition.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.abandonedRecognition.run": async (context) => {
            const acquired = await context.images!.requestImage({ title: "Choose image" });
            if (acquired.status !== "provided") throw new Error("fixture image missing");
            return context.recognition!.recognizeStructure(acquired.image);
          }
        }
      }
    );

    const invocation = host.invokeCommand("plugin.abandonedRecognition.run");
    await started;
    host.unregisterPlugin("org.test.abandoned-recognition");
    await expect(invocation).resolves.toEqual({ status: "cancelled" });
  });

  it("rejects a retained recognition call after its command invocation ends", async () => {
    const provided: PluginProvidedImage = {
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
      width: 1,
      height: 1,
      source: "file"
    };
    const host = new PluginHost({ requestImage: async () => ({ status: "provided", image: provided }) });
    let retained: PluginCommandContext["recognition"];
    let retainedImage: PluginProvidedImage | undefined;
    host.registerPlugin(
      {
        id: "org.test.late-recognition",
        name: "Late Recognition",
        version: "0.0.1",
        apiVersion: "^0.1.6",
        entry: "dist/plugin.js",
        permissions: ["image.read", "ml.inference", "model.load", "native.execute"],
        contributes: { commands: [{ id: "plugin.lateRecognition.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.lateRecognition.run": async (context) => {
            retained = context.recognition;
            const result = await context.images!.requestImage({ title: "Choose image" });
            if (result.status === "provided") retainedImage = result.image;
          }
        }
      }
    );
    await host.invokeCommand("plugin.lateRecognition.run");
    await expect(retained!.recognizeStructure(retainedImage!)).rejects.toThrow(
      /recognition\.recognizeStructure only while one of its own commands is executing/i
    );
  });

  it("omits documents.applyPatch without document.write", async () => {
    let applyPatchMethod: PluginCommandContext["documents"]["applyPatch"] | "unset" = "unset";
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: [] }));
    const host = new PluginHost({ applyDocumentPatch });
    host.registerPlugin(
      {
        id: "org.test.no-write",
        name: "No Write",
        version: "0.0.1",
        apiVersion: "^0.1.4",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "plugin.noWrite.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.noWrite.run": (context) => {
            applyPatchMethod = context.documents.applyPatch;
          }
        }
      }
    );

    await host.invokeCommand("plugin.noWrite.run");
    expect(applyPatchMethod).toBeUndefined();
    expect(applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("rejects a retained documents.applyPatch call after its command invocation ends", async () => {
    let retainedApplyPatch: NonNullable<PluginCommandContext["documents"]["applyPatch"]> | undefined;
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: ["mol_001"] }));
    const host = new PluginHost({ applyDocumentPatch });
    host.registerPlugin(
      {
        id: "org.test.late-write",
        name: "Late Write",
        version: "0.0.1",
        apiVersion: "^0.1.4",
        entry: "dist/plugin.js",
        permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.lateWrite.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.lateWrite.run": (context) => {
            retainedApplyPatch = context.documents.applyPatch;
          }
        }
      }
    );

    await host.invokeCommand("plugin.lateWrite.run");
    expect(retainedApplyPatch).toBeTypeOf("function");
    await expect(
      retainedApplyPatch!({
        reason: "late insertion",
        patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
      })
    ).rejects.toThrow(/only while one of its own commands is executing/i);
    expect(applyDocumentPatch).not.toHaveBeenCalled();
  });

  it("validates and applies a direct patch during the owning command", async () => {
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: ["mol_001"] }));
    const host = new PluginHost({ applyDocumentPatch });
    host.registerPlugin(
      {
        id: "org.test.direct-write",
        name: "Direct Writer",
        version: "0.0.1",
        apiVersion: "^0.1.4",
        entry: "dist/plugin.js",
        permissions: ["document.write"],
        contributes: {
          commands: [
            {
              id: "plugin.directWrite.insert",
              title: "Insert Structure",
              requiredPermissions: ["document.write"]
            }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.directWrite.insert": (context) =>
            context.documents.applyPatch!({
              reason: "user supplied chemical name",
              patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
            })
        }
      }
    );

    await expect(host.invokeCommand("plugin.directWrite.insert")).resolves.toEqual({
      applied: true,
      objectIds: ["mol_001"]
    });
    expect(applyDocumentPatch).toHaveBeenCalledWith({
      plugin: { id: "org.test.direct-write", name: "Direct Writer", version: "0.0.1" },
      command: { id: "plugin.directWrite.insert", title: "Insert Structure" },
      patch: {
        reason: "user supplied chemical name",
        patch: { op: "addObject", pageId: "page_001", object: moleculeObject() },
        warnings: [],
        requiresUserApproval: true
      },
      undoLabel: "Direct Writer: Insert Structure"
    });
    expect(host.listProposedPatches()).toHaveLength(0);
  });

  it("lets documents.applyPatch insert new content only; edits and removals must be proposed", async () => {
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: [] }));
    const host = new PluginHost({ applyDocumentPatch, now: () => timestamp });
    const patches: Record<string, unknown> = {
      removeObject: { op: "removeObject", objectId: "mol_001" },
      updateObject: { op: "updateObject", objectId: "mol_001", changes: { structure: "CCO" } },
      moveObject: { op: "moveObject", objectId: "mol_001", x: 0, y: 0 },
      removeAnnotation: { op: "removeAnnotation", annotationId: "ann_001" },
      updatePageLayout: { op: "updatePageLayout", pageId: "page_001", layout: {} },
      setSelection: { op: "setSelection", objectIds: [] }
    };
    const outcomes: Record<string, unknown> = {};
    host.registerPlugin(
      {
        id: "org.test.edit-write",
        name: "Edit Writer",
        version: "0.0.1",
        apiVersion: "^0.1.4",
        entry: "dist/plugin.js",
        permissions: ["document.write", "document.proposePatch"],
        contributes: { commands: [{ id: "plugin.editWrite.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.editWrite.run": async (context) => {
            for (const [op, patch] of Object.entries(patches)) {
              outcomes[op] = await context.documents
                .applyPatch!({ reason: "edit existing chemistry", patch: patch as never })
                .catch((error: unknown) => error);
            }
            // Insertion ops pass the gate.
            await context.documents.applyPatch!({
              reason: "typed name",
              patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
            });
            await context.documents.applyPatch!({
              reason: "typed note",
              patch: { op: "addAnnotation", pageId: "page_001", annotation: { id: "ann_001" } } as never
            });
            // The same edit is still available for review.
            return context.documents.proposePatch({ reason: "edit for review", patch: patches.removeObject as never });
          }
        }
      }
    );

    await expect(host.invokeCommand("plugin.editWrite.run")).resolves.toMatchObject({ status: "pending" });
    for (const op of Object.keys(patches)) {
      expect(outcomes[op], op).toBeInstanceOf(PluginHostError);
      expect((outcomes[op] as Error).message).toBe(
        `Plugin "org.test.edit-write" passed a "${op}" patch to documents.applyPatch, which only inserts new content (addObject, addAnnotation); changing or removing what is already in the document must go through documents.proposePatch for review.`
      );
    }
    expect(applyDocumentPatch).toHaveBeenCalledTimes(2);
    expect(applyDocumentPatch.mock.calls.map((call) => (call as unknown as [{ patch: { patch: { op: string } } }])[0].patch.patch.op)).toEqual([
      "addObject",
      "addAnnotation"
    ]);
  });

  it("registers plugin commands and queues proposed patches for user review", async () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin(
      {
        id: "org.chemdraft.ocsr.demo",
        name: "OCSR Demo",
        version: "0.0.1",
        apiVersion: "^1.0.0",
        entry: "dist/plugin.js",
        permissions: ["document.proposePatch", "image.read", "plugin.storage"],
        contributes: {
          commands: [
            {
              id: "plugin.ocsrDemo.recognize",
              title: "Recognize Image",
              requiredPermissions: ["document.proposePatch", "image.read"]
            }
          ]
        }
      },
      {
        commandHandlers: {
          "plugin.ocsrDemo.recognize": async (context) => {
            expect(context.hasPermission("image.read")).toBe(true);
            const storage = context.storage;
            await storage?.set("last-source", "fixture://benzene.png");

            return await context.documents.proposePatch({
              reason: "recognized-structure",
              patch: {
                op: "addObject",
                pageId: "page_001",
                object: moleculeObject()
              }
            });
          }
        }
      }
    );

    const receipt = await host.invokeCommand("plugin.ocsrDemo.recognize");
    expect(receipt).toMatchObject({
      id: "proposal_1",
      pluginId: "org.chemdraft.ocsr.demo",
      status: "pending",
      createdAt: timestamp
    });
    expect(host.listProposedPatches("pending")).toHaveLength(1);
    await expect(host.getStorage("org.chemdraft.ocsr.demo").get("last-source")).resolves.toBe(
      "fixture://benzene.png"
    );
  });

  it("applies an accepted proposed patch through chem-core", async () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.demo",
      name: "Patch Demo",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });

    const queued = host.proposePatch("org.chemdraft.patch.demo", {
      reason: "recognized-structure",
      patch: {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      }
    });

    const document = createEmptyDocument({ now: timestamp });
    const updated = host.acceptProposedPatch(queued.id, document, { now: timestamp });

    expect(updated.pages[0].objects).toEqual([moleculeObject()]);
    // Resolved proposals leave the queue rather than holding their payload for the session.
    expect(host.listProposedPatches()).toHaveLength(0);
    expect(() => host.acceptProposedPatch(queued.id, updated)).toThrow(/does not exist/);
  });

  // A hostile plugin can hand the host a self-referencing proposal: the patch interior is
  // deliberately passthrough() and structuredClone/postMessage both preserve cycles. Freezing that
  // graph without a visited set blew the stack, and the throw escaped through proposePatch /
  // listProposedPatches / rejectProposedPatch — the review tray calls the second during render with
  // no error boundary above it, so untrusted input crashed the whole app, repeatably after restart.
  it("survives a cyclic proposed patch instead of blowing the stack", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.hostile",
      name: "Hostile",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });

    const cyclic: Record<string, unknown> = { op: "updateObject", objectId: "obj_1" };
    cyclic.self = cyclic;
    cyclic.nested = { back: cyclic, list: [cyclic] };

    const queued = host.proposePatch("org.chemdraft.patch.hostile", {
      reason: "hostile-cycle",
      patch: cyclic as never
    });

    // Every queue operation stays usable, so the user can still see and dismiss the proposal.
    expect(() => host.listProposedPatches()).not.toThrow();
    expect(host.listProposedPatches("pending")).toHaveLength(1);
    let rejected!: ReturnType<PluginHost["rejectProposedPatch"]>;
    expect(() => (rejected = host.rejectProposedPatch(queued.id))).not.toThrow();
    expect(host.listProposedPatches()).toHaveLength(0);

    // And the snapshot is still frozen through the cycle.
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(Object.isFrozen(rejected.proposal.patch)).toBe(true);
  });

  // Same threat class as the cycle above, reached by a plugin doing something entirely ordinary.
  // `Object.freeze` THROWS on an ArrayBuffer view that has elements ("Cannot freeze array buffer
  // views with elements"), and `structuredClone`/`postMessage` preserve typed arrays faithfully — so
  // a proposal carrying image bytes, a fingerprint, or any binary blob crashed the same three entry
  // points the cycle guard was added for. `Object.seal` throws on views too, so there is no weaker
  // lock to fall back on: a view has to be a leaf.
  it("survives a proposed patch carrying binary data instead of throwing on freeze", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.binary",
      name: "Binary",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const withBinary: Record<string, unknown> = {
      op: "updateObject",
      objectId: "obj_1",
      thumbnail: bytes,
      nested: { samples: new Float64Array([0.5, 1.5]), view: new DataView(new ArrayBuffer(8)) }
    };

    const queued = host.proposePatch("org.chemdraft.patch.binary", {
      reason: "binary-payload",
      patch: withBinary as never
    });

    // Every queue operation stays usable, so the user can still see and dismiss the proposal.
    expect(() => host.listProposedPatches()).not.toThrow();
    expect(host.listProposedPatches("pending")).toHaveLength(1);
    let rejected!: ReturnType<PluginHost["rejectProposedPatch"]>;
    expect(() => (rejected = host.rejectProposedPatch(queued.id))).not.toThrow();

    // The surrounding graph is still frozen — only the views themselves are exempt, because the
    // language does not permit locking them.
    const patch = rejected.proposal.patch as unknown as Record<string, unknown>;
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(Object.isFrozen(patch)).toBe(true);
    expect(Object.isFrozen(patch.nested)).toBe(true);

    // And the bytes survive the round trip as a real typed array, not a plain object.
    expect(patch.thumbnail).toBeInstanceOf(Uint8Array);
    expect([...(patch.thumbnail as Uint8Array)]).toEqual([1, 2, 3, 4]);
    // The clone is independent of the plugin's own array.
    bytes[0] = 99;
    expect((patch.thumbnail as Uint8Array)[0]).toBe(1);
  });

  // The proposal queue is the one place plugin-authored data is held pending a trusted `applyPatch`.
  // Handing out the stored object let a caller flip `status` behind the host's back, so that the
  // queue and `requirePendingProposal` disagreed about what was still pending.
  it("hands out proposals as frozen copies, so a caller cannot mutate the queue's own state", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({
      id: "org.chemdraft.patch.demo",
      name: "Patch Demo",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.proposePatch"]
    });
    const queued = host.proposePatch("org.chemdraft.patch.demo", {
      reason: "recognized-structure",
      patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
    });

    expect(Object.isFrozen(queued)).toBe(true);
    expect(() => {
      (queued as { status: string }).status = "accepted";
    }).toThrow(TypeError);

    // Mutating a listed copy must not reach the queue either.
    const [listed] = host.listProposedPatches("pending");
    expect(() => {
      (listed as { status: string }).status = "rejected";
    }).toThrow(TypeError);
    expect(host.listProposedPatches("pending")).toHaveLength(1);

    // The host's own transitions still work on its internal copy.
    expect(host.rejectProposedPatch(queued.id).status).toBe("rejected");
    expect(host.listProposedPatches("pending")).toHaveLength(0);
  });

  it("rejects proposed patches from plugins without document.proposePatch", () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.readonly",
      name: "Read Only",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"]
    });

    expect(() =>
      host.proposePatch("org.chemdraft.readonly", {
        reason: "not-allowed",
        patch: {
          op: "addObject",
          pageId: "page_001",
          object: moleculeObject()
        }
      })
    ).toThrow(PluginPermissionError);
  });

  it("keeps plugin storage scoped and permission-gated", async () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.storage.a",
      name: "Storage A",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["plugin.storage"]
    });
    host.registerPlugin({
      id: "org.chemdraft.storage.b",
      name: "Storage B",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["plugin.storage"]
    });
    host.registerPlugin({
      id: "org.chemdraft.no.storage",
      name: "No Storage",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: []
    });

    await host.getStorage("org.chemdraft.storage.a").set("token", "a-only");
    await host.getStorage("org.chemdraft.storage.b").set("token", "b-only");

    await expect(host.getStorage("org.chemdraft.storage.a").get("token")).resolves.toBe("a-only");
    await expect(host.getStorage("org.chemdraft.storage.b").get("token")).resolves.toBe("b-only");
    await expect(host.getStorage("org.chemdraft.storage.a").listKeys()).resolves.toEqual(["token"]);
    expect(() => host.getStorage("org.chemdraft.no.storage")).toThrow(PluginPermissionError);
  });

  it("keeps contributed commands disabled until handlers are registered", async () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.chemdraft.disabled.command",
      name: "Disabled Command",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: {
        commands: [{ id: "plugin.disabled.command", title: "Disabled Command" }]
      }
    });

    expect(host.commands.get("plugin.disabled.command")).toMatchObject({ enabled: false });
    await expect(host.invokeCommand("plugin.disabled.command")).rejects.toThrow(CommandRegistryError);
  });
});

function minimalManifest(id: string): PluginManifest {
  return {
    id,
    name: `Plugin ${id}`,
    version: "0.0.1",
    apiVersion: "^0.1.0",
    entry: "dist/plugin.js",
    permissions: [],
    contributes: {
      commands: [],
      menus: [],
      panels: [],
      toolbarButtons: [],
      toolsets: [],
      inspectors: [],
      templates: [],
      importers: [],
      exporters: [],
      analyzers: [],
      transformers: [],
      recognizers: []
    }
  };
}

describe("PluginHost runtime enumeration, panels, and subscriptions", () => {
  it("rejects duplicate plugin registration", () => {
    const host = new PluginHost();
    host.registerPlugin(minimalManifest("org.test.dup"));
    expect(() => host.registerPlugin(minimalManifest("org.test.dup"))).toThrow(PluginHostError);
  });

  it("rejects core command ids at the manifest boundary without leaving a ghost plugin", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "document.save", title: "Save", source: "core" }, () => "core-save");
    const host = new PluginHost({ commandRegistry: registry });

    expect(() =>
      host.registerPlugin({
        id: "org.test.command-impersonation",
        name: "Command Impersonation",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "document.save", title: "Fake Save" }] }
      })
    ).toThrow(/Plugin command ids must use/);

    expect(host.getPlugin("org.test.command-impersonation")).toBeUndefined();
    await expect(registry.invoke("document.save")).resolves.toBe("core-save");
  });

  it("preflights shared-registry collisions before exposing plugin state", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "plugin.shared.run", title: "Existing", source: "core" }, () => "existing");
    const host = new PluginHost({ commandRegistry: registry });

    expect(() =>
      host.registerPlugin({
        id: "org.test.collision",
        name: "Collision",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "plugin.shared.run", title: "Colliding command" }] }
      })
    ).toThrow(CommandRegistryError);

    expect(host.getPlugin("org.test.collision")).toBeUndefined();
    expect(host.listPlugins()).toEqual([]);
    await expect(registry.invoke("plugin.shared.run")).resolves.toBe("existing");
  });

  it("rolls back only commands it registered when an unexpected registration failure occurs", () => {
    class FailingRegistry extends CommandRegistry {
      override register(definition: Parameters<CommandRegistry["register"]>[0], handler: Parameters<CommandRegistry["register"]>[1]): void {
        super.register(definition, handler);
        if (definition.id === "plugin.rollback.second") {
          throw new CommandRegistryError("synthetic registration failure");
        }
      }
    }

    const registry = new FailingRegistry();
    const host = new PluginHost({ commandRegistry: registry });
    expect(() =>
      host.registerPlugin({
        id: "org.test.rollback",
        name: "Rollback",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: {
          commands: [
            { id: "plugin.rollback.first", title: "First" },
            { id: "plugin.rollback.second", title: "Second" }
          ]
        }
      })
    ).toThrow("synthetic registration failure");

    expect(registry.has("plugin.rollback.first")).toBe(false);
    expect(registry.has("plugin.rollback.second")).toBe(false);
    expect(host.getPlugin("org.test.rollback")).toBeUndefined();
  });

  it("does not remove a command that is no longer owned by the plugin during unregister", async () => {
    const registry = new CommandRegistry();
    const host = new PluginHost({ commandRegistry: registry });
    host.registerPlugin({
      id: "org.test.ownership",
      name: "Ownership",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: [],
      contributes: { commands: [{ id: "plugin.ownership.run", title: "Run" }] }
    });

    registry.unregister("plugin.ownership.run");
    registry.register({ id: "plugin.ownership.run", title: "Replacement", source: "core" }, () => "replacement");
    host.unregisterPlugin("org.test.ownership");

    await expect(registry.invoke("plugin.ownership.run")).resolves.toBe("replacement");
  });

  it("notifies subscribers when plugins register and unregister, and stops after unsubscribe", () => {
    const host = new PluginHost();
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);

    host.registerPlugin(minimalManifest("org.test.sub.a"));
    host.unregisterPlugin("org.test.sub.a");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    host.registerPlugin(minimalManifest("org.test.sub.b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects a menu contribution that references a command the plugin does not contribute", () => {
    const host = new PluginHost();
    expect(() =>
      host.registerPlugin({
        id: "org.test.badmenu",
        name: "Bad Menu",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["ui.menu"],
        contributes: {
          commands: [{ id: "plugin.badMenu.run", title: "Run" }],
          menus: [
            {
              id: "menu.badMenu.open",
              title: "Open",
              commandId: "plugin.badMenu.missing",
              location: "analyze",
              requiredPermissions: ["ui.menu"]
            }
          ]
        }
      })
    ).toThrow(PluginHostError);
  });

  it("enumerates contributions with their plugin id and filters menus by location", () => {
    const host = new PluginHost();
    host.registerPlugin({
      id: "org.test.analyze",
      name: "Analyze Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: ["ui.menu", "ui.panel"],
      contributes: {
        commands: [{ id: "plugin.analyze.run", title: "Run" }],
        menus: [
          {
            id: "menu.analyze.run",
            title: "Analyze",
            commandId: "plugin.analyze.run",
            location: "analyze",
            requiredPermissions: ["ui.menu"]
          }
        ],
        panels: [{ id: "panel.analyze.main", title: "Main", commandId: "plugin.analyze.run" }],
        analyzers: [{ id: "analyzer.analyze.main", title: "Analysis", commandId: "plugin.analyze.run" }]
      }
    });

    expect(host.listMenuContributions("analyze").map((entry) => entry.pluginId)).toEqual(["org.test.analyze"]);
    expect(host.listMenuContributions("file")).toHaveLength(0);
    expect(host.listPanelContributions()[0]).toMatchObject({
      pluginId: "org.test.analyze",
      contribution: { id: "panel.analyze.main" }
    });
    expect(host.listAnalyzerContributions()[0]?.contribution.id).toBe("analyzer.analyze.main");
    expect(host.listCommandContributions()[0]?.contribution.id).toBe("plugin.analyze.run");
  });

  it("serves chemistry.compute only when the plugin declares it AND the host provides an engine", async () => {
    // Two independent conditions, and the failure mode differs: an undeclared permission is a plugin
    // error, an absent engine is a host without that capability. Neither may look like the other, and
    // neither may surface as a call that throws — the plugin has to be able to say which.
    const computeIsotopeEnvelope = vi.fn(async () => ({
      available: true as const,
      peaks: [{ mass: 78.04695, relativeIntensity: 100 }],
      positionUnit: "dalton" as const,
      truncation: { policy: "relative-intensity-threshold", threshold: 1e-4 },
      engine: { id: "isospec-wasm", version: "2.3.5" },
      conventions: ["natural abundances from IsoSpec's built-in tables"]
    }));

    const manifest = (id: string, permissions: PluginPermission[]) => ({
      id,
      name: "Chem Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions,
      contributes: {
        commands: [{ id: `plugin.${id.split(".").pop()}.probe`, title: "Probe" }]
      }
    });

    // 1. Declared + provided → the capability is there and reaches the engine.
    const granted = new PluginHost({ computeIsotopeEnvelope });
    let seen: unknown;
    granted.registerPlugin(manifest("org.test.chemyes", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.chemyes.probe": async (context) => {
          seen = await context.chemistry?.isotopeEnvelope({ format: "smiles", structure: "c1ccccc1" });
        }
      }
    });
    await granted.invokeCommand("plugin.chemyes.probe");
    expect(computeIsotopeEnvelope).toHaveBeenCalledWith({ format: "smiles", structure: "c1ccccc1" });
    expect(seen).toMatchObject({ available: true });

    // 2. Provided but not declared → no API at all, rather than a permission error at call time.
    const undeclared = new PluginHost({ computeIsotopeEnvelope });
    let undeclaredApi: unknown = "unset";
    undeclared.registerPlugin(manifest("org.test.chemno", []), {
      commandHandlers: {
        "plugin.chemno.probe": (context) => {
          undeclaredApi = context.chemistry;
        }
      }
    });
    await undeclared.invokeCommand("plugin.chemno.probe");
    expect(undeclaredApi).toBeUndefined();

    // 3. Declared but the host has no engine → the API is STILL there and answers `available: false`.
    //    Presence tracks the permission, not the engine, because a worker-routed plugin builds its stub
    //    from its own manifest and cannot see what the host wired up. Gating presence on the engine
    //    would make the in-process and worker paths disagree on the same host.
    const engineless = new PluginHost();
    let englessAnswer: unknown;
    engineless.registerPlugin(manifest("org.test.chemhostless", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.chemhostless.probe": async (context) => {
          expect(context.chemistry).toBeDefined();
          englessAnswer = await context.chemistry?.isotopeEnvelope({ format: "smiles", structure: "CCO" });
        }
      }
    });
    await engineless.invokeCommand("plugin.chemhostless.probe");
    expect(englessAnswer).toEqual({ available: false, reason: "This host provides no isotope engine." });
  });

  it("serves name-to-structure only to a plugin that also declared native.execute", async () => {
    // NOT on `chemistry.compute` alone. The desktop implements this by spawning the bundled JVM
    // (`Command::new(java).arg("-jar")`), so gating it on the ordinary permission handed a subprocess
    // to every plugin holding it — §7 lists `native.execute` as Dangerous and §16 forbids running
    // native code unless granted. Presence tracks the permissions the method actually needs, and the
    // engine's availability is still carried in the answer rather than in whether the method exists.
    const convertNameToStructure = vi.fn(async () => ({
      available: true as const,
      parsed: true as const,
      smiles: "C1=CC=CC=C1",
      engine: { id: "opsin", version: "2.9.0" }
    }));

    const manifest = (id: string, permissions: PluginPermission[]) => ({
      id,
      name: "Name Plugin",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions,
      contributes: { commands: [{ id: `plugin.${id.split(".").pop()}.probe`, title: "Probe" }] }
    });

    const granted = new PluginHost({ convertNameToStructure });
    let seen: unknown;
    granted.registerPlugin(manifest("org.test.nameyes", ["chemistry.compute", "native.execute"]), {
      commandHandlers: {
        "plugin.nameyes.probe": async (context) => {
          seen = await context.chemistry?.nameToStructure?.({ name: "benzene" });
        }
      }
    });
    await granted.invokeCommand("plugin.nameyes.probe");
    expect(convertNameToStructure).toHaveBeenCalledWith({ name: "benzene" });
    expect(seen).toMatchObject({ available: true, parsed: true, smiles: "C1=CC=CC=C1" });

    // No engine → still present, still answers, and says the host has none rather than throwing.
    const engineless = new PluginHost();
    let englessAnswer: unknown;
    engineless.registerPlugin(manifest("org.test.namehostless", ["chemistry.compute", "native.execute"]), {
      commandHandlers: {
        "plugin.namehostless.probe": async (context) => {
          expect(context.chemistry?.nameToStructure).toBeDefined();
          englessAnswer = await context.chemistry?.nameToStructure?.({ name: "benzene" });
        }
      }
    });
    await engineless.invokeCommand("plugin.namehostless.probe");
    expect(englessAnswer).toEqual({
      available: false,
      reason: "This host provides no name-to-structure engine."
    });

    // And the denial: `chemistry.compute` alone gets the rest of the chemistry API and NOT this. The
    // method is absent rather than present-and-throwing, so a plugin can feature-detect it the same
    // way it detects a host that predates the method.
    const withoutNative = new PluginHost({ convertNameToStructure });
    let sawMethod: unknown = "unset";
    withoutNative.registerPlugin(manifest("org.test.namenonative", ["chemistry.compute"]), {
      commandHandlers: {
        "plugin.namenonative.probe": (context) => {
          sawMethod = context.chemistry?.nameToStructure;
          expect(context.chemistry?.isotopeEnvelope).toBeDefined();
          return { ok: true as const };
        }
      }
    });
    await withoutNative.invokeCommand("plugin.namenonative.probe");
    expect(sawMethod).toBeUndefined();
    expect(convertNameToStructure).toHaveBeenCalledTimes(1);
  });

  it("hands a plugin a laid-out object but never inserts it", async () => {
    // The division that makes this capability safe: the host does the 2D layout a plugin cannot do,
    // and the plugin still has to go through proposePatch to get it into the document. If this method
    // inserted, it would be a write path that bypasses the review queue.
    const object = { id: "mol_plugin_1", type: "molecule", x: 0, y: 0 };
    const buildStructureFromSmiles = vi.fn(async () => ({
      available: true as const,
      built: true as const,
      object: object as never
    }));
    const host = new PluginHost({ buildStructureFromSmiles });
    let seen: unknown;
    host.registerPlugin(
      {
        id: "org.test.layout",
        name: "Layout Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.2",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute", "document.read"],
        contributes: { commands: [{ id: "plugin.layout.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.layout.probe": async (context) => {
            seen = await context.chemistry?.structureFromSmiles?.({ smiles: "c1ccccc1", origin: "Test" });
          }
        }
      }
    );
    await host.invokeCommand("plugin.layout.probe");

    expect(buildStructureFromSmiles).toHaveBeenCalledWith({ smiles: "c1ccccc1", origin: "Test" });
    expect(seen).toMatchObject({ available: true, built: true, object });
    // Nothing reached the patch queue: building is not proposing.
    expect(host.listProposedPatches()).toHaveLength(0);
  });

  it("says the host has no layout engine rather than throwing", async () => {
    const host = new PluginHost();
    let answer: unknown;
    host.registerPlugin(
      {
        id: "org.test.nolayout",
        name: "Layout Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.2",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute", "document.read"],
        contributes: { commands: [{ id: "plugin.nolayout.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.nolayout.probe": async (context) => {
            answer = await context.chemistry?.structureFromSmiles?.({ smiles: "c1ccccc1" });
          }
        }
      }
    );
    await host.invokeCommand("plugin.nolayout.probe");
    expect(answer).toEqual({ available: false, reason: "This host provides no 2D layout engine." });
  });

  it("rejects an empty name at the boundary rather than passing it to an engine", async () => {
    // The schema is the gate, as it is for the envelope request. An engine asked to parse "" answers
    // something unhelpful; refusing here keeps the failure at the boundary that can explain it.
    const convertNameToStructure = vi.fn();
    const host = new PluginHost({ convertNameToStructure });
    let thrown: unknown;
    host.registerPlugin(
      {
        id: "org.test.nameempty",
        name: "Name Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["chemistry.compute", "native.execute"],
        contributes: { commands: [{ id: "plugin.nameempty.probe", title: "Probe" }] }
      },
      {
        commandHandlers: {
          "plugin.nameempty.probe": async (context) => {
            try {
              await context.chemistry?.nameToStructure?.({ name: "" });
            } catch (error) {
              thrown = error;
            }
          }
        }
      }
    );
    await host.invokeCommand("plugin.nameempty.probe");
    expect(thrown).toBeDefined();
    expect(convertNameToStructure).not.toHaveBeenCalled();
  });

  it("routes a schema-validated panel report through showPanelReport for declared panels only", async () => {
    const showPanelReport = vi.fn();
    const host = new PluginHost({ showPanelReport });
    host.registerPlugin(
      {
        id: "org.test.panel",
        name: "Panel Plugin",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: {
          commands: [
            { id: "plugin.panel.show", title: "Show", requiredPermissions: ["ui.panel"] },
            { id: "plugin.panel.showUndeclared", title: "Show Undeclared", requiredPermissions: ["ui.panel"] }
          ],
          panels: [{ id: "panel.panel.main", title: "Main", commandId: "plugin.panel.show" }]
        }
      },
      {
        commandHandlers: {
          "plugin.panel.show": async (context) => {
            const report: PluginPanelReport = {
              title: "Result",
              sections: [{ kind: "text", body: "hello" }]
            };
            await context.panels?.showReport("panel.panel.main", report);
          },
          "plugin.panel.showUndeclared": async (context) => {
            await context.panels?.showReport("panel.panel.undeclared", {
              title: "Nope",
              sections: []
            });
          }
        }
      }
    );

    await host.invokeCommand("plugin.panel.show");
    expect(showPanelReport).toHaveBeenCalledTimes(1);
    expect(showPanelReport).toHaveBeenCalledWith(
      "org.test.panel",
      "panel.panel.main",
      expect.objectContaining({ title: "Result" })
    );

    await expect(host.invokeCommand("plugin.panel.showUndeclared")).rejects.toThrow(PluginHostError);
    expect(showPanelReport).toHaveBeenCalledTimes(1);
  });
});

describe("validateTrustedPluginManifest", () => {
  it("returns a parsed manifest with contribution defaults", () => {
    const manifest = validateTrustedPluginManifest({
      id: "org.chemdraft.demo",
      name: "Demo Plugin",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"]
    });

    expect(manifest.id).toBe("org.chemdraft.demo");
    expect(manifest.contributes.commands).toEqual([]);
  });
});

describe("PluginHost onPanelClosed hook", () => {
  it("invokes the plugin's onPanelClosed and drops it on unregister (ADR-0012)", () => {
    const host = new PluginHost();
    const closed: string[] = [];
    host.registerPlugin(minimalManifest("org.test.panelclose"), {
      onPanelClosed: (panelId) => closed.push(panelId)
    });

    host.notifyPanelClosed("org.test.panelclose", "panel.test.review");
    expect(closed).toEqual(["panel.test.review"]);

    host.notifyPanelClosed("org.unknown", "panel.test.review"); // unknown plugin → no-op

    host.unregisterPlugin("org.test.panelclose");
    host.notifyPanelClosed("org.test.panelclose", "panel.test.review"); // handler removed → no-op
    expect(closed).toEqual(["panel.test.review"]);
  });
});

describe("PluginHost document boundary", () => {
  it("hands in-process plugins a frozen copy of the active document, never the live one", async () => {
    // The selection API deep-copies and freezes with the comment "never a live document reference".
    // getActiveDocument returned the provider's value untouched ten lines later, so an in-process
    // plugin -- a supported path; the MolScribe canary deliberately stays in-process -- could mutate
    // the host's own document object directly, bypassing the propose/review channel entirely.
    const live = createEmptyDocument({ now: timestamp });
    live.pages[0].objects.push(moleculeObject());

    const host = new PluginHost({ now: () => timestamp, getActiveDocument: () => live });
    host.registerPlugin({
      id: "org.test.docread",
      name: "Doc Reader",
      version: "0.0.1",
      apiVersion: "^1.0.0",
      entry: "dist/plugin.js",
      permissions: ["document.read"],
      contributes: { commands: [] }
    });

    const context = host.createCommandContext("org.test.docread");
    const handed = await context.documents.getActiveDocument();

    expect(handed).not.toBe(live);
    expect(handed).toEqual(live);
    expect(Object.isFrozen(handed)).toBe(true);
    expect(Object.isFrozen(handed?.pages[0].objects[0])).toBe(true);
    expect(() => {
      (handed as { title: string }).title = "hijacked";
    }).toThrow();
    expect(live.title).not.toBe("hijacked");
  });
});

describe("PluginHost recognition, document binding, and queue release", () => {
  const recognitionPermissions: PluginPermission[] = ["image.read", "ml.inference", "model.load", "native.execute"];
  const image: PluginProvidedImage = {
    mediaType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    width: 20,
    height: 10,
    source: "file"
  };
  // What the desktop builds: an insertion laid out against the active document.
  const documentDerivedPatch = { op: "addObject", pageId: "page_secret", object: moleculeObject("mol_ocsr_042") };
  const recognized = {
    status: "recognized" as const,
    result: {
      sourceImageRef: "data:image/png;base64,AQID",
      proposedSmiles: "c1ccccc1",
      proposedMolfile: "benzene\n\n\n  0  0  0  0  0  0            999 V2000\nM  END",
      confidence: 0.9,
      proposedPatch: {
        patch: documentDerivedPatch,
        reason: "Insert the locally recognized structure after review.",
        requiresUserApproval: true as const
      }
    }
  };

  function recognitionHost(options: ConstructorParameters<typeof PluginHost>[0] = {}) {
    const applyDocumentPatch = vi.fn(async () => ({ applied: true as const, objectIds: ["mol_001"] }));
    const host = new PluginHost({
      now: () => timestamp,
      createId: () => "fixed",
      requestImage: async () => ({ status: "provided", image }),
      recognizeStructure: async () => recognized as never,
      applyDocumentPatch,
      ...options
    });
    return { host, applyDocumentPatch };
  }

  function register(
    host: PluginHost,
    permissions: PluginPermission[],
    handlers: Record<string, (context: PluginCommandContext) => unknown>
  ) {
    host.registerPlugin(
      {
        id: "org.test.recognizer",
        name: "Recognizer",
        version: "0.0.1",
        apiVersion: "^0.1.6",
        entry: "dist/plugin.js",
        permissions,
        contributes: { commands: Object.keys(handlers).map((id) => ({ id, title: id })) }
      },
      { commandHandlers: handlers as never }
    );
  }

  async function recognize(context: PluginCommandContext) {
    const acquired = await context.images!.requestImage({ title: "Choose image" });
    if (acquired.status !== "provided") throw new Error("fixture image missing");
    const result = await context.recognition!.recognizeStructure(acquired.image);
    if (result.status !== "recognized") throw new Error("fixture recognition missing");
    return result;
  }

  it("refuses to register a recognizer that also declares document.write or model.download", () => {
    const { host } = recognitionHost();
    const handlers = { "plugin.recognizer.run": () => undefined };
    expect(() => register(host, [...recognitionPermissions, "document.proposePatch", "document.write"], handlers)).toThrow(
      new PluginPermissionError(
        'Plugin "org.test.recognizer" declares the structure-recognition permissions (image.read, ml.inference, model.load, native.execute) together with "document.write", which a recognizer may not declare: recognized structures are proposal-only and the host alone installs the engine. Remove that permission, or move deterministic direct writes into a separate plugin.'
      )
    );
    expect(() => register(host, [...recognitionPermissions, "model.download", "document.write"], handlers)).toThrow(
      /together with "document\.write" and "model\.download".*Remove those permissions/
    );
    expect(() => register(host, [...recognitionPermissions, "model.download"], handlers)).toThrow(
      /together with "model\.download"/
    );
    // Refused before any state changed: no plugin, no command.
    expect(host.getPlugin("org.test.recognizer")).toBeUndefined();
    expect(host.commands.has("plugin.recognizer.run")).toBe(false);
    // The same check guards every caller of the shared manifest validation.
    expect(() =>
      validateTrustedPluginManifest({ ...minimalManifest("org.test.v"), permissions: [...recognitionPermissions, "document.write"] })
    ).toThrow(PluginPermissionError);
    // Holding only some of the recognition permissions is not a recognizer.
    expect(() =>
      validateTrustedPluginManifest({ ...minimalManifest("org.test.w"), permissions: ["image.read", "native.execute", "document.write"] })
    ).not.toThrow();
  });

  it("registers the official MolScribe plugin's permission set", () => {
    const { host } = recognitionHost();
    expect(() =>
      host.registerPlugin({
        id: "org.chemdraft.ocsr.molscribe",
        name: "MolScribe OCSR",
        version: "0.1.0",
        apiVersion: "^0.1.6",
        entry: "dist/plugin.js",
        permissions: [...recognitionPermissions, "document.proposePatch", "ui.menu", "ui.panel"]
      })
    ).not.toThrow();
    expect(host.getPlugin("org.chemdraft.ocsr.molscribe")).toBeDefined();
  });

  it("refuses a patch carrying a recognition review block, but lets another command write directly", async () => {
    const { host, applyDocumentPatch } = recognitionHost();
    const patch = { op: "addObject", pageId: "page_001", object: moleculeObject() } as const;
    register(host, ["document.write"], {
      "plugin.recognizer.smuggle": (context) =>
        context.documents.applyPatch!({
          reason: "recognized",
          patch,
          recognition: {
            sourceImageRef: "data:image/png;base64,AQID",
            proposedMolfile: "M  END",
            confidenceTier: "high"
          }
        }),
      // The rule is per invocation: the same plugin may still write deterministic input elsewhere.
      "plugin.recognizer.fromName": (context) => context.documents.applyPatch!({ reason: "typed name", patch })
    });

    await expect(host.invokeCommand("plugin.recognizer.smuggle")).rejects.toThrow(
      /passed a recognition proposal to documents\.applyPatch/
    );
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    await expect(host.invokeCommand("plugin.recognizer.fromName")).resolves.toEqual({
      applied: true,
      objectIds: ["mol_001"]
    });
  });

  it("withholds the document-derived insertion from a plugin without document.read and resolves it on proposal", async () => {
    const { host } = recognitionHost();
    let handed: unknown;
    let receipt: unknown;
    register(host, [...recognitionPermissions, "document.proposePatch"], {
      "plugin.recognizer.run": async (context) => {
        const result = await recognize(context);
        handed = result.result.proposedPatch;
        receipt = await context.documents.proposePatch({ ...result.result.proposedPatch!, reason: "Review me" });
        // Single use: the same insertion cannot be queued twice.
        await expect(
          context.documents.proposePatch({ ...result.result.proposedPatch!, reason: "Again" })
        ).rejects.toThrow(/only once, during the command invocation that recognized it/);
        // Its refusal on applyPatch is covered above; a forged ref never resolves either.
        await expect(
          context.documents.proposePatch({
            reason: "forged",
            patch: { op: "hostHeldRecognition", ref: "recognition_guess" } as never
          })
        ).rejects.toThrow(/only once, during the command invocation that recognized it/);
      }
    });

    await host.invokeCommand("plugin.recognizer.run");
    expect(JSON.stringify(handed)).not.toMatch(/page_secret|mol_ocsr_042/);
    expect(handed).toMatchObject({ patch: { op: "hostHeldRecognition", ref: "recognition_fixed" } });
    expect(JSON.stringify(receipt)).not.toMatch(/page_secret|mol_ocsr_042/);
    expect(receipt).toEqual({
      id: "proposal_1",
      pluginId: "org.test.recognizer",
      status: "pending",
      createdAt: timestamp
    });
    const [queued] = host.listProposedPatches("pending");
    // The reason is the host's: a plugin's text could claim a confidence the review does not show.
    expect(queued.proposal).toMatchObject({
      reason: "Insert the locally recognized structure after review.",
      patch: documentDerivedPatch
    });
  });

  it("keeps a recognized screen capture for the app until the proposal is accepted, and never a chosen file", async () => {
    const capture: PluginProvidedImage = { ...image, source: "screenRegion" };
    const review = { sourceImageRef: "data:image/png;base64,AQID", proposedMolfile: "M  END", confidenceTier: "high" as const };
    const proposeAll = async (context: PluginCommandContext) => {
      const result = await recognize(context);
      await context.documents.proposePatch({ ...result.result.proposedPatch!, recognition: review });
    };

    // Host-held insertion (no document.read): the source is found through the opaque ref.
    const held = recognitionHost({ requestImage: async () => ({ status: "provided", image: capture }) });
    register(held.host, [...recognitionPermissions, "document.proposePatch"], { "plugin.recognizer.run": proposeAll });
    await held.host.invokeCommand("plugin.recognizer.run");
    const [heldProposal] = held.host.listProposedPatches("pending");
    const kept = held.host.recognitionScreenCaptureOf(heldProposal!.id);
    expect(kept).toMatchObject({ source: "screenRegion", mediaType: "image/png", width: 20, height: 10 });
    expect(Array.from(kept!.bytes)).toEqual([1, 2, 3]);
    held.host.acceptProposedPatch(heldProposal!.id, createEmptyDocument({ now: timestamp }), {
      apply: (document) => document
    });
    // Accepting drops the host's copy: the app must have read it first.
    expect(held.host.recognitionScreenCaptureOf(heldProposal!.id)).toBeUndefined();

    // Real patch (document.read): the source is the recognized image whose bytes the preview carries.
    const direct = recognitionHost({ requestImage: async () => ({ status: "provided", image: capture }) });
    register(direct.host, [...recognitionPermissions, "document.read", "document.proposePatch"], {
      "plugin.recognizer.run": proposeAll
    });
    await direct.host.invokeCommand("plugin.recognizer.run");
    const [directProposal] = direct.host.listProposedPatches("pending");
    expect(direct.host.recognitionScreenCaptureOf(directProposal!.id)?.source).toBe("screenRegion");
    direct.host.rejectProposedPatch(directProposal!.id);
    expect(direct.host.recognitionScreenCaptureOf(directProposal!.id)).toBeUndefined();

    // A preview that is not the recognized image is not tied to it.
    const forged = recognitionHost({ requestImage: async () => ({ status: "provided", image: capture }) });
    register(forged.host, [...recognitionPermissions, "document.read", "document.proposePatch"], {
      "plugin.recognizer.run": async (context) => {
        const result = await recognize(context);
        await context.documents.proposePatch({
          ...result.result.proposedPatch!,
          recognition: { ...review, sourceImageRef: "data:image/png;base64,BAUG" }
        });
      }
    });
    await forged.host.invokeCommand("plugin.recognizer.run");
    expect(forged.host.recognitionScreenCaptureOf(forged.host.listProposedPatches("pending")[0]!.id)).toBeUndefined();

    // A user-chosen file is still on disk; the host keeps no copy of it.
    const file = recognitionHost();
    register(file.host, [...recognitionPermissions, "document.proposePatch"], { "plugin.recognizer.run": proposeAll });
    await file.host.invokeCommand("plugin.recognizer.run");
    expect(file.host.recognitionScreenCaptureOf(file.host.listProposedPatches("pending")[0]!.id)).toBeUndefined();
  });

  it("lets the user accept a held recognition proposal that the plugin itself may never apply", async () => {
    // The document key has moved on since the command ran, as it does after any New/Open: acceptance is
    // the user's own action on the document in front of them and must not be refused for it.
    let activeKey = "document-a";
    const { host, applyDocumentPatch } = recognitionHost({ getActiveDocumentKey: () => activeKey });
    register(host, [...recognitionPermissions, "document.proposePatch"], {
      "plugin.recognizer.run": async (context) => {
        const result = await recognize(context);
        expect(context.documents.applyPatch).toBeUndefined();
        await context.documents.proposePatch({
          ...result.result.proposedPatch!,
          recognition: {
            sourceImageRef: result.result.sourceImageRef,
            proposedMolfile: result.result.proposedMolfile!,
            confidenceTier: "medium"
          }
        });
      }
    });
    await host.invokeCommand("plugin.recognizer.run");
    expect(applyDocumentPatch).not.toHaveBeenCalled();
    activeKey = "document-b";

    const [queued] = host.listProposedPatches("pending");
    const document = createEmptyDocument({ now: timestamp });
    document.pages[0]!.id = "page_secret";
    const apply = vi.fn((current: typeof document, proposal: typeof queued.proposal) =>
      applyPatch(current, proposal.patch, { now: timestamp })
    );
    const updated = host.acceptProposedPatch(queued.id, document, { now: timestamp, apply });

    expect(apply).toHaveBeenCalledWith(document, expect.objectContaining({ patch: documentDerivedPatch }), {
      now: timestamp
    });
    expect(updated.pages[0]!.objects.map((object) => object.id)).toEqual(["mol_ocsr_042"]);
    expect(host.listProposedPatches("pending")).toEqual([]);
  });

  it("keeps a proposal pending when accepting it fails, so the user can see why and retry or reject", async () => {
    const { host } = recognitionHost();
    register(host, [...recognitionPermissions, "document.proposePatch"], {
      "plugin.recognizer.run": async (context) => {
        await context.documents.proposePatch((await recognize(context)).result.proposedPatch!);
      }
    });
    await host.invokeCommand("plugin.recognizer.run");
    const [queued] = host.listProposedPatches("pending");

    // The empty document has no `page_secret`, so the insertion cannot land.
    expect(() => host.acceptProposedPatch(queued.id, createEmptyDocument({ now: timestamp }))).toThrow(
      /page "page_secret" does not exist/
    );
    expect(host.listProposedPatches("pending").map((proposal) => proposal.id)).toEqual([queued.id]);
  });

  describe("the review shows the host's record of the recognition, not the plugin's account of it", () => {
    const hostWarnings = [
      { code: "recognition.scale-disagreement", message: "Only 3 of 15 readings agreed." },
      { code: "import.radicals_not_drawn", message: "Radicals are not drawn." }
    ];
    const splitVote = {
      ...recognized,
      result: {
        ...recognized.result,
        warnings: hostWarnings,
        proposedPatch: { ...recognized.result.proposedPatch, warnings: hostWarnings }
      },
      hostReview: { confidenceTier: "low" as const }
    };
    const hostPreview = "data:image/png;base64,AQID"; // the recognized bytes [1, 2, 3]

    function splitVoteHost() {
      return recognitionHost({ recognizeStructure: async () => splitVote as never });
    }

    /** The plugin's own review, overstating everything it can. */
    const overstated = (result: Awaited<ReturnType<typeof recognize>>) => ({
      ...result.result.proposedPatch!,
      reason: "Insert the locally recognized structure (high confidence) after review.",
      warnings: [],
      recognition: {
        sourceImageRef: "data:image/png;base64,BAUG",
        proposedSmiles: "CCO",
        proposedMolfile: `  ${recognized.result.proposedMolfile.replace(/\n/g, "\r\n")}  \n`,
        confidenceTier: "high" as const
      }
    });

    it.each([
      ["a host-held insertion", [] as PluginPermission[]],
      ["a plugin holding document.read", ["document.read"] as PluginPermission[]]
    ])("keeps host warnings, tier, image, SMILES and molfile for %s", async (_label, extra) => {
      const { host } = splitVoteHost();
      let handed: unknown;
      register(host, [...recognitionPermissions, "document.proposePatch", ...extra], {
        "plugin.recognizer.run": async (context) => {
          const result = await recognize(context);
          handed = result;
          await context.documents.proposePatch({
            ...overstated(result),
            warnings: [{ code: "recognition.stereochemistry-uncertain", message: "Check stereo." }]
          });
        }
      });
      await host.invokeCommand("plugin.recognizer.run");

      // The host's review facts never reach the plugin.
      expect(JSON.stringify(handed)).not.toContain("hostReview");
      const [queued] = host.listProposedPatches("pending");
      expect(queued!.proposal.reason).toBe("Insert the locally recognized structure after review.");
      // Host warnings first and always; a plugin may add its own after them.
      expect(queued!.proposal.warnings).toEqual([
        ...hostWarnings,
        { code: "recognition.stereochemistry-uncertain", message: "Check stereo." }
      ]);
      expect(queued!.proposal.recognition).toEqual({
        sourceImageRef: hostPreview,
        proposedSmiles: "c1ccccc1",
        proposedMolfile: recognized.result.proposedMolfile,
        confidenceTier: "low"
      });
    });

    it("shows host warnings when the plugin passes warnings: [] and no review block at all", async () => {
      const { host } = splitVoteHost();
      register(host, [...recognitionPermissions, "document.proposePatch"], {
        "plugin.recognizer.run": async (context) => {
          const result = await recognize(context);
          await context.documents.proposePatch({ ...result.result.proposedPatch!, warnings: [] });
        }
      });
      await host.invokeCommand("plugin.recognizer.run");
      const [queued] = host.listProposedPatches("pending");
      expect(queued!.proposal.warnings).toEqual(hostWarnings);
      expect(queued!.proposal.recognition).toMatchObject({ confidenceTier: "low", sourceImageRef: hostPreview });
    });

    it("attaches the record to a document.read plugin's own copy of the insertion, block or not", async () => {
      const { host } = splitVoteHost();
      register(host, [...recognitionPermissions, "document.read", "document.proposePatch"], {
        "plugin.recognizer.run": async (context) => {
          const result = await recognize(context);
          await context.documents.proposePatch({ reason: "mine", patch: result.result.proposedPatch!.patch, warnings: [] });
        }
      });
      await host.invokeCommand("plugin.recognizer.run");
      const [queued] = host.listProposedPatches("pending");
      expect(queued!.proposal.warnings).toEqual(hostWarnings);
      expect(queued!.proposal.recognition?.confidenceTier).toBe("low");
    });

    it("takes the tier from the engine score when the embedding host supplies none", async () => {
      const { host } = recognitionHost();
      register(host, [...recognitionPermissions, "document.proposePatch"], {
        "plugin.recognizer.run": async (context) => {
          const result = await recognize(context);
          await context.documents.proposePatch({
            ...overstated(result),
            recognition: { ...overstated(result).recognition, confidenceTier: "missing" }
          });
        }
      });
      await host.invokeCommand("plugin.recognizer.run");
      // 0.9 is at or above the 0.85 cut point.
      expect(host.listProposedPatches("pending")[0]!.proposal.recognition?.confidenceTier).toBe("high");
    });

    it("refuses a review block no recognition of this invocation produced", async () => {
      const { host } = recognitionHost();
      const block = { sourceImageRef: hostPreview, proposedMolfile: "M  END", confidenceTier: "high" as const };
      register(host, ["document.proposePatch"], {
        "plugin.recognizer.claim": (context) =>
          context.documents.proposePatch({
            reason: "recognized, honestly",
            patch: { op: "addObject", pageId: "page_001", object: moleculeObject() },
            recognition: block
          })
      });
      await expect(host.invokeCommand("plugin.recognizer.claim")).rejects.toThrow(
        'Plugin "org.test.recognizer" attached a recognition review block to a proposal that no structure recognition in this command invocation produced; only the host may describe a recognition for review, so the proposal was refused.'
      );
      expect(() =>
        host.proposePatch("org.test.recognizer", {
          reason: "outside any command",
          patch: { op: "addObject", pageId: "page_001", object: moleculeObject() },
          recognition: block
        })
      ).toThrow(/no structure recognition in this command invocation produced/);
      expect(host.listProposedPatches()).toEqual([]);
    });
  });

  it("hands a plugin holding document.read the insertion itself", async () => {
    const { host } = recognitionHost();
    let handed: unknown;
    register(host, [...recognitionPermissions, "document.read"], {
      "plugin.recognizer.run": async (context) => {
        handed = (await recognize(context)).result.proposedPatch;
      }
    });
    await host.invokeCommand("plugin.recognizer.run");
    expect(handed).toMatchObject({ patch: documentDerivedPatch });
  });

  it("binds documents.applyPatch to the document the command was invoked on", async () => {
    let activeKey = "document-a";
    let switchDocument = false;
    const { host, applyDocumentPatch } = recognitionHost({ getActiveDocumentKey: () => activeKey });
    register(host, ["document.write"], {
      "plugin.recognizer.write": async (context) => {
        if (switchDocument) activeKey = "document-b"; // File > New/Open while the plugin runs
        return context.documents.applyPatch!({
          reason: "typed name",
          patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
        });
      }
    });

    await expect(host.invokeCommand("plugin.recognizer.write")).resolves.toMatchObject({ applied: true });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);

    switchDocument = true;
    await expect(host.invokeCommand("plugin.recognizer.write")).rejects.toThrow(
      "The document changed while the plugin was running; nothing was inserted."
    );
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
  });

  it("releases accepted and rejected proposals from the queue", () => {
    const host = new PluginHost({ now: () => timestamp });
    host.registerPlugin({ ...minimalManifest("org.test.release"), permissions: ["document.proposePatch"] });
    const queueSize = () => (host as unknown as { proposedPatches: Map<string, unknown> }).proposedPatches.size;
    const propose = () =>
      host.proposePatch("org.test.release", {
        reason: "recognized",
        patch: { op: "addObject", pageId: "page_001", object: moleculeObject(`mol_${queueSize()}`) }
      });

    const accepted = propose();
    const rejected = propose();
    const pending = propose();
    expect(queueSize()).toBe(3);

    host.acceptProposedPatch(accepted.id, createEmptyDocument({ now: timestamp }), { now: timestamp });
    expect(host.rejectProposedPatch(rejected.id).status).toBe("rejected");
    expect(queueSize()).toBe(1);
    expect(host.listProposedPatches().map((entry) => entry.id)).toEqual([pending.id]);

    // Pending review survives an unregister (update/disable), so the user can still resolve it.
    host.unregisterPlugin("org.test.release");
    expect(queueSize()).toBe(1);
    host.rejectProposedPatch(pending.id);
    expect(queueSize()).toBe(0);
  });

  it("exposes dialogs whenever ui.panel is declared and rejects the call when the host has no prompt UI", async () => {
    const host = new PluginHost();
    let dialogs: PluginCommandContext["dialogs"];
    host.registerPlugin(
      {
        id: "org.test.noprompt",
        name: "No Prompt",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.noPrompt.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.noPrompt.run": (context) => {
            dialogs = context.dialogs;
            return context.dialogs!.promptText({ title: "Name", label: "Name" });
          }
        }
      }
    );

    await expect(host.invokeCommand("plugin.noPrompt.run")).rejects.toThrow(/provides no text-prompt UI/);
    expect(dialogs).toBeDefined();
  });
});
