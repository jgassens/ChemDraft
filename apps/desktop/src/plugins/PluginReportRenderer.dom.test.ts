// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { writeClipboardText } from "../clipboard";
import { PluginReportRenderer } from "./PluginReportRenderer";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn(async () => true) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("chemicalName report sections", () => {
  it("renders selectable name, kind, warnings, and copies exactly the name through the host", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PluginReportRenderer, { report: { title: "Name", sections: [{
        kind: "chemicalName", label: "Name", name: "(2R)-butan-2-ol", kindLabel: "Preferred IUPAC name",
        warnings: [{ code: "stereoLimitedEvidence", message: "Limited stereo evidence" }]
      }] } })));
      expect(container.querySelector("pre")?.style.userSelect).toBe("text");
      expect(container.textContent).toContain("Preferred IUPAC name");
      expect(container.textContent).toContain("Limited stereo evidence");
      await act(async () => container.querySelector("button")!.click());
      expect(writeClipboardText).toHaveBeenCalledWith("(2R)-butan-2-ol");
    } finally { act(() => root.unmount()); }
  });
  it("keeps unknown section kinds as readable text", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const report = { title: "Future", sections: [{ kind: "futureKind", body: "Retain this information" }] } as unknown as PluginPanelReport;
      await act(async () => root.render(createElement(PluginReportRenderer, { report })));
      expect(container.textContent).toContain("futureKind");
      expect(container.textContent).toContain("Retain this information");
    } finally { act(() => root.unmount()); }
  });
});

