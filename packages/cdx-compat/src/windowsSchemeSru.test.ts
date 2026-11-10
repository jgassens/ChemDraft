import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { BracketObject, ChemDraftDocument } from "@chemdraft/chem-core";
import { documentReactionSummary } from "@chemdraft/document-workflow-core";
import { readCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";

const fixture = readFileSync(new URL("../../fixtures/cdxml/scheme-and-sru.cdxml", import.meta.url), "utf8");

function descendants(element: CdxElement): CdxElement[] {
  return [element, ...element.kids.flatMap(descendants)];
}

function idList(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? [];
}

/** Check the visible binary tree as well as native links: a native envelope can hide bad IDs. */
function expectScheme(tree: CdxElement, document: ChemDraftDocument) {
  const elements = descendants(tree);
  const byId = new Map(elements.filter(element => element.attrs.id).map(element => [element.attrs.id, element]));
  const resolve = (owner: CdxElement, attribute: string, kinds: string[]) => idList(owner.attrs[attribute]).map(id => {
    const target = byId.get(id);
    expect(target, `${owner.name} ${owner.attrs.id}: ${attribute}=${id}`).toBeDefined();
    expect(kinds, `${attribute}=${id} resolves to ${target?.name}`).toContain(target!.name);
    return target!;
  });
  const leaves = (element: CdxElement): CdxElement[] => element.name === "group"
    ? element.kids.flatMap(leaves) : [element];
  const fragments = [60, 170, 280].map(x => {
    const fragment = elements.find(element => element.name === "fragment" && element.kids.some(child =>
      child.name === "n" && Number(child.attrs.p?.split(/\s+/)[0]) === x));
    expect(fragment, `fragment starting at x=${x}`).toBeDefined();
    return fragment!;
  });
  const arrows = elements.filter(element => element.name === "arrow");
  expect(arrows).toHaveLength(2);
  expect(arrows.map(arrow => arrow.attrs.Tail3D)).toEqual(["100 100 0", "210 100 0"]);
  expect(arrows.map(arrow => arrow.attrs.Head3D)).toEqual(["150 100 0", "260 100 0"]);
  for (const arrow of arrows) {
    // The native arrow path currently does not preserve ArrowSource/ArrowTarget. If it starts
    // writing them, require real targets rather than allowing dangling optional references.
    for (const attribute of ["ArrowSource", "ArrowTarget"]) {
      if (arrow.attrs[attribute] !== undefined) {
        const ids = idList(arrow.attrs[attribute]);
        expect(ids).toHaveLength(1);
        expect(byId.has(ids[0]), `${attribute}=${ids[0]} must resolve`).toBe(true);
      }
    }
  }

  const schemes = elements.filter(element => element.name === "scheme");
  expect(schemes).toHaveLength(1);
  const steps = schemes[0].kids.filter(element => element.name === "step");
  expect(elements.filter(element => element.name === "step")).toHaveLength(2);
  expect(steps).toHaveLength(2);
  const objects = document.pages[0].objects;
  const nativeFor = (element: CdxElement) => {
    const matches = objects.filter(object => object.compatibility?.originalId === element.attrs.id);
    expect(matches, `native object for ${element.name} ${element.attrs.id}`).toHaveLength(1);
    return matches[0];
  };
  const molecules = fragments.map(nativeFor);
  for (const [index, molecule] of molecules.entries()) {
    expect(molecule.type).toBe("molecule");
    if (molecule.type !== "molecule") throw new Error("Expected a molecule");
    expect(molecule.atoms.map(atom => atom.element)).toEqual(index === 2 ? ["C", "C", "O", "O"] : ["C", "C", "O"]);
    expect(molecule.bonds.map(bond => bond.order)).toEqual([["single", "single"], ["single", "double"], ["single", "single", "double"]][index]);
  }
  const nativeArrows = arrows.map(nativeFor);
  for (const arrow of nativeArrows) {
    expect(arrow).toMatchObject({ type: "graphic", graphicKind: "path", data: { artToolId: "reactionArrow", markerEnd: { kind: "filled-arrow" } } });
  }
  const nativeSteps = documentReactionSummary(document);
  expect(nativeSteps).toHaveLength(2);
  steps.forEach((step, index) => {
    expect(resolve(step, "ReactionStepReactants", ["fragment", "group"]).flatMap(leaves)).toEqual([fragments[index]]);
    expect(resolve(step, "ReactionStepProducts", ["fragment", "group"]).flatMap(leaves)).toEqual([fragments[index + 1]]);
    expect(resolve(step, "ReactionStepArrows", ["arrow"])).toEqual([arrows[index]]);
    expect(nativeSteps[index].components).toEqual([
      { role: "reactant", objectId: molecules[index].id },
      { role: "product", objectId: molecules[index + 1].id }
    ]);
    expect(nativeSteps[index].arrowObjectIds).toEqual([nativeArrows[index].id]);
    const conditions = ["ReactionStepObjectsAboveArrow", "ReactionStepObjectsBelowArrow"]
      .flatMap(attribute => resolve(step, attribute, ["t"]));
    expect(nativeSteps[index].conditions.map(condition => condition.objectId)).toEqual(conditions.map(condition => nativeFor(condition).id));
  });

  for (const attachment of elements.filter(element => element.name === "bracketattachment")) {
    expect(resolve(attachment, "GraphicID", ["graphic"])).toHaveLength(1);
    for (const crossing of attachment.kids.filter(element => element.name === "crossingbond")) {
      const bonds = resolve(crossing, "BondID", ["b"]);
      const atoms = resolve(crossing, "InnerAtomID", ["n"]);
      expect(bonds).toHaveLength(1);
      expect(atoms).toHaveLength(1);
      expect([bonds[0].attrs.B, bonds[0].attrs.E]).toContain(atoms[0].attrs.id);
    }
  }
}

function symbolicFixture(): string {
  // Rename every object and reference, including atom/bond and bracket attachment IDs, without
  // touching coordinates or other numbers. The checked-in fixture remains unchanged.
  const references = new Set(["id", "B", "E", "GraphicID", "BondID", "InnerAtomID", "BracketedObjectIDs",
    "ReactionStepReactants", "ReactionStepProducts", "ReactionStepArrows"]);
  let source = fixture.replace(/(\w+)="([^"]*)"/g, (attribute, name: string, value: string) => references.has(name)
    ? `${name}="${idList(value).map(id => `symbolic-${id}`).join(" ")}"` : attribute);
  source = source.replace('<fragment id="symbolic-f2">', '<group id="intermediate-group"><fragment id="symbolic-f2">')
    .replace('</fragment>\n<arrow id="symbolic-arr2"', '</fragment></group>\n<arrow id="symbolic-arr2"')
    .replace('ReactionStepProducts="symbolic-f2"', 'ReactionStepProducts="intermediate-group"')
    .replace('ReactionStepReactants="symbolic-f2"', 'ReactionStepReactants="intermediate-group"')
    .replace('<scheme id="symbolic-sch1">', '<t id="conditions-first" p="112 82"><s>condition A</s></t>\n<t id="conditions-second" p="222 118"><s>condition B</s></t>\n<scheme id="symbolic-sch1">')
    .replace('id="symbolic-st1"', 'id="symbolic-st1" ReactionStepObjectsAboveArrow="conditions-first"')
    .replace('id="symbolic-st2"', 'id="symbolic-st2" ReactionStepObjectsBelowArrow="conditions-second"')
    .replace('<fragment id="symbolic-f4">', '<fragment id="symbolic-f4"><t id="polymer-caption" p="80 245"><s>polymer caption</s></t>');
  return source;
}

