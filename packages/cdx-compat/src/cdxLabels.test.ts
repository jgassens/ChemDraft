import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, deserializeDocument, serializeDocument, moleculeToMolfileV2000, moleculeToMolfileV3000, rGroupNumberFromLabel,
  type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import {
  expandNativeMoleculeLabelGroups, moleculeSmiles, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles
} from "../../document-workflow-core/src/index";
import { computeStructureIdentifiers } from "../../rdkit-adapter/src/identifiers";
import { resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { analyzeStructure } from "../../rdkit-adapter/src/analysis";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { cdxElementFromOrderedTree, cdxElementToCdxml, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { XMLParser } from "fast-xml-parser";
import { canonicalVisibleCdxml, exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

beforeAll(() => installRealRdkitModuleLoader());
afterAll(() => resetRdkitForTesting());

type Shape = "chain" | "ring" | "linker" | "metal" | "peptide";
const fixtures: [string, Shape][] = [
  ["SO2", "chain"], ["NMe", "ring"], ["(CH2)3", "linker"], ["Pd(OAc)", "metal"],
  ["Arg", "peptide"], ["D-Leu", "peptide"], ["Trp", "peptide"], ["Glu", "peptide"], ["D-Met", "peptide"],
  ["CO", "chain"], ["COO", "chain"], ["CHCO2", "chain"], ["O2", "chain"], ["O3", "chain"]
];
const cdxFixtures: [string, Shape][] = [
  ...fixtures, ["2-Me", "chain"], ["+NMe2", "chain"], [".5Linker", "chain"]
];

/** Synthetic native graphs: the text tool stores the label in element with labelLiteral=true.
 * Expansions are derived by document-workflow-core, never extra stored, unbonded atoms.
 */
function labelledDocument(label: string, shape: Shape): ChemDraftDocument {
  const document = createEmptyDocument({ title: `Synthetic ${label} ${shape}` });
  const atoms: MoleculeObject["atoms"] = [];
  const bonds: MoleculeObject["bonds"] = [];
  const atom = (element: string, x: number, y: number, literal = false) => {
    const id = `a${atoms.length}`;
    atoms.push({ id, element, x, y, formalCharge: 0, ...(literal ? { labelLiteral: true } : {}) });
    return id;
  };
  const bond = (fromAtomId: string, toAtomId: string, order: "single" | "double" = "single") =>
    bonds.push({ id: `b${bonds.length}`, fromAtomId, toAtomId, order });
  const ring = (cx: number) => {
    const ids = Array.from({ length: 6 }, (_, k) =>
      atom(shape === "ring" && k === 0 ? label : "C", cx + 30 * Math.cos(k * Math.PI / 3),
        100 + 30 * Math.sin(k * Math.PI / 3), shape === "ring" && k === 0));
    ids.forEach((id, k) => bond(id, ids[(k + 1) % ids.length]!));
    return ids;
  };
  if (shape === "ring") ring(100);
  else if (shape === "linker") {
    const left = ring(50), right = ring(200);
    const labelled = atom(label, 125, 100, true);
    bond(left[0]!, labelled);
    bond(labelled, right[3]!);
  } else {
    const left = atom(shape === "metal" ? "P" : "C", 60, 100);
    const labelled = atom(label, 90, 100, true);
    const right = atom(shape === "metal" ? "N" : shape === "peptide" ? "N" : "C", 120, 100);
    bond(left, labelled);
    bond(labelled, right);
    if (shape === "peptide") {
      bond(atom("C", 30, 100), left);
      bond(left, atom("O", 60, 70), "double");
      bond(right, atom("C", 150, 100));
    }
  }
  document.pages[0]!.objects.push({
    id: "synthetic", type: "molecule", x: 0, y: 0, width: 250, height: 150, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
  });
  return document;
}

function moleculeOf(result: ReturnType<typeof openChemDraftPayload>): MoleculeObject {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  expect(result.document!.pages[0]!.objects).toHaveLength(1);
  const molecule = result.document!.pages[0]!.objects[0]!;
  expect(molecule.type).toBe("molecule");
  return molecule as MoleculeObject;
}

// Coordinates identify the same drawn attachment atoms across imported/native ID namespaces.
const position = (atom: MoleculeObject["atoms"][number]) => `${atom.x.toFixed(3)},${atom.y.toFixed(3)}`;
function graph(molecule: MoleculeObject) {
  const byId = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return {
    atoms: molecule.atoms.map((atom) => [position(atom), atom.element, atom.formalCharge, atom.isotope, atom.markRadicals ?? 0]).sort(),
    bonds: molecule.bonds.map((bond) => [
      [position(byId.get(bond.fromAtomId)!), position(byId.get(bond.toAtomId)!)].sort(), bond.order, bond.stereo
    ]).sort()
  };
}

async function canonical(molecule: MoleculeObject) {
  // Known groups (e.g. NMe) expand through the app's actual grammar. Unresolved labels use the
  // native writer's explicit dummy atom; graph() separately checks their full text/attachments.
  const identifiers = await computeStructureIdentifiers(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds));
  expect(identifiers?.smiles).toBeTruthy();
  return identifiers!.smiles;
}

async function expectUnchanged(actual: MoleculeObject, original: MoleculeObject, label: string) {
  expect(actual.atoms).toHaveLength(original.atoms.length);
  expect(actual.bonds).toHaveLength(original.bonds.length);
  const labelled = actual.atoms.filter((atom) => atom.element === label);
  expect(labelled).toHaveLength(1);
  expect(actual.bonds.filter((bond) => bond.fromAtomId === labelled[0]!.id || bond.toAtomId === labelled[0]!.id)).toHaveLength(2);
  expect(actual.atoms.filter((atom) => !actual.bonds.some((bond) => bond.fromAtomId === atom.id || bond.toAtomId === atom.id))).toEqual([]);
  expect(graph(actual)).toEqual(graph(original));
  expect(nativeSingleBondGraphMetadata(actual.atoms, actual.bonds)).toMatchObject({
    formula: nativeSingleBondGraphMetadata(original.atoms, original.bonds).formula
  });
  expect(await canonical(actual)).toBe(await canonical(original));
  const expanded = expandNativeMoleculeLabelGroups(actual);
  const expectedExpanded = expandNativeMoleculeLabelGroups(original);
  expect(expanded.molecule.atoms).toHaveLength(expectedExpanded.molecule.atoms.length);
  expect(expanded.molecule.bonds).toHaveLength(expectedExpanded.molecule.bonds.length);
}

describe("synthetic multi-atom labels and attachment atoms", () => {
  for (const [label, shape] of fixtures) {
    const document = labelledDocument(label, shape);
    const original = document.pages[0]!.objects[0] as MoleculeObject;
    it(`already preserves ${label} in a ${shape} through visible CDXML`, async () => {
      const result = openChemDraftPayload(canonicalVisibleCdxml(exportDocumentToCdxml(document).contents));
      expect(result.source).toBe("external-cdxml");
      await expectUnchanged(moleculeOf(result), original, label);
    });
  }
  for (const [label, shape] of cdxFixtures) {
    const document = labelledDocument(label, shape);
    const original = document.pages[0]!.objects[0] as MoleculeObject;
    it(`preserves ${label} in a ${shape} through visible CDX without native metadata`, async () => {
      const exported = exportDocumentToCdx(document, { embedNativePayload: false });
      expect(exported.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "cdx.atom_label_unexpanded", message: expect.stringContaining(`"${label}"`) })
      ]));
      expect(exported.warnings.some((warning) => warning.message.includes("unencodable attribute Element"))).toBe(false);
      const result = importCdx(exported.bytes);
      expect(result.source).toBe("external-cdxml");
      await expectUnchanged(moleculeOf(result), original, label);
    });
    it(`saves and reopens ${label} in a ${shape} as the exact native document`, async () => {
      const result = importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes);
      expect(result.source).toBe("native-payload");
      expect(result.document).toEqual(document);
      await expectUnchanged(moleculeOf(result), original, label);
    });
  }
});

