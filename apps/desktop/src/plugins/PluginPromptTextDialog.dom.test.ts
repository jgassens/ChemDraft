// @vitest-environment jsdom

import type { PluginManifest, PluginPromptTextResult } from "@chemdraft/plugin-api";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntime } from "./createPluginRuntime";
import { PluginPromptTextDialog, isPluginPromptKeyboardEvent } from "./PluginPromptTextDialog";
import { PluginPromptTextController, type OpenPluginTextPrompt } from "./PluginPromptTextController";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";

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

const prompt: OpenPluginTextPrompt = {
  id: 1,
  pluginId: "org.test.opsin",
  pluginName: "OPSIN Name to Structure",
  request: {
    title: "Insert from chemical name",
    label: "Chemical name",
    placeholder: "e.g. 2-acetyloxybenzoic acid",
    submitLabel: "Convert",
    maxLength: 500
  }
};

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PluginPromptTextDialog", () => {
  it("names the plugin, disables empty submission, submits exact text on Enter, and restores focus", () => {
    const prior = document.createElement("button");
    prior.textContent = "Before";
    document.body.appendChild(prior);
    prior.focus();
    const onSubmit = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(PluginPromptTextDialog, {
            prompt,
            onSubmit: (_promptId, value) => {
              onSubmit(value);
              setOpen(false);
            },
            onCancel: () => setOpen(false)
          })
        : null;
    }

    mount(createElement(Harness));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = document.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Convert"
    )!;

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Insert from chemical name"
    );
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Requested by OPSIN Name to Structure (org.test.opsin)"
    );
    expect(document.activeElement).toBe(input);
    expect(submit.disabled).toBe(true);

    act(() => setInputValue(input, "  benzene  "));
    expect(submit.disabled).toBe(false);
    // Browsers use the form's native submission path when Enter is pressed in this one-line input.
    act(() => (dialog as HTMLFormElement).requestSubmit());

    expect(onSubmit).toHaveBeenCalledWith("  benzene  ");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(prior);
  });

  it("cancels on Escape and restores focus", () => {
    const prior = document.createElement("button");
    document.body.appendChild(prior);
    prior.focus();
    const onCancel = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      return open
        ? createElement(PluginPromptTextDialog, {
            prompt,
            onSubmit: vi.fn(),
            onCancel: () => {
              onCancel();
              setOpen(false);
            }
          })
        : null;
    }

    const appShortcutHandler = vi.fn();
    const windowKeyDown = (event: KeyboardEvent) => {
      if (!isPluginPromptKeyboardEvent(event)) {
        appShortcutHandler();
      }
    };
    window.addEventListener("keydown", windowKeyDown, { capture: true });
    try {
      mount(createElement(Harness));
      const input = document.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
      act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

      expect(onCancel).toHaveBeenCalledOnce();
      expect(appShortcutHandler).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(prior);
    } finally {
      window.removeEventListener("keydown", windowKeyDown, { capture: true });
    }
  });

  it("ignores Escape aimed at another plugin dialog open at the same time", () => {
    const onCancel = vi.fn();
    mount(createElement(PluginPromptTextDialog, { prompt, onSubmit: vi.fn(), onCancel }));
    // Stands in for the image-request dialog, which also carries .plugin-prompt-dialog.
    const other = document.createElement("div");
    other.className = "plugin-prompt-dialog plugin-image-dialog";
    const otherButton = document.createElement("button");
    other.appendChild(otherButton);
    document.body.appendChild(other);

    act(() => otherButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).not.toHaveBeenCalled();

    const input = document.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it("cycles focus from the last control to the first and from the first to the last", () => {
    mount(createElement(PluginPromptTextDialog, { prompt, onSubmit: vi.fn(), onCancel: vi.fn() }));
    const input = document.querySelector<HTMLInputElement>(".plugin-prompt-body input")!;
    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.type === "submit"
    )!;

    act(() => setInputValue(input, "benzene"));
    submit.focus();
    act(() => submit.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(input);

    input.focus();
    act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
    );
    expect(document.activeElement).toBe(submit);
  });
});

describe("PluginPromptTextController", () => {
  it("settles queued prompts by id and ignores stale submit/cancel events", async () => {
    const controller = new PluginPromptTextController();
    const first = controller.promptText(
      { id: "org.test.first", name: "First" },
      { title: "First", label: "Value", maxLength: 20 },
      new AbortController().signal
    );
    const firstId = controller.getOpenPrompt()!.id;
    const second = controller.promptText(
      { id: "org.test.second", name: "Second" },
      { title: "Second", label: "Value", maxLength: 20 },
      new AbortController().signal
    );

    controller.submit(firstId, "first answer");
    await expect(first).resolves.toEqual({ status: "submitted", value: "first answer" });
    const secondId = controller.getOpenPrompt()!.id;
    expect(controller.getOpenPrompt()?.pluginId).toBe("org.test.second");

    controller.submit(firstId, "stale answer");
    controller.cancel(firstId);
    expect(controller.getOpenPrompt()?.id).toBe(secondId);

    controller.submit(secondId, "second answer");
    await expect(second).resolves.toEqual({ status: "submitted", value: "second answer" });
    expect(controller.getOpenPrompt()).toBeUndefined();
  });
});

describe("plugin prompt lifecycle", () => {
  it("cancels a fire-and-forget prompt and closes it when its command returns", async () => {
    let promptResult: PluginPromptTextResult | undefined;
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    runtime.host.registerPlugin(
      {
        id: "org.test.prompt-command-end",
        name: "Prompt Command End",
        version: "0.0.1",
        apiVersion: "^0.1.3",
        entry: "dist/plugin.js",
        permissions: ["ui.panel"],
        contributes: { commands: [{ id: "plugin.promptCommandEnd.run", title: "Run" }] }
      },
      {
        commandHandlers: {
          "plugin.promptCommandEnd.run": (context) => {
            void context.dialogs!
              .promptText({ title: "Prompt", label: "Value" })
              .then((result) => (promptResult = result));
            return { ok: true };
          }
        }
      }
    );

    await expect(runtime.host.invokeCommand("plugin.promptCommandEnd.run")).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(promptResult).toEqual({ status: "cancelled" }));
    expect(runtime.prompts.getOpenPrompt()).toBeUndefined();
  });

  it("resolves an open prompt as cancelled when the plugin is disabled", async () => {
    const manifest: PluginManifest = {
      id: "org.test.prompt-disable",
      name: "Prompt Disable",
      version: "0.0.1",
      apiVersion: "^0.1.3",
      entry: "dist/plugin.js",
      permissions: ["ui.panel"],
      contributes: {
        commands: [
          {
            id: "plugin.promptDisable.run",
            title: "Run",
            requiredPermissions: [],
            enabled: true
          }
        ],
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
    const descriptor: BundledPluginDescriptor = {
      manifest,
      options: {
        commandHandlers: {
          "plugin.promptDisable.run": (context) =>
            context.dialogs!.promptText({ title: "Prompt", label: "Value" })
        }
      }
    };
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    applyEnabledPlugins(runtime, new Set(), [descriptor]);

    const invocation = runtime.host.invokeCommand<PluginPromptTextResult>("plugin.promptDisable.run");
    await Promise.resolve();
    expect(runtime.prompts.getOpenPrompt()?.pluginName).toBe("Prompt Disable");

    applyEnabledPlugins(runtime, new Set([manifest.id]), [descriptor]);

    await expect(invocation).resolves.toEqual({ status: "cancelled" });
    expect(runtime.prompts.getOpenPrompt()).toBeUndefined();
  });
});
