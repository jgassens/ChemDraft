// Bug cdxml-export-quadratic-lone-pairs: writing attached lone pairs to CDXML scanned the whole
// fragment once per pair (and the source atom-id map once per atom), so one fragment of N
// lone-pair atoms cost O(N^2): about 30 s at 10,000 on a laptop. Session autosave writes the file
// right after it opens, so a huge or crafted CDXML hung the app with no click.
//
// The bounds below are loose (the fixed export takes well under a second at 10,000); they exist to
// catch a return to quadratic cost, not to benchmark.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

/** One fragment of `count` oxygen atoms, each with an attached lone pair, on a 100-wide grid. */
function oxygenGrid(count: number): string {
  const atoms: string[] = [], pairs: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 100) * 30, y = Math.floor(i / 100) * 30;
    atoms.push(`<n id="${1000 + i}" p="${x} ${y}" Element="8"/>`);
    pairs.push(`<graphic id="${100000 + i}" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="${x + 10} ${y} ${x + 13} ${y}">` +
      `<represent object="${1000 + i}" attribute="Radical"/></graphic>`);
  }
  return `<CDXML><page><fragment id="5">${atoms.join("")}</fragment>${pairs.join("")}</page></CDXML>`;
}

/** The export a plain (no embedded native payload) Save As writes, which is all the CDXML carries. */
const plain = (document: NonNullable<ReturnType<typeof openChemDraftPayload>["document"]>) =>
  exportDocumentToCdxml(document, { embedNativePayload: false });

const marksOf = (document: NonNullable<ReturnType<typeof openChemDraftPayload>["document"]>) =>
  document.pages[0]!.objects.filter((o): o is ElectronMarkObject => o.type === "electron-mark");

describe("CDXML lone pairs at scale", () => {
  it("exports and reads back 10,000 lone-pair atoms in one fragment in linear time", () => {
    const opened = openChemDraftPayload(oxygenGrid(10000));
    expect(opened.document).toBeDefined();
    const started = performance.now();
    const saved = plain(opened.document!);
    const exportMs = performance.now() - started;
    expect(exportMs).toBeLessThan(5000);
    // Every pair is written, attached to its own atom.
    expect(saved.contents.match(/SymbolType="LonePair"/g)).toHaveLength(10000);
    const references = [...saved.contents.matchAll(/<represent object="(\d+)" attribute="Radical"\/>/g)].map(m => m[1]);
    expect(references).toHaveLength(10000);
    expect(new Set(references).size).toBe(10000);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.electron_mark_appearance_payload_only");

    // The reverse path (File > Open) is linear too, and finds every pair again on its atom.
    const reopenStarted = performance.now();
    const reopened = openChemDraftPayload(saved.contents);
    const reopenMs = performance.now() - reopenStarted;
    expect(reopenMs).toBeLessThan(5000);
    const marks = marksOf(reopened.document!);
    expect(marks).toHaveLength(10000);
    expect(marks.every(m => m.markKind === "lone-pair" && m.anchor.kind === "atom")).toBe(true);
    const molecule = reopened.document!.pages[0]!.objects.find((o): o is MoleculeObject => o.type === "molecule")!;
    expect(molecule.atoms).toHaveLength(10000);
    expect(new Set(marks.map(m => m.anchor.kind === "atom" ? m.anchor.atomId : "")).size).toBe(10000);
  }, 60000);

  it("keeps each lone pair's chemistry and canonical SMILES through export and reopen", async () => {
    // 100 dimethyl ethers plus an ammonium-ethyl-oxide in one fragment (charges on N and O); each
    // ether oxygen and the oxide oxygen carries an attached lone pair.
    const atoms: string[] = [], bonds: string[] = [], pairs: string[] = [];
    let id = 1000;
    const pair = (atom: number, x: number, y: number) => pairs.push(
      `<graphic id="${id++}" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="${x + 10} ${y} ${x + 13} ${y}"><represent object="${atom}" attribute="Radical"/></graphic>`);
    for (let i = 0; i < 100; i++) {
      const x = (i % 10) * 90, y = Math.floor(i / 10) * 40, c1 = 10 + i * 10, o = c1 + 1, c2 = c1 + 2;
      atoms.push(`<n id="${c1}" p="${x} ${y}"/><n id="${o}" p="${x + 20} ${y}" Element="8"/><n id="${c2}" p="${x + 40} ${y}"/>`);
      bonds.push(`<b id="${c1 + 3}" B="${c1}" E="${o}"/><b id="${c1 + 4}" B="${o}" E="${c2}"/>`);
      pair(o, x + 20, y);
    }
    atoms.push('<n id="5000" p="0 500" Element="7" Charge="1"/><n id="5001" p="20 500"/><n id="5002" p="40 500" Element="8" Charge="-1"/>');
    bonds.push('<b id="5003" B="5000" E="5001"/><b id="5004" B="5001" E="5002"/>');
    pair(5002, 40, 500);
    const source = `<CDXML><page><fragment id="5">${atoms.join("")}${bonds.join("")}</fragment>${pairs.join("")}</page></CDXML>`;

    const canonical = async (molecule: MoleculeObject) => {
      const molfile = moleculeToMolfileV2000(molecule, {
        fromDocFrame: true, kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
      }).contents;
      const result = await computeStructureIdentifiers(molfile);
      if (!result?.smiles) throw new Error("RDKit could not canonicalize the molecule");
      return result.smiles;
    };
    const moleculeOf = (document: NonNullable<ReturnType<typeof openChemDraftPayload>["document"]>) =>
      document.pages[0]!.objects.find((o): o is MoleculeObject => o.type === "molecule")!;

    const original = openChemDraftPayload(source).document!;
    const before = await canonical(moleculeOf(original));
    expect(before).toContain("[NH3+]");
    const saved = plain(original);
    expect(saved.contents.match(/SymbolType="LonePair"/g)).toHaveLength(101);
    const reopened = openChemDraftPayload(saved.contents).document!;
    expect(marksOf(reopened)).toHaveLength(101);
    expect(await canonical(moleculeOf(reopened))).toBe(before);
    // A second save of the reopened file keeps the same pair count and bytes of structure.
    const again = plain(reopened);
    expect(again.contents.match(/SymbolType="LonePair"/g)).toHaveLength(101);
    expect(again.contents).toBe(plain(openChemDraftPayload(again.contents).document!).contents);
  }, 60000);
});