type ExpansionFixture = { name: string; label: string; kind: "Nickname" | "Fragment"; formula: string;
  smiles: string; elements: number[]; bonds: [number, number, number?][]; copies?: number; parentRing?: boolean };
const expansionFixtures: ExpansionFixture[] = [
  { name: "biphenyl", label: "Ph", kind: "Nickname", formula: "C12H10", smiles: "c1ccc(-c2ccccc2)cc1",
    elements: [6, 6, 6, 6, 6, 6], bonds: [[0, 1, 2], [1, 2], [2, 3, 2], [3, 4], [4, 5, 2], [5, 0]], parentRing: true },
  { name: "Boc-NH", label: "Boc", kind: "Nickname", formula: "C6H13NO2", smiles: "CNC(=O)OC(C)(C)C",
    elements: [6, 8, 8, 6, 6, 6, 6], bonds: [[0, 1, 2], [0, 2], [2, 3], [3, 4], [3, 5], [3, 6]] },
  { name: "OTBS", label: "OTBS", kind: "Fragment", formula: "C7H18OSi", smiles: "CO[Si](C)(C)C(C)(C)C",
    elements: [8, 14, 6, 6, 6, 6, 6, 6], bonds: [[0, 1], [1, 2], [1, 3], [1, 4], [4, 5], [4, 6], [4, 7]] },
  { name: "OMe", label: "OMe", kind: "Fragment", formula: "C2H6O", smiles: "COC",
    elements: [8, 6], bonds: [[0, 1]] },
  { name: "three Me nodes", label: "Me", kind: "Nickname", formula: "C3H9N", smiles: "CN(C)C",
    elements: [6], bonds: [], copies: 3 }
];

