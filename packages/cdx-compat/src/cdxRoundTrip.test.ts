import { describe, expect, it } from "vitest";
import { cdxmlFixtures } from "@chemdraft/fixtures";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "../../document-workflow-core/src/index";
import { XMLParser } from "fast-xml-parser";
import { cdxElementFromOrderedTree, cdxElementToCdxml, CDX_NATIVE_ENVELOPE_ATTRIBUTE, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { ChemDraftObjectTags, exportDocumentToCdx, importCdx, openChemDraftPayload, visibleHashForCdxml } from "./index";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const bytesFromCdxml = (xml: string) => writeCdx(tree(xml));
const wrap = (content: string) => `<CDXML CreationProgram="ChemDraft"><page id="1" BoundingBox="0 0 612 792">${content}</page></CDXML>`;
type Node = [number, number, number, string?];
type Edge = [number, number, string?, string?];
const fragment = (nodes: Node[], bonds: Edge[]) => `<fragment id="2">${nodes.map(([element, x, y, attrs = ""], k) => `<n id="${k + 10}" Element="${element}" p="${x} ${y}" ${attrs}/>`).join("")}${bonds.map(([a, b, order = "1", display], k) => `<b id="${k + 100}" B="${a + 10}" E="${b + 10}" Order="${order}"${display ? ` Display="${display}"` : ""}/>`).join("")}</fragment>`;
const ring: Node[] = Array.from({ length: 6 }, (_, k) => [6, 100 + 20 * Math.cos(k * Math.PI / 3), 100 + 20 * Math.sin(k * Math.PI / 3)]);
const ringBonds: Edge[] = Array.from({ length: 6 }, (_, k) => [k, (k + 1) % 6, k % 2 ? "1" : "2"]);
const examples: [string, string, string | undefined][] = [
  ["benzene", wrap(fragment(ring, ringBonds)), "C6H6"],
  ["aspirin", wrap(fragment([...ring, [6, 140, 100], [8, 150, 80], [8, 150, 120], [8, 120, 140], [6, 140, 150], [8, 150, 135], [6, 150, 170]], [...ringBonds, [0, 6], [6, 7, "2"], [6, 8], [1, 9], [9, 10], [10, 11, "2"], [10, 12]])), "C9H8O4"],
  ["lactic acid with wedge", wrap(fragment([[6, 40, 100], [6, 60, 100], [6, 80, 100], [8, 60, 80], [8, 90, 80], [8, 90, 120]], [[0, 1], [1, 2], [1, 3, "1", "WedgeBegin"], [2, 4, "2"], [2, 5]])), "C3H6O3"],
  ["E alkene", wrap(fragment([[6, 40, 80], [6, 60, 100], [6, 80, 100], [6, 100, 120]], [[0, 1], [1, 2, "2"], [2, 3]])), "C4H8"],
  ["Z alkene", wrap(fragment([[6, 40, 80], [6, 60, 100], [6, 80, 100], [6, 100, 80]], [[0, 1], [1, 2, "2"], [2, 3]])), "C4H8"],
  ["quaternary ammonium", wrap(fragment([[7, 60, 100, 'Charge="1"'], [6, 40, 100], [6, 80, 100], [6, 60, 80], [6, 60, 120]], [[0, 1], [0, 2], [0, 3], [0, 4]])), "C4H12N"],
  ["nitrobenzene", wrap(fragment([...ring, [7, 140, 100, 'Charge="1"'], [8, 155, 80], [8, 155, 120, 'Charge="-1"']], [...ringBonds, [0, 6], [6, 7, "2"], [6, 8]])), "C6H5NO2"],
  ["salt pair", wrap(fragment([[11, 40, 100, 'Charge="1"'], [17, 80, 100, 'Charge="-1"']], [])), "ClNa"],
  ["isotope", wrap(fragment([[6, 40, 100, 'Isotope="13"'], [8, 60, 100]], [[0, 1]])), undefined],
  ["radical", wrap(fragment([[6, 40, 100, 'Radical="Doublet"']], [])), undefined],
  ["text", wrap('<t id="4" p="20 30"><s font="3" size="12" face="1">α → β &amp; H₂O</s></t>'), undefined],
  ["reaction arrow with conditions", wrap('<graphic id="3" GraphicType="Line" ArrowType="FullHead" BoundingBox="40 100 120 100"/><t id="4" p="65 80"><s>NaOH, 25 °C</s></t>'), undefined],
  ["equilibrium arrow", wrap('<graphic id="3" GraphicType="Line" ArrowType="Equilibrium" BoundingBox="40 100 120 100"/>'), undefined],
  ["retrosynthesis arrow", wrap('<graphic id="3" GraphicType="Line" ArrowType="RetroSynthetic" BoundingBox="40 100 120 100"/>'), undefined]
];

function requireDocument(result: ReturnType<typeof openChemDraftPayload>): ChemDraftDocument {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  return result.document!;
}

function chemistry(molecule: MoleculeObject) {
  const index = new Map(molecule.atoms.map((atom, k) => [atom.id, k]));
  const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
  return {
    formula: metadata.formula, charge: molecule.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0),
    smiles: nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds),
    atoms: molecule.atoms.map((a) => [a.element, a.formalCharge, a.isotope, a.markRadicals]),
    bonds: molecule.bonds.map((b) => [index.get(b.fromAtomId), index.get(b.toAtomId), b.order, b.stereo, b.display?.bondStyle])
  };
}

