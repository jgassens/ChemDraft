// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { structureTemplates } from "@chemdraft/template-library";
import { nativeBondOrderResolution, nativeMoleculeBondDrawingStyle, representativeMoleculeBondLength } from "@chemdraft/layout-engine";
import { insertStructureTemplate } from "./structureTemplateInsertion";
import { applyMoleculeBaseStylePatch, applySingleBondToolAtNativeAtom, applyNativeRingAttachAtAtomTarget } from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { installDomRdkitLoader } from "./testSupport/rdkitIdentity";
import { DOM_COMMAND_EVENT } from "./window-manager";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => createElement("canvas") }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

const perspectiveTemplates = structureTemplates.filter(template => template.projection === "perspective");
const molecule = (document: ChemDraftDocument) => document.pages[0]!.objects[0] as MoleculeObject;
let rdkit: Awaited<ReturnType<typeof ensureRdkit>>;
beforeAll(async () => {
  installDomRdkitLoader();
  rdkit = await ensureRdkit();
}, 60_000);

function identity(object: MoleculeObject) {
  const parsed = rdkit.get_mol(moleculeToMolfileV2000(object, {
    fromDocFrame: true,
    kekuleBondOrders: nativeBondOrderResolution(object.atoms, object.bonds).kekuleOrders
  }).contents)!;
  expect(parsed).toBeTruthy();
  try {
    // The vendored engine exposes atom CIP and bond E/Z descriptors. Compare
    // both explicitly, as well as its canonical isomeric SMILES (the default).
    const tags = JSON.parse((parsed as typeof parsed & { get_stereo_tags(): string }).get_stereo_tags()) as {
      CIP_atoms?: [number, string][]; CIP_bonds?: [number, number, string][];
    };
    return { smiles: parsed.get_smiles!(), ...compositionFromRdkitJson(JSON.parse(parsed.get_json!()) as RdkitJson),
      stereo: { atoms: tags.CIP_atoms ?? [], bonds: tags.CIP_bonds ?? [] } };
  } finally { parsed.delete(); }
}

function lengths(object: MoleculeObject, bonds = object.bonds) {
  const atoms = new Map(object.atoms.map(atom => [atom.id, atom]));
  return bonds.map(bond => {
    const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  });
}
function inserted(id: string, bondLengthPx: number) {
  const document = createEmptyDocument();
  document.styles.drawing = { bondLengthPx };
  return insertStructureTemplate(document, id, { x: 390, y: 300 }).document;
}

function attachRing(target: number, projection = true) {
  const document = structuredClone(inserted("p-tert-butylcalix-4-arene", target)), before = molecule(document);
  if (!projection) delete before.style.projection;
  const methyl = before.atoms.filter(atom => atom.element === "C" && before.bonds
    .filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 1)
    .sort((a, b) => b.x - a.x)[0]!;
  const after = molecule(applyNativeRingAttachAtAtomTarget(document,
    { kind: "atom", objectId: before.id, atomId: methyl.id, distanceToPointer: 0 }, "cyclohexane"));
  return { before, after, added: after.bonds.filter(bond => !before.bonds.some(old => old.id === bond.id)) };
}

describe("bold width on an inserted perspective template", () => {
  it.each(perspectiveTemplates.flatMap(template => [22, 30].map(length => [template.id, length] as const)))(
    "%s: the molecule inspector changes effective bold width at %i px", (id, target) => {
      const document = inserted(id, target), before = molecule(document);
      const boldBonds = before.bonds.filter(bond => bond.display?.bondStyle === "bold");
      expect(boldBonds.length).toBeGreaterThan(0);
      // A per-bond width would mask the inspector's whole-molecule Bold width patch.
      expect(before.style).not.toHaveProperty("bondBoldWidths");
      expect(before.style.bondBoldWidthPx).toBe(0.136 * target);
      for (const bond of boldBonds) {
        expect(nativeMoleculeBondDrawingStyle(before, bond.id).bondBoldWidthPx).toBe(0.136 * target);
      }
      const after = molecule(applyMoleculeBaseStylePatch(document, [before.id], { bondBoldWidthPx: 5 }));
      expect(after.style).not.toHaveProperty("bondBoldWidths");
      for (const bond of boldBonds) {
        expect(nativeMoleculeBondDrawingStyle(after, bond.id).bondBoldWidthPx).toBe(5);
      }
      expect(after.atoms).toEqual(before.atoms);
      expect(after.bonds).toEqual(before.bonds);
      expect(after.structure).toBe(before.structure);
    }
  );
});

