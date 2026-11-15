import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeDocument, moleculeToMolfileV3000, serializeDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { canonicalVisibleCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { objectColorForCommand, objectCustomColorCommandId, textColorForCommand, textCustomColorCommandId } from "./commands";
import { applyToolbarColorToSelection, createPhase4Document, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg, insertNativeArtGraphicObject, insertNativeSingleBondMolecule, insertNativeTextObject } from "./documentWorkflow";

const colors = ["#12ab34", "#0a0b0c", "#1f5fbf"] as const;
const targets = ["molecule", "text", "range", "arrow", "rect"] as const;
type Target = typeof targets[number];

function colored(target: Target, color: string) {
  let document = createPhase4Document("Color exports");
  if (target === "molecule") {
    document = insertNativeSingleBondMolecule(document, { x: 100, y: 100 });
    // Oxygen has a visible label, unlike an implicit carbon.
    const mol = document.pages[0].objects[0] as MoleculeObject;
    document = { ...document, pages: [{ ...document.pages[0], objects: [{ ...mol, atoms: mol.atoms.map((atom, i) => i === 0 ? { ...atom, element: "O" } : atom) }] }] };
  } else if (target === "text" || target === "range") {
    document = insertNativeTextObject(document, { x: 100, y: 100 }, "H2O");
  } else if (target === "arrow") {
    document = insertNativeArtGraphicObject(document, { x: 100, y: 100 }, "tool.art.reactionArrow");
  } else {
    document = insertNativeArtGraphicObject(document, { x: 100, y: 100 }, "tool.art.rect");
  }
  const original = document;
  const object = document.pages[0].objects[0];
  const text = target === "text" || target === "range";
  const id = color === "#1f5fbf" ? (text ? "text.color.blue" : "object.color.blue") : (text ? textCustomColorCommandId(color) : objectCustomColorCommandId(color));
  const resolved = text ? textColorForCommand(id) : objectColorForCommand(id);
  expect(resolved).toBe(color);
  const selection = target === "molecule" && object.type === "molecule"
    ? { objectIds: [], moleculePart: { objectId: object.id, kind: "parts" as const, atomIds: [object.atoms[0].id], bondIds: [object.bonds[0].id] } }
    : target === "range" ? { objectIds: [], textRange: { objectId: object.id, range: { start: 1, end: 2 } } }
    : { objectIds: [object.id] };
  const result = applyToolbarColorToSelection(document, resolved!, selection);
  expect(result.changed).toBe(true);
  return { original, document: result.document };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(colors)("toolbar color %s", color => {
  it.each(targets)("preserves %s in native serialization", target => {
    const { document } = colored(target, color);
    const reopened = deserializeDocument(serializeDocument(document));
    expect(reopened.pages[0].objects).toEqual(document.pages[0].objects);
    expect(JSON.stringify(reopened.pages[0].objects)).toContain(color);
    if (target === "molecule") {
      const molecule = reopened.pages[0].objects[0] as MoleculeObject;
      expect(molecule.style.atomLabelColors).toMatchObject({ [molecule.atoms[0].id]: color });
      expect(molecule.style.bondColors).toMatchObject({ [molecule.bonds[0].id]: color });
    }
  });
  it.each(targets)("renders %s in SVG", async target => {
    expect((await exportPhase4Svg(colored(target, color).document)).contents.toLowerCase()).toContain(color);
  });
  it.each(targets)("renders %s in PDF", async target => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
    for (const key of ["window", "document", "Node", "Element", "SVGElement", "HTMLElement", "XMLSerializer", "DOMParser", "navigator"] as const) {
      vi.stubGlobal(key, key === "window" ? dom.window : dom.window[key]);
    }
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 }) });
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
    const pdf = await exportPhase4Pdf(colored(target, color).document, { compress: false });
    const content = new TextDecoder("latin1").decode(pdf.bytes);
    const rgb = color.match(/\w\w/g)!.map(value => Number.parseInt(value, 16) / 255);
    const values = [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)];
    expect(values.some(match => rgb.every((channel, i) => Math.abs(Number(match[i + 1]) - channel) <= 0.0051))).toBe(true);
  });
  it.each(targets)("writes and references %s in the CDXML color table", target => {
    const xml = canonicalVisibleCdxml(exportPhase4Cdxml(colored(target, color).document).contents);
    const table = xml.match(/<colortable>([\s\S]*?)<\/colortable>/)![1];
    const entries = [...table.matchAll(/<color\b[^>]*>/g)].map(match => match[0]);
    const rgb = color.match(/\w\w/g)!.map(value => Number.parseInt(value, 16));
    const index = entries.findIndex(entry => ["r", "g", "b"].every((channel, i) => Math.round(Number(entry.match(new RegExp(`${channel}="([^"]+)"`))?.[1]) * 255) === rgb[i]));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(xml.slice(xml.indexOf("</colortable>") + 13)).toContain(`color="${index + 2}"`);
  });
  it.each(targets)("reimports %s color from visible CDXML", target => {
    const xml = canonicalVisibleCdxml(exportPhase4Cdxml(colored(target, color).document).contents);
    const reopened = openChemDraftPayload(xml);
    expect(reopened.source).toBe("external-cdxml");
    expect(JSON.stringify(reopened.document?.pages[0].objects).toLowerCase()).toContain(color);
  });
  it("preserves molecule chemistry", async () => {
    installNodeRdkitModuleLoader();
    const { original, document } = colored("molecule", color);
    const before = original.pages[0].objects[0] as MoleculeObject;
    const after = document.pages[0].objects[0] as MoleculeObject;
    const smiles = async (molecule: MoleculeObject) => (await computeStructureIdentifiers(moleculeToMolfileV3000(molecule, { kekuleBondOrders: new Map(), fromDocFrame: true }).contents))?.smiles;
    expect(await smiles(before)).toBeTruthy();
    expect(await smiles(after)).toBe(await smiles(before));
    expect(after.atoms).toHaveLength(before.atoms.length);
    expect(after.bonds).toHaveLength(before.bonds.length);
  });
});