function compareDocuments(actual: ChemDraftDocument, expected: ChemDraftDocument) {
  expect(actual.pages).toHaveLength(expected.pages.length);
  for (let p = 0; p < actual.pages.length; p++) {
    const left = actual.pages[p].objects, right = expected.pages[p].objects;
    expect(left.map((x) => x.type)).toEqual(right.map((x) => x.type));
    expect(left.filter((x) => x.type === "text")).toHaveLength(right.filter((x) => x.type === "text").length);
    expect(left.filter((x) => x.type === "reaction-arrow" || x.type === "graphic")).toHaveLength(right.filter((x) => x.type === "reaction-arrow" || x.type === "graphic").length);
    left.forEach((object, k) => {
      const original = right[k];
      if (object.type === "molecule" && original.type === "molecule") {
        expect(chemistry(object)).toEqual(chemistry(original));
        expect(object.atoms).toHaveLength(original.atoms.length);
        expect(object.bonds).toHaveLength(original.bonds.length);
        object.atoms.forEach((atom, j) => {
          expect(atom.x).toBeCloseTo(original.atoms[j].x, 3);
          expect(atom.y).toBeCloseTo(original.atoms[j].y, 3);
        });
      } else if (object.type === "text" && original.type === "text") expect(object.text).toBe(original.text);
      else if (object.type === "graphic" && original.type === "graphic") {
        expect(object.graphicKind).toBe(original.graphicKind);
        expect(object.data.artToolId).toBe(original.data.artToolId);
      }
      expect(object.x).toBeCloseTo(original.x, 2);
      expect(object.y).toBeCloseTo(original.y, 2);
    });
  }
}