describe("calixarene bold depth cues are cosmetic", () => {
  it.each(perspectiveTemplates)("$id: plain twin and real CDXML round-trips preserve chemistry and stereo", template => {
    const document = inserted(template.id, 22), original = molecule(document);
    const boldIndices = original.bonds.flatMap((bond, index) => bond.display?.bondStyle === "bold" ? [index] : []);
    expect(boldIndices.length).toBeGreaterThan(0);
    const plain = structuredClone(original);
    delete plain.style.bondBoldWidthPx;
    for (const bond of plain.bonds) if (bond.display?.bondStyle === "bold") {
      delete bond.display.bondStyle;
      if (!Object.keys(bond.display).length) delete bond.display;
    }
    expect(plain.style).not.toHaveProperty("bondBoldWidthPx");
    expect(plain.bonds.every(bond => bond.display?.bondStyle !== "bold")).toBe(true);
    const originalIdentity = identity(original);
    expect(originalIdentity.formula).toBe(template.formula);
    expect(originalIdentity.formalCharge).toBe(template.charge);
    expect(originalIdentity.stereo).toEqual({ atoms: [], bonds: [] });
    expect(identity(plain)).toEqual(originalIdentity);

    const exported = exportDocumentToCdxml(document);
    expect(exported.warnings).toEqual([]);
    // Exercise visible CDXML too: reopening only the embedded native payload
    // could hide a writer/reader conversion of cosmetic Bold to wedge/hash.
    const visible = canonicalVisibleCdxml(exported.contents);
    expect([...visible.matchAll(/<b\b[^>]*\bDisplay="([^"]+)"/g)].map(match => match[1]))
      .toEqual(boldIndices.map(() => "Bold"));
    for (const [contents, source] of [[exported.contents, "native-payload"], [visible, "external-cdxml"]] as const) {
      const reopened = openChemDraftPayload(contents);
      expect(reopened.source).toBe(source);
      expect(reopened.warnings.map(warning => warning.code)).toEqual(source === "native-payload" ? [] : [
        "cdxml.external_subset_imported", "cdxml.structure_string_not_derived"
      ]);
      expect(reopened.conflict).toBeUndefined();
      expect(reopened.document).toBeDefined();
      const roundTripped = molecule(reopened.document!);
      expect(roundTripped.atoms).toHaveLength(original.atoms.length);
      expect(roundTripped.bonds).toHaveLength(original.bonds.length);
      expect(identity(roundTripped)).toEqual(originalIdentity);
      // This writer preserves Bold; every original bold bond must remain Bold,
      // and no bond may acquire any other display (including wedge or hash).
      expect(roundTripped.bonds.map(bond => bond.display?.bondStyle))
        .toEqual(original.bonds.map(bond => bond.display?.bondStyle));
      for (const index of boldIndices) expect(roundTripped.bonds[index]!.display?.bondStyle).toBe("bold");
    }
  });
});

describe("growth on an inserted perspective template", () => {
  it.each(perspectiveTemplates.flatMap(template => [22, 30].map(length => [template.id, length] as const)))(
    "%s: a new single bond uses the document's %i px length", (id, target) => {
      const document = inserted(id, target), before = molecule(document);
      const template = perspectiveTemplates.find(entry => entry.id === id)!;
      const ordinary = before.bonds.filter((_, index) => {
        const [a, b] = template.layout.bonds[index]!;
        return !template.layout.stretchedBonds?.some(([c, d]) => a === c && b === d || a === d && b === c);
      });
      expect(Math.abs(Math.max(...lengths(before, ordinary)) - target)).toBeLessThan(1e-9);
      expect(representativeMoleculeBondLength(before)).toBeLessThan(target * 0.99);
      expect(before.style.bondLengthPx).toBe(target);
      // The outermost available carbon provides room for a real, automatically planned
      // sprout. Exercise the actual tool; never hand it a plan with a fabricated length.
      const candidates = before.atoms.filter(atom => atom.element === "C" && before.bonds
        .filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id)
        .reduce((sum, bond) => sum + (bond.order === "double" ? 2 : 1), 0) < 4)
        .sort((a, b) => b.x - a.x);
      const after = candidates.map(atom => molecule(applySingleBondToolAtNativeAtom(document,
        { kind: "atom", objectId: before.id, atomId: atom.id, distanceToPointer: 0 })))
        .find(result => result.atoms.length === before.atoms.length + 1);
      expect(after, "a real bond sprout must succeed").toBeDefined();
      const added = after!.bonds.filter(bond => !before.bonds.some(old => old.id === bond.id));
      expect(added).toHaveLength(1);
      expect(Math.abs(lengths(after!, added)[0]! - target)).toBeLessThan(1e-9);
    }
  );

  it.each([22, 30])("a ring attached to a projected template uses %i px bonds", target => {
    const { after, added } = attachRing(target);
    // Attached ring coordinates are rounded to 0.001 px by the existing tool.
    for (const length of lengths(after, added)) expect(Math.abs(length - target)).toBeLessThan(0.002);
  });

  it("an unmarked molecule still attaches rings at its measured median", () => {
    const { before, after, added } = attachRing(30, false);
    const measured = representativeMoleculeBondLength(before)!;
    expect(measured).toBeLessThan(30 * 0.99);
    expect(added).toHaveLength(6);
    for (const length of lengths(after, added)) expect(Math.abs(length - measured)).toBeLessThan(0.002);
  });

  it.each([22, 30])("the %i px ring regression exercises a successful attachment", target => {
    const { before, after, added } = attachRing(target);
    expect(after.atoms).toHaveLength(before.atoms.length + 5);
    expect(added).toHaveLength(6);
    expect(lengths(after, added).every(length => Number.isFinite(length) && length > 0)).toBe(true);
    // A refused attachment must not vacuously satisfy the bond-length checks.
    expect(after.style.bondLengthPx).toBe(target);
  });
});