function expectSru(document: ChemDraftDocument) {
  const objects = document.pages[0].objects;
  const brackets = objects.filter((object): object is BracketObject => object.type === "bracket");
  expect(brackets).toHaveLength(2);
  expect(brackets.every(bracket => bracket.bracketKind === "square" && bracket.bracketUsage === "sru")).toBe(true);
  expect(brackets.filter(bracket => bracket.label === "n")).toHaveLength(1);
  for (const bracket of brackets) expect(bracket.crossingBondIds).toHaveLength(1);
  expect(objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
}

it.each([false, true])("preserves a scheme and SRU through CDX (native payload: %s)", embedNativePayload => {
  const imported = openChemDraftPayload(fixture);
  expect(imported.document).toBeDefined();
  expectSru(imported.document!);

  const exported = exportDocumentToCdx(imported.document!, { embedNativePayload });
  const reopened = importCdx(exported.bytes);
  expect(reopened.document).toBeDefined();
  expectSru(reopened.document!);
  expect(reopened.warnings.some(warning => warning.code === "cdxml.bracket_group_preserved")).toBe(false);
  if (!embedNativePayload) {
    expectScheme(readCdx(exported.bytes), reopened.document!);
  }
});

it("resolves symbolic scheme, group, text and bracket attachments through visible CDX", () => {
  const imported = openChemDraftPayload(symbolicFixture());
  expect(imported.document).toBeDefined();
  expectSru(imported.document!);
  const exported = exportDocumentToCdx(imported.document!, { embedNativePayload: false });
  expect(exported.warnings.filter(warning => warning.code === "cdx.unencodable_data")).toEqual([]);
  const tree = readCdx(exported.bytes);
  const reopened = importCdx(exported.bytes);
  expect(reopened.document).toBeDefined();
  expect(reopened.warnings.filter(warning => ["cdxml.reaction_reference_unresolved", "cdxml.bracket_crossing_unresolved",
    "cdxml.bracket_group_preserved"].includes(warning.code))).toEqual([]);
  expectSru(reopened.document!);
  expectScheme(tree, reopened.document!);
  expect(descendants(tree).filter(element => element.name === "group")).toHaveLength(1);
  const steps = documentReactionSummary(reopened.document!);
  expect(steps.map(step => step.conditions.map(condition => condition.text))).toEqual([["condition A"], ["condition B"]]);
  expect(reopened.document!.pages[0].objects.filter(object => object.type === "text" && object.text === "polymer caption")).toHaveLength(1);
});