/** Independently authored visible and fully expanded twins; all IDs are distinct, including text. */
function expansionXml(fixture: ExpansionFixture, expanded = false) {
  let next = 10;
  const node = (element: number, x: number, y: number) => ({ id: String(next++),
    xml: (id: string) => `<n id="${id}" Element="${element}" p="${x} ${y}"/>` });
  const bond = (a: string, b: string, order = 1) => `<b id="${next++}" B="${a}" E="${b}" Order="${order}"/>`;
  const nodes: string[] = [], bonds: string[] = [];
  const parent = node(fixture.name === "Boc-NH" || fixture.copies ? 7 : 6, 100, 100);
  nodes.push(parent.xml(parent.id));
  if (fixture.parentRing) {
    const ring = [parent, ...Array.from({ length: 5 }, (_, i) => node(6, 85 - i * 4, 120 + i * 8))];
    nodes.push(...ring.slice(1).map(atom => atom.xml(atom.id)));
    ring.forEach((atom, i) => bonds.push(bond(atom.id, ring[(i + 1) % 6].id, i % 2 ? 1 : 2)));
  }
  if (fixture.name === "Boc-NH") {
    const methyl = node(6, 70, 100); nodes.push(methyl.xml(methyl.id)); bonds.push(bond(parent.id, methyl.id));
  }
  for (let copy = 0; copy < (fixture.copies ?? 1); copy++) {
    const atoms = fixture.elements.map((element, i) => node(element, 130 + i * 18, 100 + copy * 45));
    const bodyNodes = atoms.map(atom => atom.xml(atom.id));
    const bodyBonds = fixture.bonds.map(([a, b, order]) => bond(atoms[a].id, atoms[b].id, order));
    if (expanded) { nodes.push(...bodyNodes); bonds.push(...bodyBonds, bond(parent.id, atoms[0].id)); }
    else {
      const wrapperId = String(next++), bodyId = String(next++), connectionId = String(next++), textId = String(next++);
      nodes.push(`<n id="${wrapperId}" p="130 ${100 + copy * 45}" NodeType="${fixture.kind}"><t id="${textId}"><s>${fixture.label}</s></t>
        <fragment id="${bodyId}">${bodyNodes.join("")}${bodyBonds.join("")}
          <n id="${connectionId}" NodeType="ExternalConnectionPoint"/>${bond(connectionId, atoms[0].id)}</fragment></n>`);
      bonds.push(bond(parent.id, wrapperId));
    }
  }
  return `<CDXML><page id="1"><fragment id="2">${nodes.join("")}${bonds.join("")}</fragment></page></CDXML>`;
}

function expectExpandedSuperatoms(molecule: MoleculeObject, fixture: ExpansionFixture) {
  expect(molecule.superatoms).toHaveLength(fixture.copies ?? 1);
  for (const group of molecule.superatoms) {
    expect(group.label).toBe(fixture.label);
    expect(group.atomIds).toHaveLength(fixture.elements.length);
    expect(group.expandedStructureFormat).toBe("molfile-v3000");
    expect(group.expandedStructure).toContain("M  V30 BEGIN ATOM");
    expect(group.attachmentPoints).toHaveLength(1);
    const anchor = group.attachmentPoints[0];
    expect(anchor).toMatchObject({ kind: "atom", objectId: molecule.id });
    expect(group.atomIds).toContain(anchor.atomId);
    expect(molecule.bonds.filter(bond => (group.atomIds!.includes(bond.fromAtomId) !== group.atomIds!.includes(bond.toAtomId)) &&
      [bond.fromAtomId, bond.toAtomId].includes(anchor.atomId!))).toHaveLength(1);
  }
}

function expectVisibleAbbreviations(root: ReturnType<typeof readCdx>, fixture: ExpansionFixture) {
  const fragment = root.kids.find(node => node.name === "page")!.kids.find(node => node.name === "fragment")!;
  const labels = fragment.kids.filter(node => node.name === "n" && node.attrs.NodeType === fixture.kind);
  expect(labels).toHaveLength(fixture.copies ?? 1);
  for (const label of labels) {
    expect(label.kids.find(node => node.name === "t")!.kids[0].text).toBe(fixture.label);
    const body = label.kids.find(node => node.name === "fragment")!;
    expect(body.kids.filter(node => node.name === "n" && node.attrs.NodeType !== "ExternalConnectionPoint")).toHaveLength(fixture.elements.length);
    expect(body.kids.filter(node => node.name === "n" && node.attrs.NodeType === "ExternalConnectionPoint")).toHaveLength(1);
    expect(fragment.kids.filter(node => node.name === "b" && [node.attrs.B, node.attrs.E].includes(label.attrs.id))).toHaveLength(1);
  }
  const ids: string[] = [];
  const visit = (node: ReturnType<typeof readCdx>) => { if (node.attrs.id) ids.push(node.attrs.id); node.kids.forEach(visit); };
  visit(root);
  expect(new Set(ids).size).toBe(ids.length);
}

