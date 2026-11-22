import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { Molecule } from "openchemlib";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { OfficeImportError, pngWithChemDraftSelection, type OfficeImportResult, type OfficeStructure } from "@chemdraft/clipboard-adapter";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { buildAppMenuModel, flattenAppMenuCommands, nativeRoutedCommandIds } from "./appMenu";
import {
  createPhase4Document, createSelectionClipboardPayload, insertNativeMolfileMolecule, selectionBounds,
  serializeSelectionClipboardPayload,
} from "./documentWorkflow";
import {
  checkOfficeStructure, IMPORT_OFFICE_STRUCTURES_COMMAND_ID, IMPORT_OFFICE_STRUCTURES_UNDO_LABEL, importOfficeStructuresCommand,
  OFFICE_IMPORT_FILE_FILTERS, planOfficeStructureImport, runOfficeStructureImport,
} from "./officeStructureImport";

vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn(), open: vi.fn() }));

const canonical = (molecule: MoleculeObject) => Molecule.fromMolfile(moleculeToMolfileV2000(molecule, {
  fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders,
}).contents).toIsomericSmiles();
const molecules = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

/** A drawing as ChemDraft copies it: the carrier JSON of one selected molecule. */
function drawing(smiles: string): { json: string; smiles: string } {
  const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 200, y: 200 },
    depictSmiles2D(smiles).molfile, "molfile-v2000");
  const json = serializeSelectionClipboardPayload(createSelectionClipboardPayload(document)!);
  return { json, smiles: canonical(molecules(document)[0]!) };
}

function structure(json: string, slide: number, picture = slide): OfficeStructure {
  return { picture, source: { kind: "slide", slide }, location: `slide ${slide}`, mediaPart: `ppt/media/image${picture}.png`,
    json, document: JSON.parse(json) as Record<string, unknown> };
}

function result(structures: OfficeStructure[], warnings: OfficeImportResult["warnings"] = []): OfficeImportResult {
  return { kind: "powerpoint", structures, warnings, notes: [], picturesChecked: structures.length + warnings.length };
}

const alanine = drawing("C[C@H]([NH3+])C(=O)[O-]");
const labelled = drawing("[13CH3]C#N");
const pyridinium = drawing("C[n+]1ccccc1");

describe("Office structure chemistry check", () => {
  it("accepts a carrier whose chemistry survives the native reader and a save and reload", () => {
    const check = checkOfficeStructure(structure(alanine.json, 1));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const [molecule] = molecules({ ...createPhase4Document(), pages: [{ ...createPhase4Document().pages[0]!, objects: check.payload.objects }] });
    expect(canonical(molecule!)).toBe(alanine.smiles);
    expect(molecule!.atoms.map((atom) => atom.formalCharge ?? 0).sort()).toEqual([-1, 0, 0, 0, 0, 1]);
    // The stereocenter is drawn with a wedge or hash, and the canonical SMILES keeps it.
    expect(molecule!.bonds.some((bond) => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed")).toBe(true);
    expect(alanine.smiles).toContain("@");
  });

  it("refuses a drawing the native reader would shrink, and one it cannot read", () => {
    const raw = JSON.parse(alanine.json) as { objects: { atoms: unknown[] }[] };
    raw.objects[0]!.atoms.push({ id: "phantom" });
    // The JSON the reader sees is unchanged; the raw record claims one more atom than it keeps.
    expect(checkOfficeStructure({ json: alanine.json, document: raw as unknown as Record<string, unknown> }))
      .toEqual({ ok: false, reason: "reading it would drop atoms, bonds or structures" });
    const garbage = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [{ type: "molecule", atoms: 3 }],
      selectionIds: [], bounds: { x: 0, y: 0, width: 1, height: 1 } });
    expect(checkOfficeStructure(structure(garbage, 1))).toEqual({ ok: false, reason: "its drawing data could not be read" });
  });

  it("lays out the carrier by its real extent, not the bounds it claims", () => {
    const lying = JSON.parse(alanine.json) as { bounds: Record<string, number> };
    lying.bounds = { x: 0, y: 0, width: 1e9, height: 1e9, centerX: 5e8, centerY: 5e8 };
    const check = checkOfficeStructure(structure(JSON.stringify(lying), 1));
    expect(check.ok && check.payload.bounds.width).toBeLessThan(1000);
  });
});