describe("chemical and drawing round trips", () => {
  it("imports an independently constructed horizontal arrow with spec z/y/x coordinates", () => {
    const bytes = new Uint8Array(Buffer.from([
      "566A4344303130300403020100000000000000000000", // Header.
      "008000000000", "018001000000", "218003000000", // Document, page, arrow.
      "07020C00000000000000640000007800", // Head: z=0, y=100, x=120.
      "08020C00000000000000640000002800", // Tail: z=0, y=100, x=40.
      "000000000000"
    ].join(""), "hex"));
    const document = requireDocument(importCdx(bytes));
    expect(document.pages[0].objects).toHaveLength(1);
    // CDX points are 1/72 inch; native document coordinates are 1/96 inch.
    expect(document.pages[0].objects[0]).toMatchObject({
      type: "graphic", data: { lineStart: { x: 40 * 4 / 3, y: 100 * 4 / 3 }, lineEnd: { x: 120 * 4 / 3, y: 100 * 4 / 3 } }
    });
  });
  for (const [name, cdxml, formula] of examples) {
    it(`preserves ${name}: CDXML → CDX → native → CDX → CDXML`, () => {
      const original = requireDocument(openChemDraftPayload(cdxml));
      if (formula) {
        const molecules = original.pages[0].objects.filter((x): x is MoleculeObject => x.type === "molecule");
        expect(molecules.map((m) => chemistry(m).formula).join(".")).toBe(formula);
      }
      const initial = requireDocument(importCdx(bytesFromCdxml(cdxml)));
      compareDocuments(initial, original);
      const exported = exportDocumentToCdx(initial, { embedNativePayload: false });
      expect(readCdx(exported.bytes).attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeUndefined();
      const reopened = requireDocument(importCdx(exported.bytes));
      compareDocuments(reopened, initial);
      const viaCdxml = requireDocument(openChemDraftPayload(cdxElementToCdxml(readCdx(exported.bytes))));
      compareDocuments(viaCdxml, initial);
    });
  }

  for (const name of ["single-bond.cdxml", "heteroatom-double.cdxml", "triple-bond.cdxml", "wedge-hash-dash-bold.cdxml", "text-plus-molecule.cdxml", "arrow-heads.cdxml"]) {
    it(`preserves the existing ${name} fixture through CDX`, () => {
      const original = requireDocument(openChemDraftPayload(cdxmlFixtures[name]));
      compareDocuments(requireDocument(importCdx(exportDocumentToCdx(original).bytes)), original);
    });
  }

  it("preserves crossing bonds and warns about payload-only unknown objects", () => {
    const original = requireDocument(openChemDraftPayload(cdxmlFixtures["crossing-bonds.cdxml"]));
    const exported = exportDocumentToCdx(original);
    expect(exported.warnings.some((w) => w.code === "cdxml.object_export_unsupported")).toBe(true);
    const supported = structuredClone(original);
    supported.pages[0].objects = supported.pages[0].objects.filter((x) => x.type !== "unknown-compatibility-object");
    const reopened = requireDocument(importCdx(exported.bytes));
    compareDocuments(reopened, supported);
    expect(reopened.pages[0].crossings).toHaveLength(original.pages[0].crossings.length);
  });

  it("retains isotope, radical and wedge data rather than passing through an empty graph", () => {
    const isotope = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "isotope")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(isotope.atoms[0].isotope).toBe(13);
    const radical = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "radical")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(radical.atoms[0].markRadicals).toBe(1);
    const stereo = requireDocument(importCdx(bytesFromCdxml(examples.find(([n]) => n === "lactic acid with wedge")![1]))).pages[0].objects[0] as MoleculeObject;
    expect(stereo.bonds.some((b) => b.display?.bondStyle?.includes("wedge"))).toBe(true);
  });

  it("preserves a triplet and refuses an unrepresentable singlet instead of changing its electron state", () => {
    const source = wrap(fragment([[6, 40, 100, 'Radical="Triplet"']], []));
    const triplet = requireDocument(importCdx(bytesFromCdxml(source)));
    expect((triplet.pages[0].objects[0] as MoleculeObject).atoms[0].markRadicals).toBe(2);
    compareDocuments(requireDocument(importCdx(exportDocumentToCdx(triplet).bytes)), triplet);
    const refused = importCdx(bytesFromCdxml(source.replace("Triplet", "Singlet")));
    expect(refused.document).toBeUndefined();
    expect(refused.warnings.some((w) => w.code === "cdxml.atom_radical_unsupported")).toBe(true);
  });
});