describe("labelled source expansions remain native superatoms", () => {
  for (const levels of [2, 3]) for (const differingMembers of [false, true]) for (const binary of [false, true]) {
    it(`preserves ${levels} nested source groups with ${differingMembers ? "different" : "equal"} membership (binary=${binary})`, () => {
      let next = 10;
      const id = () => String(next++);
      const labels = levels === 2 ? ["Outer", "Inner"] : ["Outer", "Middle", "Inner"];
      const wrap = (depth: number): { id: string; xml: string } => {
        const nodeId = id();
        if (depth === levels) return { id: nodeId, xml: `<n id="${nodeId}" Element="6" p="130 100"/>` };
        const child = wrap(depth + 1), connectionId = id(), extraId = id();
        const extra = differingMembers && depth < levels - 1
          ? `<n id="${extraId}" Element="6" p="${160 + depth * 30} 100"/><b id="${id()}" B="${child.id}" E="${extraId}"/>` : "";
        return { id: nodeId, xml: `<n id="${nodeId}" NodeType="${depth % 2 ? "Nickname" : "Fragment"}" p="130 100">
          <t id="${id()}"><s>${labels[depth]}</s></t><fragment id="${id()}">${child.xml}${extra}
            <n id="${connectionId}" NodeType="ExternalConnectionPoint"/>
            <b id="${id()}" B="${connectionId}" E="${child.id}"/></fragment></n>` };
      };
      const outer = wrap(0);
      const source = xmlTree(`<n id="3" Element="6" p="100 100"/>${outer.xml}<b id="4" B="3" E="${outer.id}"/>`);
      // Ignore generated IDs and connection pseudo-atoms, but compare every label, node kind and
      // nesting level, including the live atoms beside a child when memberships differ.
      const nesting = (fragment: ReturnType<typeof readCdx>): unknown[] => fragment.kids
        .filter(node => node.name === "n" && node.attrs.NodeType !== "ExternalConnectionPoint")
        .map(node => {
          const body = node.kids.find(child => child.name === "fragment");
          return body ? { kind: node.attrs.NodeType, label: node.kids.find(child => child.name === "t")!.kids[0].text,
            children: nesting(body) } : { element: node.attrs.Element ?? "6" };
        }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const fragmentOf = (tree: ReturnType<typeof readCdx>) => tree.kids.find(node => node.name === "page")!
        .kids.find(node => node.name === "fragment")!;
      const expected = nesting(fragmentOf(source));
      const opened = binary ? importCdx(writeCdx(source)) : openChemDraftPayload(cdxElementToCdxml(source));
      const original = moleculeOf(opened);
      expect(original.superatoms.map(group => group.label)).toEqual(labels);
      expect(original.superatoms.map(group => group.atomIds!.length)).toEqual(
        labels.map((_, depth) => differingMembers ? levels - depth : 1));
      let document = deserializeDocument(serializeDocument(opened.document!));
      expect(document).toEqual(opened.document);
      for (let cycle = 0; cycle < 2; cycle++) {
        if (cycle === 1) {
          // Released native payloads retain source preorder but have no explicit association/depth.
          const records = (document.pages[0].objects[0] as MoleculeObject).compatibility!.unknown.cdxmlAbbreviations as
            { depth?: number; superatomIndex?: number }[];
          records.forEach(record => { delete record.depth; delete record.superatomIndex; });
        }
        const visible = binary ? exportDocumentToCdx(document) : exportDocumentToCdxml(document, { embedNativePayload: false });
        const tree = "bytes" in visible ? readCdx(visible.bytes) : cdxElementFromOrderedTree(new XMLParser({
          preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
        }).parse(visible.contents));
        expect(nesting(fragmentOf(tree))).toEqual(expected);
        expect(visible.warnings.some(warning => warning.code === "cdxml.superatom_not_collapsed")).toBe(false);
        const reopened = "bytes" in visible ? importCdx(visible.bytes) : openChemDraftPayload(visible.contents);
        expect(graph(moleculeOf(reopened))).toEqual(graph(original));
        expect(moleculeOf(reopened).superatoms.map(group => group.label)).toEqual(labels);
        const saved = binary ? importCdx(exportDocumentToCdx(document, { embedNativePayload: true }).bytes)
          : openChemDraftPayload(exportDocumentToCdxml(document).contents);
        expect(saved.source).toBe("native-payload");
        expect(saved.document).toEqual(document);
        document = reopened.document!;
      }
    });
  }

  it.each([false, true])("retains each equal-membership group's own source kind after renaming both labels (binary=%s)", binary => {
    const source = xmlTree(`<n id="10" NodeType="Fragment"><t id="11"><s>Outer</s></t><fragment id="12">
      <n id="20" NodeType="Nickname"><t id="21"><s>Inner</s></t><fragment id="22">
        <n id="30" Element="6" p="100 100"/></fragment></n></fragment></n>`);
    const opened = binary ? importCdx(writeCdx(source)) : openChemDraftPayload(cdxElementToCdxml(source));
    moleculeOf(opened).superatoms.forEach(group => { group.label = "Renamed"; });
    const document = deserializeDocument(serializeDocument(opened.document!));
    const exported = binary ? readCdx(exportDocumentToCdx(document).bytes) : cdxElementFromOrderedTree(new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
    }).parse(exportDocumentToCdxml(document, { embedNativePayload: false }).contents));
    const outer = exported.kids.find(node => node.name === "page")!.kids.find(node => node.name === "fragment")!
      .kids.find(node => node.name === "n")!;
    const inner = outer.kids.find(node => node.name === "fragment")!.kids.find(node => node.name === "n")!;
    expect([outer, inner].map(node => [node.attrs.NodeType, node.kids.find(child => child.name === "t")!.kids[0].text]))
      .toEqual([["Fragment", "Renamed"], ["Nickname", "Renamed"]]);
    const atoms = inner.kids.find(node => node.name === "fragment")!.kids.filter(node => node.name === "n");
    expect(atoms).toHaveLength(1);
    expect(atoms[0].attrs.NodeType).toBeUndefined();
    expect(atoms[0].attrs.Element ?? "6").toBe("6");
  });

  for (const fixture of expansionFixtures) for (const binary of [false, true]) {
    it(`${fixture.name}: ${binary ? "CDX" : "CDXML"} keeps label, attachment, expansion and chemistry through visible/native saves`, async () => {
      const xml = expansionXml(fixture);
      const tree = cdxElementFromOrderedTree(new XMLParser({ preserveOrder: true, ignoreAttributes: false,
        attributeNamePrefix: "", parseAttributeValue: false, trimValues: false }).parse(xml));
      const opened = binary ? importCdx(writeCdx(tree)) : openChemDraftPayload(xml);
      const molecule = moleculeOf(opened);
      const control = moleculeOf(openChemDraftPayload(expansionXml(fixture, true)));
      expect(opened.warnings.some(warning => warning.code === "cdxml.abbreviation_not_expanded")).toBe(false);
      expectExpandedSuperatoms(molecule, fixture);
      expect(graph(molecule)).toEqual(graph(control));
      expect(nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds).formula).toBe(fixture.formula);
      expect(await canonical(molecule)).toBe((await computeStructureIdentifiers(fixture.smiles))!.smiles);
      expect(await canonical(molecule)).toBe(await canonical(control));
      // The app's label expansion must not expand these already-real atoms a second time.
      expect(expandNativeMoleculeLabelGroups(molecule).molecule.atoms).toEqual(molecule.atoms);
      for (const writer of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
        const molfile = writer(molecule, { kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents;
        expect((await computeStructureIdentifiers(molfile))!.smiles).toBe(await canonical(control));
      }
      const payload = deserializeDocument(serializeDocument(opened.document!));
      expect(payload).toEqual(opened.document);
      const exported = binary ? exportDocumentToCdx(payload) : exportDocumentToCdxml(payload, { embedNativePayload: false });
      const visibleTree = "bytes" in exported ? readCdx(exported.bytes) : cdxElementFromOrderedTree(new XMLParser({
        preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
      }).parse(exported.contents));
      expectVisibleAbbreviations(visibleTree, fixture);
      const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
      expectExpandedSuperatoms(moleculeOf(reopened), fixture);
      expect(await canonical(moleculeOf(reopened))).toBe(await canonical(control));
      const saved = binary ? importCdx(exportDocumentToCdx(payload, { embedNativePayload: true }).bytes)
        : openChemDraftPayload(exportDocumentToCdxml(payload).contents);
      expect(saved.source).toBe("native-payload");
      expect(saved.document).toEqual(payload);
    });
  }

  it.each(expansionFixtures)("$name: analysis and CLI identity read every expanded atom once", async fixture => {
    const molecule = moleculeOf(openChemDraftPayload(expansionXml(fixture)));
    const { currentMoleculeIdentityMolfile } = await import("../../chemdraft-cli/src/document");
    const identity = await currentMoleculeIdentityMolfile(molecule);
    const methodIds = ["rdkit.composition", "rdkit.average-mass", "rdkit.monoisotopic-mass", "rdkit.canonical-smiles"];
    const request = { runId: "synthetic-abbreviation", startedAt: "2026-11-09T00:00:00Z", methodIds };
    const actual = await analyzeStructure({ ...request, format: identity.format, value: identity.contents });
    const expected = await analyzeStructure({ ...request, format: "smiles", value: fixture.smiles });
    for (const id of methodIds) {
      const result = actual.results.find(result => result.id === id)!;
      const reference = expected.results.find(result => result.id === id)!;
      expect(result, id).toBeDefined();
      expect(result.status, id).toBe("ok");
      if (result.kind === "scalar" && reference.kind === "scalar") expect(result.value, id).toBeCloseTo(reference.value!, 10);
      else expect((result as { value?: unknown }).value, id).toEqual((reference as { value?: unknown }).value);
      if (result.kind === "composition" && reference.kind === "composition") {
        expect(result.formula).toBe(fixture.formula);
        expect(result.formula).toBe(reference.formula);
      }
    }
  });

  it.each([false, true])("writes newly authored superatoms as Nickname (binary=%s)", binary => {
    const fixture = { ...expansionFixtures[3], kind: "Nickname" as const };
    const opened = openChemDraftPayload(expansionXml(fixture));
    const molecule = moleculeOf(opened);
    delete molecule.compatibility;
    const xml = exportDocumentToCdxml(opened.document!, { embedNativePayload: false });
    const tree = cdxElementFromOrderedTree(new XMLParser({ preserveOrder: true, ignoreAttributes: false,
      attributeNamePrefix: "", parseAttributeValue: false, trimValues: false }).parse(xml.contents));
    expectVisibleAbbreviations(binary ? readCdx(exportDocumentToCdx(opened.document!).bytes) : tree, fixture);
  });

  it("writes edited expansion atoms instead of restoring a stale source expansion", async () => {
    const fixture = expansionFixtures[3];
    const opened = openChemDraftPayload(expansionXml(fixture));
    const molecule = moleculeOf(opened);
    molecule.atoms.find(atom => atom.id === molecule.superatoms[0].atomIds![1])!.element = "N";
    const expected = await canonical(molecule);
    const xml = exportDocumentToCdxml(opened.document!, { embedNativePayload: false });
    expect(await canonical(moleculeOf(openChemDraftPayload(xml.contents)))).toBe(expected);
    expect(await canonical(moleculeOf(importCdx(exportDocumentToCdx(opened.document!).bytes)))).toBe(expected);
  });
});

