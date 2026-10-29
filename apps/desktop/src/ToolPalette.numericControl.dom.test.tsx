// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPatches, createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPalette } from "./ToolPalette";
import { moleculeStructureBondLengthCommandId } from "./commands";
import { createMoleculeInspectorModel } from "./moleculeInspectorModel";
import { getToolsetItemGroups } from "./toolsets";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function inspectorModel(length: number) {
  const doc = createEmptyDocument({ id: "doc_numeric", pageId: "page_numeric", title: "Numeric controls" });
  const molecule: MoleculeObject = {
    id: "mol_numeric", type: "molecule", x: 0, y: 0, width: length, height: 20,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "CC",
    atoms: [
      { id: "a", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "b", element: "C", x: length, y: 0, formalCharge: 0 }
    ],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" }],
    superatoms: [], rGroups: []
  };
  return createMoleculeInspectorModel(
    applyPatches(doc, [{ op: "addObject", pageId: doc.pages[0].id, object: molecule }]),
    { selectedObjectIds: [molecule.id] }
  );
}

describe("palette numeric controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let model: ReturnType<typeof inspectorModel>;
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  const onCancel = vi.fn();
  const onInvoke = vi.fn();

  async function render() {
    await act(async () => root.render(createElement(ToolPalette, {
      itemGroups: [getToolsetItemGroups("core.drawnStructureSettings").flat().filter((item) => item.primary.type === "control")],
      activeTool: "tool.select",
      onInvoke,
      widgetState: {
        currentMoleculeInspector: model, onInvoke,
        onMoleculeInspectorCommit: onCommit,
        onMoleculeInspectorPreview: onPreview,
        onMoleculeInspectorCancel: onCancel
      }
    })));
  }

  function field() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Target bond length"]')!;
  }

  async function input(value: string, element = field()) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function key(key: string, element = field()) {
    await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    model = inspectorModel(22);
    await render();
    await act(async () => field().focus());
    expect(document.activeElement).toBe(field());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps partial text locally and commits 30 exactly once on Enter, even after blur", async () => {
    await input("3");
    expect(field().value).toBe("3");
    await input("30");
    expect(field().value).toBe("30");
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onInvoke).not.toHaveBeenCalled();
    await key("Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    expect(field().value).toBe("22");
    model = inspectorModel(30);
    await render();
    expect(field().value).toBe("30");
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it.each([["500", 120], ["3", 8]] as const)("clamps %s only when focus leaves", async (text, clamped) => {
    await input(text);
    expect(field().value).toBe(text);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(clamped));
    expect(field().value).toBe("22");
  });

  it.each(["abc", "", "1e999"])("reverts invalid or empty input %j on blur without commands", async (text) => {
    await input(text);
    await act(async () => field().blur());
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe("22");
  });

  it("protects a draft from external values and Escape restores the latest model without a blur commit", async () => {
    await input("30");
    model = inspectorModel(40);
    await render();
    expect(field().value).toBe("30");
    await key("Escape");
    expect(field().value).toBe("40");
    await act(async () => field().blur());
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves an unedited Mixed field alone and allows a typed Mixed value to commit", async () => {
    model.structure.values.bondLengthPx = { value: null, mixed: true };
    await act(async () => field().blur());
    await render();
    onCommit.mockClear();
    await act(async () => field().focus());
    expect(field().placeholder).toBe("Mixed");
    await key("Enter");
    await act(async () => field().blur());
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => field().focus());
    await input("30");
    expect(field().value).toBe("30");
    expect(onPreview).not.toHaveBeenCalled();
    await key("Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
  });

  it.each([["ArrowUp", 22.5], ["ArrowDown", 21.5]] as const)("commits a keyboard step immediately with %s", async (arrow, value) => {
    await key(arrow);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(value));
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits a native pointer step immediately without a second blur commit", async () => {
    await act(async () => field().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await input("23");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(23));
    await act(async () => {
      field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      field().blur();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps slider preview and immediate commit on pointer release", async () => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => { field().blur(); slider.focus(); });
    await input("30", slider);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    model = inspectorModel(30);
    await render();
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    await act(async () => slider.blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
