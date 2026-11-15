import { describe, expect, it } from "vitest";
import { moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { ensureRdkit } from "../../rdkit-adapter/src/conformer";
import { nativeSingleBondGraphMetadata } from "../../document-workflow-core/src/atoms";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

// Entirely synthetic graphs. No Kekulé rewrite is appropriate for the partial open-chain bonds.
const chain = (elements: number[], charges: number[], order = "1.5") =>
  `<CDXML><page id="p"><fragment id="m">
    ${elements.map((element, i) => `<n id="a${i}" p="${i * 24} ${i % 2 * 12}"
      Element="${element}" Charge="${charges[i] ?? 0}"/>`).join("")}
    ${elements.slice(1).map((_, i) => `<b id="b${i}" B="a${i}" E="a${i + 1}" Order="${order}"/>`).join("")}
  </fragment></page></CDXML>`;

const fusedExocyclic = `<CDXML><page id="p"><fragment id="m">
  <n id="a" p="0 0"/><n id="b" p="24 0"/><n id="c" p="36 21"/>
  <n id="d" p="24 42"/><n id="e" p="0 42"/><n id="f" p="-12 21"/>
  <n id="g" p="60 21"/><n id="h" p="72 42"/><n id="i" p="60 63"/>
  <n id="j" p="36 63"/><n id="o" p="-24 -12" Element="8" Charge="-1"/>
  <b id="ab" B="a" E="b" Order="1.5"/><b id="bc" B="b" E="c" Order="1.5"/>
  <b id="cd" B="c" E="d" Order="1.5"/><b id="de" B="d" E="e" Order="1.5"/>
  <b id="ef" B="e" E="f" Order="1.5"/><b id="fa" B="f" E="a" Order="1.5"/>
  <b id="cg" B="c" E="g" Order="1.5"/><b id="gh" B="g" E="h" Order="1.5"/>
  <b id="hi" B="h" E="i" Order="1.5"/><b id="ij" B="i" E="j" Order="1.5"/>
  <b id="jd" B="j" E="d" Order="1.5"/><b id="ao" B="a" E="o" Order="1.5"/>
</fragment></page></CDXML>`;

async function identity(molecule: MoleculeObject) {
  installNodeRdkitModuleLoader();
  const rdkit = await ensureRdkit();
  // Non-ring aromatic bonds are deliberately unresolvable. Disable sanitization only for this
  // graph-identity oracle: asking an engine to infer aromaticity would reject the input or change
  // its meaning. Unknown bonds remain CTfile query type 8; never coerce either case to single.
  const mol = rdkit.get_mol(moleculeToMolfileV3000(molecule, {
    kekuleBondOrders: new Map(), fromDocFrame: true
  }).contents, JSON.stringify({ sanitize: false, removeHs: false }));
  expect(mol).toBeTruthy();
  try {
    const smiles = mol!.get_smiles!();
    expect(smiles).not.toBe("");
    return {
      canonicalStructure: smiles,
      formula: nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula,
      charges: molecule.atoms.map(atom => atom.formalCharge)
    };
  } finally {
    mol?.delete();
  }
}

describe("CDXML delocalised and unknown bond orders", () => {
  it.each([
    ["pentamethine cyanine cation", chain([7, 6, 6, 6, 6, 6, 7], [1])],
    ["enolate-type anion", chain([8, 6, 6], [-1])],
    ["fused rings with an exocyclic partial bond", fusedExocyclic]
  ])("preserves every partial bond and chemical identity in %s", async (_name, source) => {
    const document = openChemDraftPayload(source).document!;
    const before = document.pages[0].objects[0] as MoleculeObject;
    expect(before.bonds.every(bond => bond.order === "aromatic")).toBe(true);
    const exported = exportDocumentToCdxml(document);
    const visible = canonicalVisibleCdxml(exported.contents);
    expect(visible.match(/Order="1.5"/g)).toHaveLength(before.bonds.length);
    for (const contents of [exported.contents, visible]) {
      const reopened = openChemDraftPayload(contents);
      const after = reopened.document!.pages[0].objects[0] as MoleculeObject;
      expect(after.bonds).toEqual(before.bonds);
      expect(after.atoms).toEqual(before.atoms);
      expect(await identity(after)).toEqual(await identity(before));
    }
    expect(exported.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.aromatic_bond_approximation",
      message: expect.stringContaining("does not establish ring aromaticity")
    }));
  });

  it.each(["4", "0.5", "any", "unrecognised &amp; &quot;order&quot;"])(
    "preserves an unsupported Order=%s exactly in visible CDXML and as native unknown", async order => {
      const imported = openChemDraftPayload(chain([6, 8], [-1], order));
      const before = imported.document!.pages[0].objects[0] as MoleculeObject;
      expect(before.bonds[0].order).toBe("unknown");
      expect(imported.warnings).toContainEqual(expect.objectContaining({
        code: "cdxml.bond_order_import_unsupported", bondIds: [before.bonds[0].id]
      }));
      const exported = exportDocumentToCdxml(imported.document!);
      expect(exported.contents).toContain(`Order="${order}"`);
      for (const contents of [exported.contents, canonicalVisibleCdxml(exported.contents)]) {
        const reopened = openChemDraftPayload(contents);
        const after = reopened.document!.pages[0].objects[0] as MoleculeObject;
        expect(after.bonds).toEqual(before.bonds);
        expect(await identity(after)).toEqual(await identity(before));
        expect(exportDocumentToCdxml(reopened.document!).contents).toContain(`Order="${order}"`);
      }
      expect(exported.warnings).toContainEqual(expect.objectContaining({
        code: "cdxml.unknown_bond_order", bondIds: [before.bonds[0].id],
        message: expect.stringContaining("unknown")
      }));
    }
  );

  it("writes a native unknown without source metadata as any, never single", () => {
    const document = openChemDraftPayload(chain([6, 8], [], "1")).document!;
    (document.pages[0].objects[0] as MoleculeObject).bonds[0].order = "unknown";
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('Order="any"');
    const after = openChemDraftPayload(canonicalVisibleCdxml(exported.contents)).document!.pages[0].objects[0] as MoleculeObject;
    expect(after.bonds[0].order).toBe("unknown");
  });

  it("does not let preserved unknown metadata override a later explicit order edit", () => {
    const document = openChemDraftPayload(chain([6, 8], [], "0.5")).document!;
    (document.pages[0].objects[0] as MoleculeObject).bonds[0].order = "double";
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('Order="2"');
    expect(exported.contents).not.toContain('Order="0.5"');
  });
});