describe("Clean Up of an inserted perspective template", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function command(commandId: string) {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } }));
    });
  }
  it.each(perspectiveTemplates)("$id: preserves identity in one undo step and restores exact coordinates", async template => {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: createEmptyDocument(), initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: false
    })));
    const current = () => getAssistantHistoryPort().read("initial")!;
    const status = () => container.querySelector("[role=status]")?.textContent;
    await command(`template.insert.${template.id}`);
    const before = molecule(current()), beforeIdentity = identity(before);
    expect(before.style.projection).toBe("perspective");
    expect(beforeIdentity.formula).toBe(template.formula);
    expect(beforeIdentity.formalCharge).toBe(template.charge);
    await command("structure.cleanup2d");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(status()).toMatch(/^Cleaned up selected structure/);
    }, { timeout: 15_000 });
    const after = molecule(current());
    expect(after.style).not.toHaveProperty("projection");
    expect(after.atoms.map(({ x, y }) => [x, y])).not.toEqual(before.atoms.map(({ x, y }) => [x, y]));
    expect(identity(after)).toEqual(beforeIdentity);
    expect(after.atoms).toHaveLength(before.atoms.length);
    expect(after.bonds).toHaveLength(before.bonds.length);
    await command("edit.undo");
    expect(molecule(current())).toEqual(before);
    await command("edit.undo");
    expect(status()).toBe(`Undid Insert ${template.name}`);
    expect(current().pages[0]!.objects).toHaveLength(0);
    await command("edit.redo");
    expect(molecule(current())).toEqual(before);
    await command("edit.redo");
    expect(molecule(current())).toEqual(after);
  }, 20_000);
});