const xmlTree = (content: string) => cdxElementFromOrderedTree(new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
}).parse(`<CDXML><page id="1"><fragment id="2">${content}</fragment></page></CDXML>`));

/** Synthetic para-disubstituted benzene. Source object ids deliberately differ from R numbers. */
function rGroupTree(labels: readonly [string, string]) {
  const ring = Array.from({ length: 6 }, (_, index) => {
    const angle = index * Math.PI / 3;
    return `<n id="${101 + index}" p="${100 + 30 * Math.cos(angle)} ${100 + 30 * Math.sin(angle)}"/>`;
  }).join("");
  const bonds = Array.from({ length: 6 }, (_, index) =>
    `<b id="${201 + index}" B="${101 + index}" E="${101 + (index + 1) % 6}" Order="${index % 2 ? 1 : 2}"/>`).join("");
  const label = (text: string) => text === "R1" ? '<s>R</s><s face="32">1</s>' : `<s>${text}</s>`;
  return xmlTree(`${ring}${bonds}
    <n id="1829667708" p="160 100" NodeType="GenericNickname" GenericNickname="R"><t>${label(labels[0])}</t></n>
    <n id="1604796376" p="40 100" NodeType="GenericNickname" GenericNickname="R"><t>${label(labels[1])}</t></n>
    <b id="207" B="101" E="1829667708"/><b id="208" B="104" E="1604796376"/>`);
}