describe("native payload Save As and interchange Export", () => {
  it.each(["\n", "\r", "\t"])("restores unchanged legacy CDX with %j and still detects visible edits", (character) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const text = original.pages[0].objects[0];
    if (text.type !== "text") throw new Error("Expected text fixture");
    text.text = `before${character}after`;
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const envelope = JSON.parse(Buffer.from(saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3), "hex").toString("utf8"));
    delete saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    const xml = cdxElementToCdxml(saved);
    // The old parser left numeric references literal. Protect their ampersands before
    // using the current canonicalizer to recreate exactly that legacy hash semantics.
    const legacyHash = visibleHashForCdxml(xml.replace(/&#(?:[0-9]+|x[0-9a-fA-F]+);/g, reference => `&amp;${reference.slice(1)}`));
    expect(legacyHash).not.toBe(visibleHashForCdxml(xml));
    envelope.tags.find(([name]: [string, string]) => name === ChemDraftObjectTags.visibleCdxmlHash)[1] = legacyHash;
    saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(saved));
    expect(opened.source).toBe("native-payload");
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);
    expect(opened.document).toEqual(original);

    const findText = (element: CdxElement): CdxElement | undefined => element.name === "s" ? element : element.kids.map(findText).find(Boolean);
    findText(saved)!.text = "edited";
    const edited = importCdx(writeCdx(saved));
    expect(edited.document).toBeUndefined();
    expect(edited.conflict?.embeddedDocument).toEqual(original);
    expect(edited.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "edited" });
    expect(edited.warnings.some(warning => warning.code === "cdx.native_payload_modified")).toBe(true);
    expect(edited.warnings.some(warning => warning.code === "cdxml.visible_layer_modified")).toBe(true);
  });

  it.each([["0700", 0x0700], ["0709", 0x0709]] as const)("detects an edit to only text property 0x%s", (_name, tag) => {
    const original = requireDocument(openChemDraftPayload(wrap('<t id="4" p="20 30"><s>old</s></t>')));
    const bytes = exportDocumentToCdx(original, { embedNativePayload: true }).bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 22, edited = false;
    while (offset < bytes.length) {
      const propertyTag = view.getUint16(offset, true); offset += 2;
      if (!propertyTag) continue;
      if (propertyTag & 0x8000) { offset += 4; continue; }
      let size = view.getUint16(offset, true); offset += 2;
      if (size === 0xffff) { size = view.getUint32(offset, true); offset += 4; }
      if (propertyTag === tag) {
        const runs = view.getUint16(offset, true);
        const start = offset + 2 + 10 * runs;
        expect(new TextDecoder().decode(bytes.subarray(start, offset + size))).toBe("old");
        bytes.set(new TextEncoder().encode("new"), start);
        edited = true;
        break;
      }
      offset += size;
    }
    expect(edited).toBe(true);
    const opened = importCdx(bytes);
    expect(opened.source).toBe("external-cdxml");
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_modified")).toBe(true);
    expect(opened.warnings.some((w) => w.code === "cdxml.visible_layer_modified")).toBe(true);
    if (tag === 0x0709) expect(opened.conflict?.visibleDocument?.pages[0].objects[0]).toMatchObject({ text: "new" });
  });

  it.each(examples)("Save As reopens %s as the identical native document", (_name, xml) => {
    const original = requireDocument(openChemDraftPayload(xml));
    const saved = exportDocumentToCdx(original, { embedNativePayload: true });
    expect(readCdx(saved.bytes).attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeDefined();
    const opened = importCdx(saved.bytes);
    expect(opened.source).toBe("native-payload");
    expect(opened.conflict).toBeUndefined();
    expect(opened.warnings).toEqual([]);
    expect(opened.document).toEqual(original);
  });

  it("handles a native payload longer than 65535 bytes", () => {
    const original = createEmptyDocument();
    original.title = "x".repeat(90_000);
    const opened = importCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    expect(opened.source).toBe("native-payload");
    expect(opened.document).toEqual(original);
  });

  it("Export omits all native metadata and the user-defined property", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const exported = exportDocumentToCdx(original, { embedNativePayload: false });
    expect(cdxElementToCdxml(readCdx(exported.bytes))).not.toContain("org.chemdraft/");
    expect(importCdx(exported.bytes).source).toBe("external-cdxml");
  });

  it("detects visible edits without trusting stale embedded chemistry", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const find = (x: CdxElement): CdxElement | undefined => x.name === "n" ? x : x.kids.map(find).find(Boolean);
    find(saved)!.attrs.Charge = "1";
    const opened = importCdx(writeCdx(saved));
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdxml.visible_layer_modified")).toBe(true);
  });

  it("warns about a malformed native envelope and still imports the visible subset", () => {
    const root = tree(examples[0][1]); root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = "|x|7B";
    const opened = importCdx(writeCdx(root));
    expect(opened.document).toBeDefined();
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_invalid")).toBe(true);
  });

  it("requires conflict review for an older envelope without a binary integrity hash", () => {
    const original = requireDocument(openChemDraftPayload(examples[0][1]));
    const saved = readCdx(exportDocumentToCdx(original, { embedNativePayload: true }).bytes);
    const encoded = saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE].slice(3);
    const envelope = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
    delete envelope.visibleBinaryHash;
    saved.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${Buffer.from(JSON.stringify(envelope)).toString("hex")}`;
    const opened = importCdx(writeCdx(saved));
    expect(opened.source).toBe("external-cdxml");
    expect(opened.document).toBeUndefined();
    expect(opened.conflict?.embeddedDocument).toEqual(original);
    expect(opened.warnings.some((w) => w.code === "cdx.native_payload_modified")).toBe(true);
  });
});
