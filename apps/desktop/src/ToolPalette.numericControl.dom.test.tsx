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

function inspectorModel(length: number, secondLength?: number) {
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
  const molecules = [molecule];
  if (secondLength !== undefined) {
    const second = structuredClone(molecule);
    second.id = "mol_numeric_second";
    second.width = secondLength;
    second.atoms[1]!.x = secondLength;
    molecules.push(second);
  }
  return createMoleculeInspectorModel(
    applyPatches(doc, molecules.map((object) => ({ op: "addObject" as const, pageId: doc.pages[0].id, object }))),
    { selectedObjectIds: molecules.map((object) => object.id) }
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

  async function input(value: string, element = field(), inputType = "insertText") {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
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
    expect(field().value).toBe("30");
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

  it.each(["untouched", "Enter", "arrow", "spinner"])("follows undo while focused and undirty after %s", async (action) => {
    if (action === "Enter") {
      await input("42.5");
      await key("Enter");
    } else if (action === "arrow") {
      await key("ArrowUp");
    } else if (action === "spinner") {
      await act(async () => field().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await input("22.5", field(), "");
      await act(async () => field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    }
    if (action !== "untouched") {
      model = inspectorModel(action === "Enter" ? 42.5 : 22.5);
      await render(); // Commit acknowledgement arrives before undo.
    }
    const commits = onCommit.mock.calls.length;
    model = inspectorModel(40);
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("40");
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledTimes(commits);
  });

  it("preserves text typed after the last commit while undo changes the model", async () => {
    await input("42.5");
    await key("Enter");
    model = inspectorModel(42.5);
    await render();
    await input("43");
    model = inspectorModel(22);
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("43");
    await key("Enter");
    expect(onCommit.mock.calls).toEqual([42.5, 43].map((value) => [moleculeStructureBondLengthCommandId(value)]));
  });

  it.each([false, true])("commits an earlier step after an outside change during typing (echo acknowledged: %s)", async (acknowledged) => {
    await key("ArrowUp");
    if (acknowledged) {
      model = inspectorModel(22.5);
      await render();
    }
    await input("22.5");
    model = inspectorModel(40);
    await render();
    expect(field().value).toBe("22.5");
    await key("Enter");
    await act(async () => field().blur());
    expect(onCommit.mock.calls).toEqual([22.5, 22.5].map((value) => [moleculeStructureBondLengthCommandId(value)]));
  });

  it("does not repeat a typed commit equal to an outstanding own step", async () => {
    await key("ArrowUp");
    await input("22.5");
    await key("Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(22.5));
  });

  it("uses the current exact model even when an outside change keeps the same display text", async () => {
    await key("ArrowUp");
    model = inspectorModel(22.5);
    await render();
    await input("22.5");
    model.structure.values.bondLengthPx = { value: 22.5001, mixed: false };
    await render();
    await key("Enter");
    expect(onCommit.mock.calls).toEqual([22.5, 22.5].map((value) => [moleculeStructureBondLengthCommandId(value)]));
  });

  it("normalizes a uniform selection's non-exact numeric value when its shown value is typed", async () => {
    model = inspectorModel(22.0001, 22.0002);
    expect(model.targets.moleculeObjectIds).toHaveLength(2);
    expect(model.structure.values.bondLengthPx.mixed).toBe(false);
    // Exercise the control's raw numeric prop contract, independently of the builder's rounding.
    model.structure.values.bondLengthPx = { value: 22.0001, mixed: false };
    await render();
    expect(field().value).toBe("22");
    await input(field().value);
    await key("Enter");
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(22));
  });

  it.each([null, 30])("leaves an unedited Mixed field alone and commits a typed value (model value: %s)", async (value) => {
    model.structure.values.bondLengthPx = { value, mixed: true };
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
    await input("23", field(), "");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(23));
    await act(async () => {
      field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      field().blur();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("skips retyping the displayed value in every shared number field", async () => {
    for (const element of container.querySelectorAll<HTMLInputElement>('.molecule-inspector-number-field input[type="number"]:not(:disabled)')) {
      await act(async () => element.focus());
      await input(element.value, element);
      await key("Enter", element);
      await act(async () => element.blur());
    }
    expect(onCommit).not.toHaveBeenCalled();
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

  it.each([
    { snapshots: [30, 31], finish: "pointerup" },
    { snapshots: [31, 30], finish: "pointerup" },
    { snapshots: [30, 31], finish: "blur" },
    { snapshots: [31, 30], finish: "blur" }
  ])("keeps the latest slider value through preview acknowledgements $snapshots until $finish", async ({ snapshots, finish }) => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    await input("30", slider);
    await input("31", slider);
    expect(onPreview.mock.calls).toEqual([30, 31].map((value) => [moleculeStructureBondLengthCommandId(value)]));
    const displayedValues: string[] = [];
    for (const value of snapshots) {
      model = inspectorModel(value);
      await render();
      displayedValues.push(slider.value);
    }
    await act(async () => {
      if (finish === "blur") slider.blur();
      else slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(31));
    expect(displayedValues).toEqual(["31", "31"]);
    await act(async () => {
      slider.blur();
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      slider.blur();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("supersedes a slider gesture when an unpreviewed model value arrives before release", async () => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    await input("31", slider);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(31));
    model = inspectorModel(40);
    await render();
    expect(slider.value).toBe("40");
    await act(async () => {
      slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      slider.blur();
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([false, true])("Tab to the slider commits only a typed number (Mixed: %s)", async (mixed) => {
    if (mixed) {
      model.structure.values.bondLengthPx = { value: null, mixed: true };
      await act(async () => field().blur());
      await render();
      await act(async () => field().focus());
    } else {
      await input("30");
    }
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await key("Tab");
    // jsdom does not implement Tab's default focus traversal. Perform that browser action,
    // including its real blur/focus events, then deliver keyup to the newly focused slider.
    await act(async () => slider.focus());
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true })));
    await act(async () => slider.blur());
    expect(onCommit.mock.calls).toEqual(mixed ? [] : [[moleculeStructureBondLengthCommandId(30)]]);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("clears a committed slider draft without blur", async () => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => slider.focus());
    await input("30", slider);
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    expect(slider.value).toBe("22"); // Follow the model while the commit snapshot is pending.
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      slider.blur();
      slider.focus();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    model = inspectorModel(40);
    await render();
    expect(slider.value).toBe("40");
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await input("30", slider);
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(onCommit.mock.calls).toEqual([
      [moleculeStructureBondLengthCommandId(30)], [moleculeStructureBondLengthCommandId(30)]
    ]);
  });

  it.each(["value", "Mixed"])("discards a slider draft after an external %s change and commits a click to its old value once", async (change) => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => slider.focus());
    await input("30", slider);
    // A new selection/undo can arrive while the slider still has DOM focus.
    model = inspectorModel(change === "value" ? 40 : 22);
    if (change === "Mixed") model.structure.values.bondLengthPx.mixed = true;
    await render();
    expect(document.activeElement).toBe(slider);
    expect(slider.value).toBe(change === "value" ? "40" : "22");
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true })));
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await input("30", slider);
    await act(async () => slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(30));
    await act(async () => slider.blur());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits the changed slider value on arrow release before a model snapshot arrives", async () => {
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => slider.focus());
    await key("ArrowUp", slider);
    // Browser range stepping is a default action absent from jsdom.
    await input("22.5", slider);
    await act(async () => slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true })));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(22.5));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(moleculeStructureBondLengthCommandId(22.5));
  });

  it("steps from the current draft during held ArrowUp without duplicate commits", async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowUp", repeat: i > 0, bubbles: true, cancelable: true
      })));
    }
    expect(onCommit.mock.calls).toEqual([22.5, 23, 23.5, 24].map((value) => [moleculeStructureBondLengthCommandId(value)]));
    await act(async () => field().blur());
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  it.each(["ArrowUp", "spinner"])("keeps held %s steps ahead of late, out-of-order snapshots", async (gesture) => {
    if (gesture === "spinner") {
      await act(async () => field().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    }
    async function tick(expected: number) {
      if (gesture === "ArrowUp") await key("ArrowUp");
      else await act(async () => {
        field().stepUp();
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field().value).toBe(String(expected));
    }
    await tick(22.5);
    await tick(23);
    await tick(23.5);
    let latest = 23.5;
    // Every echo is still outstanding; replaying an already consumed value is an outside edit.
    for (const acknowledgement of [23, 22.5, 23.5, 24, 24.5]) {
      model = inspectorModel(acknowledgement);
      await render();
      expect(field().value).toBe(String(latest));
      latest += 0.5;
      await tick(latest);
    }
    expect(onCommit.mock.calls).toEqual(
      Array.from({ length: 8 }, (_, index) => [moleculeStructureBondLengthCommandId(22.5 + index * 0.5)])
    );
    // An undo/selection snapshot outside this control's sent values takes effect immediately,
    // even before the held gesture ends. It also permits a fresh edit to an earlier value.
    model = inspectorModel(22);
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("22");
    await tick(22.5);
    await act(async () => {
      field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      field().blur();
    });
    expect(onCommit).toHaveBeenCalledTimes(9);
  });

  it.each([
    { echoes: [23, 22.5, 23.5], historyValue: 23, history: "undo" },
    { echoes: [23, 23.5], historyValue: 22.5, history: "undo after the latest echo supersedes an older one" },
    { echoes: [23.5, 23, 22.5], historyValue: 23, history: "undo with the latest echo arriving first" }
  ])("follows $history while focused, then steps and redoes previously sent values", async ({ echoes, historyValue }) => {
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => field().dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowUp", repeat: tick > 0, bubbles: true, cancelable: true
      })));
    }
    expect(field().value).toBe("23.5");
    for (const echo of echoes) {
      model = inspectorModel(echo);
      await render();
    }
    model = inspectorModel(historyValue);
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe(String(historyValue));
    expect(onCommit).toHaveBeenCalledTimes(3);
    await key("ArrowUp");
    expect(field().value).toBe(String(historyValue + 0.5));
    expect(onCommit.mock.calls.at(-1)).toEqual([moleculeStructureBondLengthCommandId(historyValue + 0.5)]);
    // Acknowledge the new step, then redo to a value sent during the original hold.
    model = inspectorModel(historyValue + 0.5);
    await render();
    model = inspectorModel(23.5);
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("23.5");
    await key("ArrowUp");
    expect(field().value).toBe("24");
    expect(onCommit.mock.calls).toEqual([22.5, 23, 23.5, historyValue + 0.5, 24]
      .map((value) => [moleculeStructureBondLengthCommandId(value)]));
  });

  it("accepts an already acknowledged value as an outside edit while newer echoes remain outstanding", async () => {
    for (let tick = 0; tick < 3; tick++) await key("ArrowUp");
    for (const snapshot of [23, 22.5]) {
      model = inspectorModel(snapshot);
      await render();
      expect(field().value).toBe("23.5");
    }
    model = inspectorModel(23); // Its own echo was consumed; this is an undo/outside edit.
    await render();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("23");
    await key("ArrowUp");
    expect(onCommit.mock.calls).toEqual([22.5, 23, 23.5, 23.5]
      .map((value) => [moleculeStructureBondLengthCommandId(value)]));
  });

  it("steps a held native spinner from each current value and stops committing at the limit", async () => {
    await act(async () => field().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        field().stepUp();
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(onCommit.mock.calls).toEqual([22.5, 23, 23.5, 24].map((value) => [moleculeStructureBondLengthCommandId(value)]));
    await act(async () => field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    await input("120");
    await key("Enter");
    await key("ArrowUp");
    await act(async () => field().blur());
    expect(onCommit.mock.calls.at(-1)).toEqual([moleculeStructureBondLengthCommandId(120)]);
    expect(onCommit).toHaveBeenCalledTimes(5);
  });

  it.each([false, true])("ignores unchanged slider clicks, keyups and blur (Mixed: %s)", async (mixed) => {
    await act(async () => field().blur());
    if (mixed) {
      model.structure.values.bondLengthPx = { value: null, mixed: true };
      await render();
    }
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Target bond length slider"]')!;
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      slider.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      slider.blur();
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it.each(["ArrowUp", "ArrowDown", "spinner"])("leaves Mixed unchanged on %s until text or slider input", async (action) => {
    await act(async () => field().blur());
    model.structure.values.bondLengthPx = { value: null, mixed: true };
    await render();
    await act(async () => field().focus());
    if (action === "spinner") {
      await act(async () => field().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await input("8", field(), ""); // Chromium/WebKit's native spin default from a blank min=8 field.
      await act(async () => field().dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    } else {
      await key(action);
    }
    await act(async () => field().blur());
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });
});