describe("synthetic numbered R-group attachments", () => {
  const formats = ["CDXML", "CDX"] as const;
  const nicknameRuns = (node: CdxElement): CdxElement[][] => [
    ...(node.name === "n" && node.attrs.GenericNickname === "R"
      ? [node.kids.find(child => child.name === "t")!.kids.filter(child => child.name === "s")] : []),
    ...node.kids.flatMap(nicknameRuns)
  ];
  const openedTree = (tree: ReturnType<typeof xmlTree>, format: typeof formats[number]) =>
    format === "CDX" ? openChemDraftPayload(cdxElementToCdxml(readCdx(writeCdx(tree))))
      : openChemDraftPayload(cdxElementToCdxml(tree));
  const mappedNumbers = (smiles: string) => [...smiles.matchAll(/\[\*:(\d+)\]/g)].map((match) => Number(match[1])).sort();
  const expectRgroups = (molecule: MoleculeObject, labels: readonly string[]) => {
    expect(molecule.atoms).toHaveLength(8);
    expect(molecule.bonds).toHaveLength(8);
    expect(molecule.rGroups.map((group) => group.label)).toEqual(labels);
    expect(molecule.rGroups.map((group) => rGroupNumberFromLabel(group.label))).toEqual(labels.map(rGroupNumberFromLabel));
    for (const group of molecule.rGroups) {
      // Imported nickname text supplies no evidence of display-only or query semantics.
      expect(group.querySemantics).toBe("unknown");
      expect(group.attachmentPoints).toEqual([{
        kind: "atom", objectId: molecule.id,
        atomId: molecule.atoms.find((atom) => atom.element === group.label)!.id
      }]);
    }
  };

  for (const format of formats) {
    it(`${format} imports R1/R2 from text and keeps their numbers through engine SMILES and visible round trips`, async () => {
      const source = rGroupTree(["R1", "R2"]);
      const opened = openedTree(source, format);
      const molecule = moleculeOf(opened);
      expectRgroups(molecule, ["R1", "R2"]);
      expect(molecule.rGroups.map((group) => rGroupNumberFromLabel(group.label))).toEqual([1, 2]);
      expect(mappedNumbers(nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds))).toEqual([1, 2]);
      expect(mappedNumbers(await moleculeSmiles(molecule, 0, [], undefined))).toEqual([1, 2]);
      // The app's export path and the CLI/analysis molfile path both reach this real engine.
      expect(mappedNumbers(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers))).toEqual([1, 2]);
      for (const writer of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
        const molfile = writer(molecule, { kekuleBondOrders: new Map() }).contents;
        expect(mappedNumbers((await computeStructureIdentifiers(molfile))!.smiles!)).toEqual([1, 2]);
      }
      const exported = exportDocumentToCdxml(opened.document!, { embedNativePayload: false }).contents;
      expect(exported).toContain('GenericNickname="R"');
      const exportedTree = cdxElementFromOrderedTree(new XMLParser({
        preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false
      }).parse(exported));
      // Retain the source R + subscript-1 runs as well as the numbered label's meaning.
      expect(nicknameRuns(exportedTree)).toEqual(nicknameRuns(format === "CDX" ? readCdx(writeCdx(source)) : source));
      const reopened = format === "CDX"
        ? importCdx(exportDocumentToCdx(opened.document!, { embedNativePayload: false }).bytes)
        : openChemDraftPayload(exported);
      expectRgroups(moleculeOf(reopened), ["R1", "R2"]);
      expect(await moleculeSmiles(moleculeOf(reopened), 0, [], computeStructureIdentifiers))
        .toBe(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers));
    });

    it.each([["R", "R'"], ["R'", "R''"]] as const)(`${format} keeps %s / %s unnumbered`, async (left, right) => {
      const opened = openedTree(rGroupTree([left, right]), format);
      const molecule = moleculeOf(opened);
      expectRgroups(molecule, [left, right]);
      expect(molecule.rGroups.map((group) => rGroupNumberFromLabel(group.label))).toEqual([undefined, undefined]);
      expect(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers)).not.toMatch(/\[\*:\d+\]/);
      const exported = exportDocumentToCdxml(opened.document!, { embedNativePayload: false }).contents;
      const roundTrip = format === "CDX" ? importCdx(exportDocumentToCdx(opened.document!, { embedNativePayload: false }).bytes)
        : openChemDraftPayload(exported);
      expectRgroups(moleculeOf(roundTrip), [left, right]);
    });
  }
});

