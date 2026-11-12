import { initialDocumentTabId } from "./testSupport/documentTabIdentity";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Acs1996StylePreset, RscJournalStylePreset, SketchStylePreset, createEmptyDocument } from "@chemdraft/chem-core";
import { createSmilesMolecule, createNativeTextObject } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { nativeStylePresetCommandId } from "./commands";
import { normalizeCommittedDocument } from "./documentWorkflow";
import { nativeStylePresetPatchForSelection } from "./nativeStylePresetCommand";
import { applyPatches, type CompatibilityWarning, type MoleculeObject } from "@chemdraft/chem-core";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("MainWindow native style presets (%s)", platform => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  const read = () => getAssistantHistoryPort().read(initialDocumentTabId())!;

  it("keeps a legacy charge mark through desktop commit normalization", () => {
    const initial = createEmptyDocument();
    const molecule: MoleculeObject = {
      id: "chain", type: "molecule", x: 100, y: 100, width: 200, height: 0, rotation: 0,
      style: { bondLengthPx: 40 }, structureFormat: "smiles", structure: "[CH2-]CCCCC",
      atoms: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, element: "C", x: 100 + i * 40, y: 100,
        formalCharge: i === 0 ? -1 : 0, ...(i === 0 ? { markCharge: -1 } : {}) })),
      bonds: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single" })),
      superatoms: [], rGroups: []
    };
    initial.pages[0]!.objects = [molecule, { id: "negative", type: "electron-mark", x: 74, y: 94,
      width: 12, height: 12, rotation: 0, style: {}, markKind: "charge", charge: -1,
      anchor: { kind: "atom", objectId: "chain", atomId: "a0" } }];
    initial.selection.objectIds = [molecule.id];
    expect(normalizeCommittedDocument(initial)).toBe(initial);
    const patch = nativeStylePresetPatchForSelection(initial, Acs1996StylePreset.id, []);
    const committed = normalizeCommittedDocument(applyPatches(initial, patch.patches));
    const styled = committed.pages[0]!.objects[0] as MoleculeObject;
    expect(styled.atoms[0]).toMatchObject({ x: 145, y: 100, formalCharge: -1, markCharge: -1 });
    expect(committed.pages[0]!.objects[1]).toMatchObject({ x: 128, y: 94,
      anchor: { kind: "atom", objectId: "chain", atomId: "a0" } });
  });

  it("shows the chemistry refusal and leaves the molecule and mark unchanged", async () => {
    const initial = createEmptyDocument();
    const molecule = createSmilesMolecule(initial, { x: 180, y: 180 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: -1 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "[CH2-]C", undefined, { bondLengthPx: 10 });
    molecule.style.bondLengthPx = 40;
    const atom = molecule.atoms[0]!;
    atom.markCharge = -1;
    initial.pages[0]!.objects.push(molecule, {
      id: "negative", type: "electron-mark", x: atom.x - 46, y: atom.y - 6,
      width: 12, height: 12, rotation: 0, style: {}, markKind: "charge", charge: -1,
      anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id }
    });
    initial.selection.objectIds = [molecule.id];
    const warnings: CompatibilityWarning[] = [];
    expect(nativeStylePresetPatchForSelection(initial, Acs1996StylePreset.id, [], warnings).patches).toEqual([]);
    expect(warnings).toEqual([{
      code: "style_preset.chemistry_change_refused", objectId: molecule.id,
      message: "Skipped a structure because it would change a charge."
    }]);
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    const before = structuredClone(read());
    await command(nativeStylePresetCommandId(Acs1996StylePreset.id));
    expect(read()).toEqual(before);
    const status = container.querySelector('[role="status"]')?.textContent;
    expect(status).toBe("Skipped 1 structure because it would change a charge.");
  });

  it("reports applied and skipped structures together", async () => {
    const initial = createEmptyDocument();
    const makeMolecule = (x: number) => createSmilesMolecule(initial, { x, y: 180 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: -1 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "[CH2-]C", undefined, { bondLengthPx: 10 });
    const refused = makeMolecule(180);
    // IDs are allocated from inserted objects, so insert the first before creating the second.
    initial.pages[0]!.objects.push(refused);
    const applied = makeMolecule(400);
    expect(applied.id).not.toBe(refused.id);
    refused.style.bondLengthPx = 40;
    const atom = refused.atoms[0]!;
    atom.markCharge = -1;
    initial.pages[0]!.objects.push(applied, {
      id: "negative", type: "electron-mark", x: atom.x - 46, y: atom.y - 6,
      width: 12, height: 12, rotation: 0, style: {}, markKind: "charge", charge: -1,
      anchor: { kind: "atom", objectId: refused.id, atomId: atom.id }
    });
    initial.selection.objectIds = [refused.id, applied.id];
    const warnings: CompatibilityWarning[] = [];
    const planned = nativeStylePresetPatchForSelection(initial, Acs1996StylePreset.id, [], warnings);
    expect(warnings).toEqual([{
      code: "style_preset.chemistry_change_refused", objectId: refused.id,
      message: "Skipped a structure because it would change a charge."
    }]);
    expect(planned.patches.filter(patch => patch.op === "updateObject").map(patch => patch.objectId))
      .toEqual([applied.id]);
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    await command(nativeStylePresetCommandId(Acs1996StylePreset.id));
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe(`Applied ${Acs1996StylePreset.name} to 1 structure; skipped 1 structure because it would change a charge.`);
    const objects = read().pages[0]!.objects;
    expect(objects.find(object => object.id === refused.id)).toEqual(refused);
    expect(objects.find(object => object.id === applied.id)?.style.stylePresetId).toBe(Acs1996StylePreset.id);
  });

  it.each([Acs1996StylePreset, RscJournalStylePreset, SketchStylePreset])("applies $name in one labelled entry and restores exact undo/redo snapshots", async preset => {
    const initial = createEmptyDocument();
    initial.pages[0]!.objects.push(createSmilesMolecule(initial, { x: 180, y: 180 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "N", x: 1, y: 0, charge: 1 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "C[NH3+]", undefined, { bondLengthPx: 30 }));
    initial.pages[0]!.objects.push(createNativeTextObject(initial, { x: 150, y: 240 }, "Caption"));
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    const before = structuredClone(read());
    await command(nativeStylePresetCommandId(preset.id));
    const after = structuredClone(read());
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Applied ${preset.name}`);
    expect(after.styles.drawing).toEqual(preset.drawing);
    expect(after.selection.objectIds).toEqual(after.pages[0]!.objects.map(object => object.id));
    expect(after.pages[0]!.objects.every(object => object.style.stylePresetId === preset.id)).toBe(true);
    await command("edit.undo");
    expect(read()).toEqual(before);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Undid ${preset.name}`);
    await command("edit.undo");
    expect(read()).toEqual(before);
    await command("edit.redo");
    expect(read()).toEqual(after);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Redid ${preset.name}`);
    await command(nativeStylePresetCommandId(preset.id));
    expect(read()).toEqual(after);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${preset.name} already matches`);
    await command("edit.undo");
    expect(read()).toEqual(before); // Applying the same preset added no entry.
  });

  it("uses selection scope when anything is selected and leaves other objects/defaults unchanged", async () => {
    const initial = createEmptyDocument();
    initial.pages[0]!.objects.push(createNativeTextObject(initial, { x: 100, y: 100 }, "Selected"));
    initial.pages[0]!.objects.push({ ...createNativeTextObject(initial, { x: 200, y: 200 }, "Untouched"), id: "untouched" });
    initial.selection = { pageId: initial.pages[0]!.id, objectIds: [initial.pages[0]!.objects[0]!.id] };
    await act(async () => root.render(<MainWindow initialDocument={initial} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} shortcutPlatform={platform} />));
    const before = structuredClone(read());
    await command(nativeStylePresetCommandId(Acs1996StylePreset.id));
    expect(read().styles).toEqual(before.styles);
    expect(read().pages[0]!.objects[1]).toEqual(before.pages[0]!.objects[1]);
    expect(read().pages[0]!.objects[0]!.style.stylePresetId).toBe(Acs1996StylePreset.id);
    await command("edit.undo");
    expect(read()).toEqual(before);
  });
});