describe("planning an Office import", () => {
  it("inserts every valid structure left to right without overlap, keeps their chemistry, and selects them", () => {
    const start = insertNativeMolfileMolecule(createPhase4Document(), { x: 150, y: 150 }, depictSmiles2D("CCO").molfile, "molfile-v2000");
    const warning = { picture: 4, source: { kind: "slide", slide: 3 } as const, location: "slide 3", reason: "malformed" as const,
      message: "The structure on slide 3 has damaged ChemDraft data: PNG iTXt CRC mismatch." };
    const outcome = planOfficeStructureImport(start, "Slides.pptx",
      result([structure(alanine.json, 1), structure(labelled.json, 2), structure(pyridinium.json, 2, 3)], [warning]));

    expect(outcome.message).toBe("Imported 3 structures from Slides.pptx. Skipped 1: 1 has damaged ChemDraft data.");
    expect(outcome).toMatchObject({ inserted: 3, skipped: 1 });
    expect(outcome.details).toEqual([warning.message]);
    const next = outcome.document!;
    // The existing structure is untouched; the three new ones follow in document order.
    expect(next.pages[0]!.objects[0]).toEqual(start.pages[0]!.objects[0]);
    const added = molecules(next).slice(1);
    expect(added.map(canonical)).toEqual([alanine.smiles, labelled.smiles, pyridinium.smiles]);
    expect(added[1]!.atoms.some((atom) => atom.isotope === 13)).toBe(true);
    expect([...next.selection.objectIds].sort()).toEqual(added.map((molecule) => molecule.id).sort());

    const boxes = added.map((molecule) => selectionBounds(next.pages[0]!.objects, [molecule.id])!);
    const existing = selectionBounds(start.pages[0]!.objects, start.pages[0]!.objects.map((object) => object.id))!;
    for (const [index, box] of boxes.entries()) {
      expect(box.y).toBeGreaterThan(existing.y + existing.height);
      const previous = boxes[index - 1];
      if (previous) expect(box.x).toBeGreaterThanOrEqual(previous.x + previous.width);
    }
  });

  it("says plainly when no structures were found, or when all were skipped", () => {
    const empty = createPhase4Document();
    expect(planOfficeStructureImport(empty, "Report.docx", { ...result([]), kind: "word" })).toMatchObject({
      message: "No ChemDraft structures were found in Report.docx. Only pictures placed from ChemDraft can be imported.",
      document: undefined, inserted: 0,
    });
    const newer = { picture: 1, source: { kind: "paragraph", paragraph: 2 } as const, location: "paragraph 2",
      reason: "unknown-version" as const, message: "The structure on paragraph 2 was made by a newer or unknown ChemDraft (data version 2)." };
    const garbage = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [{ type: "molecule" }], selectionIds: [],
      bounds: { x: 0, y: 0, width: 1, height: 1 } });
    const outcome = planOfficeStructureImport(empty, "Report.docx", result([structure(garbage, 1)], [newer]));
    expect(outcome.message).toBe("No structures were imported from Report.docx. Skipped 2: " +
      "1 was made by a newer or unknown version of ChemDraft, 1 failed the chemistry check.");
    expect(outcome.document).toBeUndefined();
    expect(outcome.details[1]).toBe("The structure on slide 1 was not imported: its drawing data could not be read.");
  });
});

// A stored-only ZIP is enough for the end-to-end command test.
function storedZip(entries: [name: string, data: Uint8Array | string][]): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [entryName, entryData] of entries) {
    const name = Buffer.from(entryName);
    const data = Buffer.from(entryData);
    const header = (size: number, signature: number) => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt32LE(signature);
      return buffer;
    };
    const local = header(30, 0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = header(46, 0x02014b50);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    directory.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, central, end]));
}