describe("standard binary nickname nodes and fragment attachment points", () => {
  it.each(["Nickname", "Fragment"])("preserves %s while normalizing a symbolic Element for binary output", kind => {
    const root = xmlTree(`<n id="label" NodeType="${kind}" Element="Me"><t><s>Me</s></t>
      <fragment id="body"><n id="carbon"/><n id="connection" NodeType="ExternalConnectionPoint"/>
        <b id="attachment" B="connection" E="carbon"/></fragment></n>`);
    expect(readCdx(writeCdx(root)).kids[0].kids[0].kids[0].attrs.NodeType).toBe(kind);
  });

  const u16 = (n: number) => [n & 255, n >>> 8 & 255];
  const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
  const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
  const object = (tag: number, id: number, ...data: number[][]) => [...u16(tag), ...u32(id), ...data.flat(), 0, 0];
  // Independently encoded bytes: these cases do not use writeCdx or its NodeType table.
  const binaryNickname = (nodeType: number, nickname?: number[]) => new Uint8Array([
    ...new TextEncoder().encode("VjCD0100"), 4, 3, 2, 1, ...Array(10).fill(0),
    ...object(0x8000, 0, object(0x8001, 1, object(0x8003, 2,
      object(0x8004, 10),
      object(0x8004, 11, property(0x0400, u16(nodeType)),
        ...(nickname
          ? [property(0x0433, nickname)]
          : [object(0x8006, 12, property(0x0700, [0, 0, ...new TextEncoder().encode("NMe")]))])),
      object(0x8004, 13),
      object(0x8005, 14, property(0x0604, u32(10)), property(0x0605, u32(11))),
      object(0x8005, 15, property(0x0604, u32(11)), property(0x0605, u32(13)))
    )))
  ]);

  it.each([4, 5, 6, 7, 14])("reads NodeType=%s text as the bonded label, without another atom", (nodeType) => {
    const opened = importCdx(binaryNickname(nodeType));
    const molecule = moleculeOf(opened);
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "NMe", "C"]);
    expect(molecule.atoms[1]!.labelLiteral).toBe(true);
    expect(molecule.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId])).toEqual([
      [molecule.atoms[0]!.id, molecule.atoms[1]!.id], [molecule.atoms[1]!.id, molecule.atoms[2]!.id]
    ]);
  });

  it.each([
    ["zero style runs", [0, 0, 0x4e, 0x4d, 0x65]],
    ["two style runs", [2, 0, ...[0, 0xffff, 1, 240, 3, 1, 0xffff, 0, 200, 3].flatMap(u16), 0x4e, 0x4d, 0x65]]
  ] as const)("reads a spec CDXString nickname with %s without a text object", (_, data) => {
    const bytes = binaryNickname(7, [...data]);
    expect(readCdx(bytes).kids[0]!.kids[0]!.kids[1]!.attrs.GenericNickname).toBe("NMe");
    const molecule = moleculeOf(importCdx(bytes));
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "NMe", "C"]);
    expect(molecule.atoms[1]!.labelLiteral).toBe(true);
    expect(molecule.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId])).toEqual([
      [molecule.atoms[0]!.id, molecule.atoms[1]!.id], [molecule.atoms[1]!.id, molecule.atoms[2]!.id]
    ]);
  });

  it("keeps a nameless nickname unknown and warns instead of inventing carbon", () => {
    const root = xmlTree('<n id="10" NodeType="GenericNickname"/>');
    const opened = importCdx(writeCdx(root));
    expect(moleculeOf(opened).atoms[0]!.element).toBe("*");
    expect(opened.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cdxml.abbreviation_not_expanded", message: expect.stringContaining("neither label text nor an expanded atom graph") })
    ]));
  });

  it("encodes a text label on one existing node with unique text-object IDs and unchanged bond references", () => {
    const root = xmlTree('<n id="left"/><n id="label" Element="SO2"/><n id="right"/>' +
      '<b id="first" B="left" E="label"/><b id="second" B="label" E="right"/>');
    const unchanged = structuredClone(root);
    const decoded = readCdx(writeCdx(root));
    expect(root).toEqual(unchanged);
    const fragment = decoded.kids[0]!.kids[0]!;
    const nodes = fragment.kids.filter((child) => child.name === "n");
    const bonds = fragment.kids.filter((child) => child.name === "b");
    expect(nodes).toHaveLength(3);
    expect(nodes[1]!.attrs).toMatchObject({ NodeType: "GenericNickname", GenericNickname: "SO2" });
    expect(nodes[1]!.attrs.Element).toBeUndefined();
    expect(nodes[1]!.kids[0]!.kids[0]!.text).toBe("SO2");
    expect(bonds.map((bond) => [bond.attrs.B, bond.attrs.E])).toEqual([
      [nodes[0]!.attrs.id, nodes[1]!.attrs.id], [nodes[1]!.attrs.id, nodes[2]!.attrs.id]
    ]);
    const ids = [decoded, decoded.kids[0]!, fragment, ...nodes, ...bonds, nodes[1]!.kids[0]!].map((child) => child.attrs.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("expands a nested fragment and removes its external connection pseudo-atom exactly once", async () => {
    const root = xmlTree(`<n id="left" p="0 0"/><n id="group" p="30 0" NodeType="Fragment" Element="NMe">
      <fragment id="body"><n id="n" Element="7" p="30 0"/><n id="methyl" p="30 30"/>
        <n id="connection" NodeType="ExternalConnectionPoint"/><b id="inside" B="n" E="methyl"/>
        <b id="attachment" B="connection" E="n"/></fragment><t><s>NMe</s></t></n>
      <n id="right" p="60 0"/><b id="first" B="left" E="group"/><b id="second" B="group" E="right"/>`);
    const control = moleculeOf(openChemDraftPayload(cdxElementToCdxml(root)));
    const result = moleculeOf(importCdx(writeCdx(root)));
    expect(result.atoms.map((atom) => atom.element)).toEqual(["C", "N", "C", "C"]);
    expect(result.bonds).toHaveLength(3);
    expect(graph(result)).toEqual(graph(control));
    expect(await canonical(result)).toBe(await canonical(control));
  });

  it("keeps an unresolved two-attachment fragment label on both bonds when saved again", async () => {
    const root = xmlTree(`<n id="left" p="0 0"/><n id="group" p="30 0" NodeType="Fragment">
      <fragment id="body"><n id="a" p="30 0"/><n id="b" p="45 0"/>
        <n id="cp1" NodeType="ExternalConnectionPoint"/><n id="cp2" NodeType="ExternalConnectionPoint"/>
        <b id="inside" B="a" E="b"/><b id="in1" B="cp1" E="a"/><b id="in2" B="b" E="cp2"/>
      </fragment><t><s>(CH2)3</s></t></n><n id="right" p="60 0"/>
      <b id="first" B="left" E="group" BeginAttach="1"/><b id="second" B="group" E="right" EndAttach="2"/>`);
    const control = openChemDraftPayload(cdxElementToCdxml(root));
    const imported = importCdx(writeCdx(root));
    expect(graph(moleculeOf(imported))).toEqual(graph(moleculeOf(control)));
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cdxml.abbreviation_not_expanded", message: expect.stringContaining('"(CH2)3"') })
    ]));
    const reopened = importCdx(exportDocumentToCdx(imported.document!).bytes);
    await expectUnchanged(moleculeOf(reopened), moleculeOf(imported), "(CH2)3");
    const original = moleculeOf(imported);
    expect(original.superatoms).toEqual([]);
    const records = original.compatibility!.unknown.cdxmlAbbreviations as { source: ReturnType<typeof readCdx> }[];
    expect(records[0].source.attrs.NodeType).toBe("Fragment");
    expect(records[0].source.kids.find(node => node.name === "fragment")!.kids.filter(node => node.name === "n")).toHaveLength(4);
    expect(deserializeDocument(serializeDocument(imported.document!))).toEqual(imported.document);
    for (const binary of [false, true]) {
      const visible = binary ? readCdx(exportDocumentToCdx(imported.document!).bytes)
        : cdxElementFromOrderedTree(new XMLParser({ preserveOrder: true, ignoreAttributes: false,
          attributeNamePrefix: "", parseAttributeValue: false, trimValues: false
        }).parse(exportDocumentToCdxml(imported.document!, { embedNativePayload: false }).contents));
      const fragment = visible.kids.find(node => node.name === "page")!.kids.find(node => node.name === "fragment")!;
      const abbreviation = fragment.kids.find(node => node.name === "n" && node.attrs.NodeType === "Fragment")!;
      expect(abbreviation.kids.find(node => node.name === "fragment")!.kids.filter(node =>
        node.name === "n" && node.attrs.NodeType === "ExternalConnectionPoint")).toHaveLength(2);
      expect(fragment.kids.find(node => node.name === "b" && node.attrs.BeginAttach)?.attrs.BeginAttach).toBe("1");
      expect(fragment.kids.find(node => node.name === "b" && node.attrs.EndAttach)?.attrs.EndAttach).toBe("2");
    }
  });
});
