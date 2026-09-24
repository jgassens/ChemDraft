// @vitest-environment jsdom

import type { PluginManifest, PluginPromptTextResult } from "@chemdraft/plugin-api";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntime } from "./createPluginRuntime";
import { PluginPromptTextDialog } from "./PluginPromptTextDialog";
import type { OpenPluginTextPrompt } from "./PluginPromptTextController";
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
            onSubmit: (value) => {
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
    expect(document.body.textContent).toContain("Requested by OPSIN Name to Structure");
    expect(document.activeElement).toBe(input);
    expect(submit.disabled).toBe(true);

    act(() => setInputValue(input, "  benzene  "));
    expect(submit.disabled).toBe(false);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

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

    mount(createElement(Harness));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(prior);
  });
});

describe("plugin prompt lifecycle", () => {
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