function deck(jsons: string[]): Uint8Array {
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const rels = (items: [string, string, string][]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
  const png = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>').render().asPng());
  const pictures = jsons.map((_, index) => `<p:pic><p:nvPicPr><p:cNvPr id="${index + 2}" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rId${index + 1}"/></p:blipFill><p:spPr/></p:pic>`).join("");
  return storedZip([
    ["_rels/.rels", rels([["rId1", "officeDocument", "ppt/presentation.xml"]])],
    ["ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", rels([["rId1", "slide", "slides/slide1.xml"]])],
    ["ppt/slides/slide1.xml", `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${pictures}</p:spTree></p:cSld></p:sld>`],
    ["ppt/slides/_rels/slide1.xml.rels", rels(jsons.map((_, index) => [`rId${index + 1}`, "image", `../media/image${index + 1}.png`]))],
    ...jsons.map((json, index): [string, Uint8Array] => [`ppt/media/image${index + 1}.png`, pngWithChemDraftSelection(png, json)]),
  ]);
}

describe("the Import Structures command", () => {
  function harness(file: { name: string; bytes: Uint8Array } | undefined) {
    let document = createPhase4Document();
    const commit = vi.fn((next: ChemDraftDocument) => { document = next; return true; });
    const report = vi.fn();
    const deps = {
      pickFile: vi.fn(async () => file && { name: file.name, read: async () => file.bytes }),
      getDocument: () => document,
      commit,
      report,
    };
    return { deps, commit, report, current: () => document };
  }

  it("reads a real .pptx, inserts every structure as one labelled undo entry, and reports it", async () => {
    const { deps, commit, report, current } = harness({ name: "Slides.pptx", bytes: deck([alanine.json, labelled.json, pyridinium.json]) });
    const outcome = await runOfficeStructureImport(deps);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(outcome!.document, IMPORT_OFFICE_STRUCTURES_UNDO_LABEL);
    expect(report).toHaveBeenCalledWith("Imported 3 structures from Slides.pptx.", []);
    expect(molecules(current()).map(canonical)).toEqual([alanine.smiles, labelled.smiles, pyridinium.smiles]);
  });

  it("commits nothing when canceled, when nothing is found, or when the file is refused", async () => {
    const canceled = harness(undefined);
    await runOfficeStructureImport(canceled.deps);
    expect(canceled.commit).not.toHaveBeenCalled();
    expect(canceled.report).toHaveBeenCalledWith("Import canceled", []);

    const none = harness({ name: "Plain.pptx", bytes: deck([]) });
    await runOfficeStructureImport(none.deps);
    expect(none.commit).not.toHaveBeenCalled();
    expect(none.report).toHaveBeenCalledWith(
      "No ChemDraft structures were found in Plain.pptx. Only pictures placed from ChemDraft can be imported.", []);

    const refused = harness({ name: "Notes.txt", bytes: new TextEncoder().encode("hello") });
    await runOfficeStructureImport(refused.deps);
    expect(refused.commit).not.toHaveBeenCalled();
    expect(refused.report).toHaveBeenCalledWith(
      "Could not import structures from Notes.txt: The file is not a Word (.docx) or PowerPoint (.pptx) file.", []);

    const bomb = harness({ name: "Bomb.pptx", bytes: deck([alanine.json]) });
    await runOfficeStructureImport({ ...bomb.deps, importStructures: async () => {
      throw new OfficeImportError("too-large", "The file expands beyond the limits for importing structures.", "ZIP exceeds 200 MB inflated.");
    } });
    expect(bomb.commit).not.toHaveBeenCalled();
    expect(bomb.report).toHaveBeenCalledWith("Could not import structures from Bomb.pptx: The file expands beyond the limits for importing structures.",
      ["ZIP exceeds 200 MB inflated."]);
  });

  it("is a registered File menu command on both platforms, routed by the native menu and the document window", () => {
    for (const platform of ["macos", "windows"] as const) {
      const model = buildAppMenuModel({ platform, rulersVisible: false, crosshairsVisible: false, canUndo: false, canRedo: false,
        hasSelection: false, hasSelectedMolecule: false, toolbars: [] });
      const file = flattenAppMenuCommands(model.filter((section) => section.id === "file"));
      const index = file.findIndex((item) => item.commandId === IMPORT_OFFICE_STRUCTURES_COMMAND_ID);
      expect(file[index - 1]?.commandId).toBe("document.open");
      expect(file[index]).toMatchObject({ label: "Import Structures from Word or PowerPoint…", enabled: true });
      expect(nativeRoutedCommandIds(model)).toContain(IMPORT_OFFICE_STRUCTURES_COMMAND_ID);
    }
    expect(importOfficeStructuresCommand).toMatchObject({ id: "document.importOfficeStructures", source: "core" });
    expect(OFFICE_IMPORT_FILE_FILTERS).toEqual([{ name: "Word or PowerPoint", extensions: ["docx", "pptx"] }]);

    const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const routed = rust.split("const MENU_COMMAND_IDS: &[&str] = &[")[1]!.split("];")[0]!;
    expect(routed).toContain('"document.importOfficeStructures"');
    // One native File menu item, outside any cfg branch, so macOS and Windows both build it.
    const item = rust.match(/&MenuItem::with_id\(\s*app,\s*"document\.importOfficeStructures",\s*"([^"]+)",\s*true,\s*None::<&str>,?\s*\)\?,/);
    expect(item?.[1]).toBe("Import Structures from Word or PowerPoint…");
    const before = rust.slice(0, item!.index!).split("\n").slice(-3).join("\n");
    expect(before).not.toContain("#[cfg");

    const window = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");
    const handler = window.split("register(importOfficeStructuresCommand")[1]!.split("\n    });")[0]!;
    expect(handler).toContain("runOfficeStructureImport(");
    expect(handler).toContain("commit: (next, undoLabel) => commitDocumentChange(next, undoLabel)");
    expect(handler).toContain("pickOfficeImportFile(nativePathBasename)");
  });
});