describe("interactive report sections", () => {
  const prompt = (overrides: Record<string, unknown> = {}): PluginPanelReport => ({
    title: "Assistant",
    sections: [{
      kind: "prompt",
      id: "assistant.prompt",
      commandId: "plugin.assistant.submit",
      label: "Ask the assistant",
      placeholder: "Describe a change",
      submitLabel: "Send",
      maxLength: 5,
      rows: 2,
      hint: "Enter sends; Shift+Enter adds a line.",
      select: { id: "assistant.provider", label: "Provider", value: "codex", options: [{ value: "codex", label: "Codex" }] },
      ...overrides
    }]
  } as PluginPanelReport);

  function mount(report: PluginPanelReport, onAction?: Parameters<typeof PluginReportRenderer>[0]["onAction"]) {
    const container = document.createElement("div");
    const root = createRoot(container);
    return { container, root, render: async (next = report) => act(async () => root.render(createElement(PluginReportRenderer, { report: next, onAction }))) };
  }

  function enterText(textarea: HTMLTextAreaElement, value: string): void {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("renders prompt, actions, and image sections", async () => {
    const report = {
      title: "Controls",
      sections: [
        ...prompt().sections,
        { kind: "actions", id: "assistant.actions", buttons: [{ id: "clear", label: "Clear", commandId: "plugin.assistant.clear", tone: "danger" }] },
        { kind: "image", dataUri: "data:image/png;base64,AA==", alt: "Reaction preview", caption: "Preview", maxWidthPx: 320 }
      ]
    } as PluginPanelReport;
    const view = mount(report, vi.fn(async () => ({ ok: true as const })));
    try {
      await view.render();
      expect(view.container.querySelector("textarea")).not.toBeNull();
      expect(view.container.querySelector("select")).not.toBeNull();
      expect(view.container.querySelector(".plugin-report-action-danger")?.textContent).toBe("Clear");
      const image = view.container.querySelector("img")!;
      expect(image.alt).toBe("Reaction preview");
      expect(image.style.maxWidth).toBe("320px");
      expect(view.container.textContent).toContain("Preview");
    } finally { act(() => view.root.unmount()); }
  });

  it("sends on Enter but retains a newline with Shift+Enter", async () => {
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const view = mount(prompt(), onAction);
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => {
        enterText(textarea, "hello");
      });
      await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(onAction).toHaveBeenCalledWith({ sectionId: "assistant.prompt", control: "prompt", text: "hello" });
      await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
      expect(onAction).toHaveBeenCalledTimes(1);
    } finally { act(() => view.root.unmount()); }
  });

  it("does not submit during IME composition", async () => {
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const view = mount(prompt(), onAction);
    try {
      await view.render();
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true });
      await act(async () => view.container.querySelector("textarea")!.dispatchEvent(event));
      const imeKeyCode = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      Object.defineProperty(imeKeyCode, "keyCode", { value: 229 });
      await act(async () => view.container.querySelector("textarea")!.dispatchEvent(imeKeyCode));
      expect(onAction).not.toHaveBeenCalled();
    } finally { act(() => view.root.unmount()); }
  });

  it("keeps a refused draft and clears an accepted one", async () => {
    const onAction = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, message: "Still working" })
      .mockResolvedValueOnce({ ok: true as const });
    const view = mount(prompt(), onAction);
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => {
        enterText(textarea, "hello");
      });
      await act(async () => view.container.querySelector("button")!.click());
      expect(textarea.value).toBe("hello");
      expect(view.container.querySelector("[role=alert]")?.textContent).toBe("Still working");
      await act(async () => view.container.querySelector("button")!.click());
      expect(textarea.value).toBe("");
    } finally { act(() => view.root.unmount()); }
  });

  it("keeps text entered while an earlier prompt submission is pending", async () => {
    let resolveAction: (result: { ok: true }) => void = () => undefined;
    const onAction = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      resolveAction = resolve;
    }));
    const view = mount(prompt(), onAction);
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => enterText(textarea, "first"));
      await act(async () => view.container.querySelector("button")!.click());
      await act(async () => enterText(textarea, "later"));
      await act(async () => resolveAction({ ok: true }));
      expect(textarea.value).toBe("later");
    } finally { act(() => view.root.unmount()); }
  });

  it("caps prompt drafts at the report maxLength", async () => {
    const onAction = vi.fn(async () => ({ ok: false as const, message: "No" }));
    const view = mount(prompt(), onAction);
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => enterText(textarea, "longer than five"));
      await act(async () => view.container.querySelector("button")!.click());
      expect(onAction).toHaveBeenCalledWith({ sectionId: "assistant.prompt", control: "prompt", text: "longe" });
    } finally { act(() => view.root.unmount()); }
  });

  it("leaves disabled prompt textareas editable, preserving the focused DOM node across reports", async () => {
    const view = mount(prompt({ disabled: true }));
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      expect(textarea.disabled).toBe(false);
      expect(textarea.readOnly).toBe(false);
      expect(view.container.querySelector("button")?.disabled).toBe(true);
      expect(view.container.querySelector("select")?.disabled).toBe(true);
      await view.render(prompt({ disabled: true, hint: "Updated report" }));
      expect(view.container.querySelector("textarea")).toBe(textarea);
    } finally { act(() => view.root.unmount()); }
  });

  it("preserves a numeric prompt id's textarea and draft as transcript sections are added", async () => {
    const numericPrompt = prompt({ id: "1" });
    const view = mount({
      title: numericPrompt.title,
      sections: [
        { kind: "text", body: "Before the transcript" },
        { kind: "text", body: "Transcript" },
        ...numericPrompt.sections
      ]
    } as PluginPanelReport);
    try {
      await view.render();
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => enterText(textarea, "draft"));
      await view.render({
        title: numericPrompt.title,
        sections: [
          { kind: "text", body: "Before the transcript" },
          ...numericPrompt.sections,
          { kind: "text", body: "Transcript" },
          { kind: "text", body: "After the prompt" }
        ]
      } as PluginPanelReport);
      expect(view.container.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe("draft");
      await view.render({
        title: numericPrompt.title,
        sections: [
          { kind: "text", body: "Before the prompt" },
          { kind: "text", body: "Transcript" },
          ...numericPrompt.sections,
          { kind: "text", body: "After the prompt" }
        ]
      } as PluginPanelReport);
      expect(view.container.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe("draft");
    } finally { act(() => view.root.unmount()); }
  });

  it("honours action button disabled state and reports button and select actions", async () => {
    const onAction = vi.fn(async () => ({ ok: true as const }));
    const report = {
      title: "Actions",
      sections: [
        ...prompt().sections,
        { kind: "actions", id: "assistant.actions", buttons: [
          { id: "default", label: "Default", commandId: "plugin.assistant.default", tone: "default" },
          { id: "primary", label: "Primary", commandId: "plugin.assistant.primary", tone: "primary" },
          { id: "disabled", label: "Disabled", commandId: "plugin.assistant.disabled", tone: "danger", disabled: true }
        ] }
      ]
    } as PluginPanelReport;
    const view = mount(report, onAction);
    try {
      await view.render();
      expect(view.container.querySelector(".plugin-report-action-primary")).not.toBeNull();
      expect((view.container.querySelector(".plugin-report-action-danger") as HTMLButtonElement | null)?.disabled).toBe(true);
      await act(async () => (view.container.querySelector(".plugin-report-action-default") as HTMLButtonElement).click());
      const select = view.container.querySelector("select")!;
      await act(async () => {
        select.value = "codex";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onAction).toHaveBeenCalledWith({ sectionId: "assistant.actions", control: "button", controlId: "default" });
      expect(onAction).toHaveBeenCalledWith({ sectionId: "assistant.prompt", control: "select", controlId: "assistant.provider", selected: "codex" });
    } finally { act(() => view.root.unmount()); }
  });

  it("disables action controls without an action handler without throwing", async () => {
    const view = mount(prompt());
    try {
      await view.render();
      expect(view.container.querySelector("textarea")?.disabled).toBe(false);
      expect(view.container.querySelector("button")?.disabled).toBe(true);
      expect(view.container.querySelector("select")?.disabled).toBe(true);
    } finally { act(() => view.root.unmount()); }
  });
});
