// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ColorPickerPopoverBody, ToolPalette } from "./ToolPalette";
import { applyPatches } from "@chemdraft/chem-core";
import { createNativeSingleBondMolecule, createPhase4Document } from "./documentWorkflow";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { getToolsetItemGroups } from "./toolsets";
import { moleculeStructureBondColorCommandId, moleculeStructureBondColorForCommand } from "./commands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("palette color picker", () => {
  it.each(["Bond color", "System color wheel"])("commits %s once on native change, with no second commit on blur", async (label) => {
    const preview = vi.fn();
    const commit = vi.fn();
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [color, setColor] = useState("#111111");
      if (label === "System color wheel") return createElement(ColorPickerPopoverBody, {
        value: color, onPreviewColor: (next) => { preview(next); setColor(next); }, onCommitColor: commit
      });
      const doc = createPhase4Document();
      const molecule = createNativeSingleBondMolecule(doc, { x: 100, y: 100 });
      molecule.style.bondColor = color;
      const model = createMoleculeInspectorModel(applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: molecule }]),
        { selectedObjectIds: [molecule.id] });
      return createElement(ToolPalette, {
        itemGroups: [getToolsetItemGroups("core.drawnStructureSettings").flat().filter((item) => item.primary.type === "control")],
        activeTool: "tool.select", onInvoke: vi.fn(), widgetState: {
          currentMoleculeInspector: model, onInvoke: vi.fn(), onMoleculeInspectorCommit: commit,
          onMoleculeInspectorPreview: (id) => { preview(id); setColor(moleculeStructureBondColorForCommand(id)!.color); }
        }
      });
    }
    const expected = (color: string) => label === "Bond color" ? moleculeStructureBondColorCommandId(color) : color;
    try {
      await act(async () => root.render(createElement(Harness)));
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      await act(async () => input.focus());
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#0000ff");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(preview).toHaveBeenCalledExactlyOnceWith(expected("#0000ff"));
      expect(commit).not.toHaveBeenCalled();
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(commit).toHaveBeenCalledExactlyOnceWith(expected("#0000ff"));
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      await act(async () => input.blur());
      expect(commit).toHaveBeenCalledTimes(1);
      expect(preview).toHaveBeenCalledTimes(1);
      // A later pick with input events but no native change still settles on blur.
      await act(async () => input.focus());
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#00ff00");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.blur());
      expect(commit.mock.calls).toEqual([[expected("#0000ff")], [expected("#00ff00")]]);
      // A chooser may report only its final change value, without live input.
      await act(async () => input.focus());
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#ff0000");
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => input.blur());
      expect(commit.mock.calls).toEqual(["#0000ff", "#00ff00", "#ff0000"].map(color => [expected(color)]));
      expect(preview.mock.calls).toEqual(commit.mock.calls);
    } finally {
      await act(async () => root.unmount()); container.remove();
    }
  });

  describe.each(["Bond color", "System color wheel"])("%s model boundaries", label => {
    // Reuse the mounted input: replacing it would conceal the stale ref defect.
    async function chooser() {
      const preview = vi.fn(), commit = vi.fn();
      const container = document.createElement("div"); document.body.append(container);
      const root = createRoot(container);
      const doc = createPhase4Document();
      const molecule = createNativeSingleBondMolecule(doc, { x: 100, y: 100 });
      const expected = (color: string) => label === "Bond color" ? moleculeStructureBondColorCommandId(color) : color;
      const render = async (color: string, contextKey = "document-a/selection-a/history-1") => {
        molecule.style.bondColor = color;
        const model = createMoleculeInspectorModel(
          applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: molecule }]),
          { selectedObjectIds: [molecule.id] }
        );
        await act(async () => root.render(label === "System color wheel"
          ? createElement(ColorPickerPopoverBody, { value: color, contextKey, onPreviewColor: preview, onCommitColor: commit })
          : createElement(ToolPalette, {
            itemGroups: [getToolsetItemGroups("core.drawnStructureSettings").flat().filter(item => item.primary.type === "control")],
            activeTool: "tool.select", onInvoke: vi.fn(), widgetState: {
              colorContextKey: contextKey, currentMoleculeInspector: model, onInvoke: vi.fn(),
              onMoleculeInspectorPreview: preview, onMoleculeInspectorCommit: commit
            }
          })));
      };
      await render("#111111");
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      await act(async () => input.focus());
      const pick = async (color: string) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, color);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const change = async () => act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      return { input, preview, commit, expected, render, pick, change, container,
        close: async () => { await act(async () => root.unmount()); container.remove(); } };
    }

    it.each([
      ["selection", "document-a/selection-b/history-1", "#00ff00"],
      ["undo", "document-a/selection-a/history-0", "#111111"],
      ["redo", "document-a/selection-a/history-2", "#ff0000"],
      ["document replacement", "document-b/selection-a/history-1", "#ffff00"],
      ["another surface's edit", "document-a/selection-a/history-1", "#00ffff"]
    ])("follows %s after a preview echo and cannot recommit the old pick", async (_boundary, context, color) => {
      const c = await chooser();
      try {
        await c.pick("#0000ff");
        await c.render("#0000ff"); // Matching echo releases local-value retention.
        await c.render(color, context);
        expect(c.container.querySelector(`input[aria-label="${label}"]`)).toBe(c.input);
        expect(c.input.value).toBe(color);
        await c.change(); // No browser value assignment: use what the chooser actually shows.
        await act(async () => c.input.blur());
        expect(c.commit).not.toHaveBeenCalled();
        expect(c.preview).toHaveBeenCalledExactlyOnceWith(c.expected("#0000ff"));
      } finally { await c.close(); }
    });

    it.each(["selection", "undo", "redo", "commit settled"])("drops an unacknowledged pick at a %s boundary even when the model colour is unchanged", async boundary => {
      const c = await chooser();
      try {
        await c.pick("#0000ff");
        if (boundary === "commit settled") await c.change();
        c.commit.mockClear();
        await c.render("#111111", boundary);
        expect(c.input.value).toBe("#111111");
        await c.change();
        expect(c.commit).not.toHaveBeenCalled();
      } finally { await c.close(); }
    });

    it.each([false, true])("bounds a skipped echo, including after commit (committed: %s)", async committed => {
      vi.useFakeTimers();
      const c = await chooser();
      try {
        await c.pick("#0000ff");
        if (committed) await c.change();
        c.commit.mockClear();
        // Even unrelated props must not remain ignored indefinitely.
        await c.render("#00ff00");
        await act(async () => { vi.advanceTimersByTime(1100); });
        expect(c.input.value).toBe("#00ff00");
        await c.change();
        expect(c.commit).not.toHaveBeenCalled();
        await c.render("#ff0000");
        expect(c.input.value).toBe("#ff0000");
      } finally { await c.close(); vi.useRealTimers(); }
    });

    it("expires a rejected echo when the model never rerenders", async () => {
      vi.useFakeTimers();
      const c = await chooser();
      try {
        await c.pick("#0000ff");
        await act(async () => { vi.advanceTimersByTime(1100); });
        expect(c.input.value).toBe("#111111");
        await c.change();
        expect(c.commit).not.toHaveBeenCalled();
      } finally { await c.close(); vi.useRealTimers(); }
    });

    it("Escape discards an unacknowledged pick before a late native change", async () => {
      const c = await chooser();
      try {
        await c.pick("#0000ff");
        await act(async () => c.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        expect(c.input.value).toBe("#111111");
        await c.change();
        expect(c.commit).not.toHaveBeenCalled();
      } finally { await c.close(); }
    });
  });

  it("does not mistake an optimistic popover draft for a model echo", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const commit = vi.fn();
    function Harness({ modelColor, context }: { modelColor: string; context: string }) {
      const [draft, setDraft] = useState("#111111");
      return createElement(ColorPickerPopoverBody, {
        activeColor: modelColor, value: draft, contextKey: context,
        onPreviewColor: setDraft, onCommitColor: commit
      });
    }
    try {
      await act(async () => root.render(createElement(Harness, { modelColor: "#111111", context: "a" })));
      const input = container.querySelector<HTMLInputElement>('input[aria-label="System color wheel"]')!;
      const pick = async () => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#0000ff");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await pick(); // Parent immediately echoes the draft, while IPC never echoes it.
      expect(input.value).toBe("#0000ff");
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(input.value).toBe("#111111");
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(commit).not.toHaveBeenCalled();
      await pick();
      await act(async () => root.render(createElement(Harness, { modelColor: "#00ff00", context: "b" })));
      expect(input.value).toBe("#00ff00");
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    }
  });

  it("calls onPreviewColor before onCommitColor for a typed hex", async () => {
    const onPreviewColor = vi.fn();
    const onCommitColor = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(ColorPickerPopoverBody, {
        value: "#111111",
        onPreviewColor,
        onCommitColor
      })));
      const input = container.querySelector<HTMLInputElement>(".color-hex-field input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#1E88E5");
        input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
      });

      expect(onPreviewColor).toHaveBeenCalledExactlyOnceWith("#1e88e5");
      expect(onCommitColor).toHaveBeenCalledExactlyOnceWith("#1e88e5");
      expect(onPreviewColor.mock.invocationCallOrder[0]).toBeLessThan(onCommitColor.mock.invocationCallOrder[0]!);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
