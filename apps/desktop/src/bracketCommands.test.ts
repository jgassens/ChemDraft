import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "@chemdraft/chem-core";
import { repeatUnitExportWarnings } from "@chemdraft/export-engine";
import { createBracketCommands, selectedBracketPair, setBracketRepeatLabel, toggleBracketRepeatUnit } from "./bracketCommands";
import { applySingleBondToolAtPoint, copyAsMolfile, copyAsSmiles, createPhase4Document,
  createSelectionClipboardPayload, duplicateSelectedDocumentObjects, insertNativeBracket, pasteSelectionClipboardPayload } from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi } from "./structureListExport";

vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn(async () => undefined) }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

const brackets = () => insertNativeBracket(createPhase4Document("Bracket unit"), { x: 100, y: 100 }, "round", { x: 260, y: 200 });

describe("bracket pair annotations", () => {
  it("toggles both glyphs, labels only the closing side and keeps both selected", () => {
    const original = brackets();
    const repeat = toggleBracketRepeatUnit(original);
    expect(selectedBracketPair(repeat).every(object => object.repeatUnit)).toBe(true);
    const close = selectedBracketPair(repeat).find(object => object.side === "close")!;
    expect(close.label).toBe("n");
    const edited = setBracketRepeatLabel(repeat, close.id, "m");
    expect(selectedBracketPair(edited).find(object => object.side === "close")!.label).toBe("m");
    expect(edited.selection.objectIds).toEqual(original.selection.objectIds);
    expect(selectedBracketPair(toggleBracketRepeatUnit(edited)).every(object => !object.repeatUnit)).toBe(true);
    expect(createBracketCommands(original).find(action => action.id === "bracket.label.edit")).toMatchObject({ enabled: false, disabledReason: expect.any(String) });
  });
  it("also finds a pair from a selection of either side and refuses unrelated selections", () => {
    const original = brackets();
    const document = applyPatch(original, { op: "setSelection", objectIds: [original.selection.objectIds[1]] });
    expect(selectedBracketPair(document)).toHaveLength(2);
    const unselected = applyPatch(document, { op: "setSelection", objectIds: [] });
    expect(toggleBracketRepeatUnit(unselected)).toBe(unselected);
  });
  it("gives duplicated and pasted pairs independent identities", () => {
    const original = brackets();
    const duplicate = duplicateSelectedDocumentObjects(original);
    const copied = selectedBracketPair(duplicate);
    expect(copied).toHaveLength(2);
    expect(copied[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
    const payload = createSelectionClipboardPayload(original)!;
    const pasted = pasteSelectionClipboardPayload(original, payload, { x: 300, y: 300 });
    expect(selectedBracketPair(pasted)).toHaveLength(2);
    expect(selectedBracketPair(pasted)[0].pairId).not.toBe(selectedBracketPair(original)[0].pairId);
  });
});

describe("repeat-unit graph-export warnings", () => {
  it.each(["square", "round"] as const)("leaves ordinary %s exports unchanged and warns once per repeat pair", async kind => {
    const molecule = applySingleBondToolAtPoint(createPhase4Document("Unit"), { x: 140, y: 140 });
    const plain = insertNativeBracket(molecule, { x: 100, y: 100 }, kind, { x: 260, y: 200 });
    const beforeWarnings: string[] = [];
    const before = copyAsMolfile(plain, "v3000", beforeWarnings);
    expect(beforeWarnings).toEqual([]);
    expect(repeatUnitExportWarnings(plain, "SMILES")).toEqual([]);
    const repeat = applyPatch(toggleBracketRepeatUnit(plain), { op: "setSelection", objectIds: [] });
    expect(repeat.pages[0].objects.filter(object => object.type === "molecule")).toEqual(molecule.pages[0].objects);
    for (const flavor of ["v2000", "v3000"] as const) {
      const warnings: string[] = [];
      const contents = copyAsMolfile(repeat, flavor, warnings);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("does not represent repeat units");
      if (flavor === "v3000") expect(contents).toBe(before);
    }
    const smilesWarnings: string[] = [];
    expect(await copyAsSmiles(repeat, smilesWarnings)).toBe("CC");
    expect(smilesWarnings).toHaveLength(1);
    for (const writer of [exportStructureListSmi, exportStructureListSdf]) {
      const result = await writer(repeat);
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([expect.objectContaining({ code: "export.repeat_unit_not_represented" })]);
    }
    expect(() => copyAsMolfile(repeat, "v3000")).toThrow("does not represent repeat units");
    await expect(copyAsSmiles(repeat)).rejects.toThrow("does not represent repeat units");
  });
});
