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
