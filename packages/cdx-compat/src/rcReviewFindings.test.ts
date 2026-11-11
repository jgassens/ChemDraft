import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { cdxElementFromOrderedTree, readCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

const chargedWrapper = '<CDXML><page id="1"><fragment id="2"><n id="3" NodeType="Nickname" Element="6" Charge="1" p="60 60"><fragment id="4"><n id="5" Element="7" p="60 60"/></fragment></n></fragment></page></CDXML>';
const nickname = (textAttributes = 'p="60 60"') => `<CDXML><page id="1"><fragment id="2"><n id="3" NodeType="Nickname" p="60 60"><t id="4" ${textAttributes}><s>Me</s></t></n><n id="5" p="90 60" Element="8"/><b id="6" B="3" E="5"/></fragment></page></CDXML>`;

function molecule(document: ChemDraftDocument | undefined): MoleculeObject {
  expect(document).toBeDefined();
  const objects = document!.pages[0]!.objects;
  expect(objects).toHaveLength(1);
  expect(objects[0]!.type).toBe("molecule");
  return objects[0] as MoleculeObject;
}

function interchange(document: ChemDraftDocument, format: "CDXML" | "CDX") {
  if (format === "CDX") {
    const exported = exportDocumentToCdx(document, { embedNativePayload: false });
    return { tree: readCdx(exported.bytes), reopened: importCdx(exported.bytes), warnings: exported.warnings };
  }
  const exported = exportDocumentToCdxml(document, { embedNativePayload: false });
  return {
    tree: cdxElementFromOrderedTree(new XMLParser({ ignoreAttributes: false, preserveOrder: true,
      attributeNamePrefix: "", trimValues: false }).parse(exported.contents)),
    reopened: openChemDraftPayload(exported.contents), warnings: exported.warnings
  };
}

function nodes(tree: CdxElement, name: string): CdxElement[] {
  return [...(tree.name === name ? [tree] : []), ...tree.kids.flatMap(child => nodes(child, name))];
}

describe.each(["CDXML", "CDX"] as const)("PR #339 review findings: visible %s", format => {
  it("F1: neutralizing an unexpanded wrapper keeps the live carbon and warns about discarded nested chemistry", () => {
    const imported = openChemDraftPayload(chargedWrapper);
    const native = molecule(imported.document);
    expect(native.atoms).toHaveLength(1);
    expect(native.atoms[0]).toMatchObject({ element: "C", formalCharge: 1 });
    expect(native.superatoms).toEqual([]);
    native.atoms[0]!.formalCharge = 0;

    const output = interchange(imported.document!, format);
    const reopened = molecule(output.reopened.document);
    expect(reopened.atoms).toHaveLength(1);
    expect(reopened.atoms[0]).toMatchObject({ element: "C", formalCharge: 0 });
    expect(reopened.superatoms).toEqual([]);
    expect(nodes(output.tree, "n")).toHaveLength(1);
    expect(output.warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "cdxml.abbreviation_expansion_not_written", sourceObjectId: "3",
      atomIds: [native.atoms[0]!.id], message: expect.stringContaining("live atom")
    })]));
  });

  it("F1 control: an unchanged charged wrapper retains its unsupported source expansion", () => {
    const imported = openChemDraftPayload(chargedWrapper);
    const output = interchange(imported.document!, format);
    expect(molecule(output.reopened.document).atoms).toMatchObject([{ element: "C", formalCharge: 1 }]);
    expect(nodes(output.tree, "n")).toHaveLength(2);
    expect(output.warnings.some(warning => warning.code === "cdxml.abbreviation_expansion_not_written")).toBe(false);
  });

  it("F4: moving Me down 40 native units also moves its retained label", () => {
    const imported = openChemDraftPayload(nickname());
    const atom = molecule(imported.document).atoms.find(candidate => candidate.element === "Me")!;
    expect(atom.labelOffset).toEqual({ x: 0, y: 0 });
    atom.y += 40;

    const output = interchange(imported.document!, format);
    const moved = molecule(output.reopened.document).atoms.find(candidate => candidate.element === "Me")!;
    expect(moved).toMatchObject({ x: atom.x, y: atom.y, labelOffset: { x: 0, y: 0 } });
    expect(nodes(output.tree, "t")[0]!.attrs.p).toBe("60 90");
    expect(molecule(output.reopened.document).bonds).toHaveLength(1);
  });

  it("F4: moving and editing a label offset translates both text position and bounds while retaining runs", () => {
    const imported = openChemDraftPayload(nickname('p="57 62" BoundingBox="54 57 66 63"'));
    const atom = molecule(imported.document).atoms.find(candidate => candidate.element === "Me")!;
    expect(atom.labelOffset).toEqual({ x: 0, y: 0 });
    atom.x += 20;
    atom.y += 40;
    atom.labelOffset = { x: 4, y: -8 };

    const output = interchange(imported.document!, format);
    const moved = molecule(output.reopened.document).atoms.find(candidate => candidate.element === "Me")!;
    expect(moved.labelOffset).toEqual(atom.labelOffset);
    const text = nodes(output.tree, "t")[0]!;
    expect(text.attrs).toMatchObject({ p: "75 86", BoundingBox: "72 81 84 87" });
    expect(nodes(text, "s")[0]!.text).toBe("Me");
  });

  it("F4 control: unedited retained text keeps its original geometry", () => {
    const imported = openChemDraftPayload(nickname('p="57 62" BoundingBox="54 57 66 63"'));
    const output = interchange(imported.document!, format);
    expect(nodes(output.tree, "t")[0]!.attrs).toMatchObject({ p: "57 62", BoundingBox: "54 57 66 63" });
  });
});
