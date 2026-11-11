import { describe, expect, it } from "vitest";
import { describeDocument, describeStructure } from "./chemistry";
import { open, interchange } from "./codec";
import { compare, compareSurvival, warning, type MoleculeSummary, type Summary } from "./model";
import { compareExactGraph, compareSigma } from "./sigma";
import { nativeSurvival, sourceSurvival } from "./survival";
import { parseSourceXml } from "./xml";
import { writeCdx } from "../../packages/cdx-compat/src/cdxBinary";

const wrap = (content: string) => `<CDXML><page id="1">${content}</page></CDXML>`;
const summary = (m: MoleculeSummary): Summary => ({ molecules: [m], reactions: [], standaloneAbbreviations: [], standaloneRGroups: [], drawing: { arrows: [], brackets: [], "text-styling": 0, colours: [], pages: 1, "other-graphics": [] } });
const reordered = (m: MoleculeSummary): MoleculeSummary => {
  const copy = structuredClone(m), remap = (i: number) => m.atomCount - i - 1;
  copy.featureAtoms?.reverse();
  copy.species?.graph?.atoms.reverse();
  for (const bonds of [copy.species?.graph?.bonds, copy.featureBonds]) for (const b of bonds ?? []) b.atoms = b.atoms.map(remap) as [number, number];
  return copy;
};

describe("named step-link loss diagnostics", () => {
  it.each(["cdxml", "cdx"] as const)("requires a named step and arrow-link attribute for a warned %s loss", async format => {
    const xml = wrap('<graphic id="10" GraphicType="Line" ArrowType="FullHead" BoundingBox="60 60 120 60"/>' +
      '<step id="21" ReactionStepArrows="10"/>');
    const bytes = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
    const before = sourceSurvival(bytes);
    const imported = await open(bytes);
    const reaction = imported.document!.pages[0].objects.find(object => object.type === "reaction")!;
    reaction.arrowObjectIds = [];
    const after = nativeSurvival(imported.document!);
    const named = warning({ code: "cdxml.reaction_step_preserved", sourceObjectId: "21",
      message: 'CDX step 21: arrow link ReactionStepArrows="10" was not imported natively; source data is preserved.' });
    expect(compareSurvival(before, after, [named])).toMatchObject({ verdict: "WARNED", differences: [
      { feature: "reaction-step-arrow", warned: true }
    ] });
    // Rescoring old private rows must use the diagnostic, not an obsolete feature map.
    expect(compareSurvival(before, after, [{ ...named, features: [] }]).verdict).toBe("WARNED");
    for (const diagnostic of [
      { code: "cdxml.object_import_unsupported", sourceObjectId: "21", message: "Imported unsupported step 21 as an unknown compatibility object." },
      { code: "cdxml.reaction_step_preserved", sourceObjectId: "21", message: "Some reaction arrow links were preserved." },
      { code: "cdxml.reaction_step_preserved", sourceObjectId: "21", message: 'CDX step 21: reactants link ReactionStepReactants="2" was not imported natively.' },
      { code: "cdxml.reaction_step_preserved", message: 'ReactionStepArrows="10" was not imported natively.' }
    ]) expect(compareSurvival(before, after, [warning(diagnostic)])).toMatchObject({ verdict: "FAIL", differences: [
      { feature: "reaction-step-arrow", warned: false }
    ] });
    expect(compareSurvival(before, after, [{ ...named, message: "Generic preservation warning" }]).verdict).toBe("FAIL");
  });

  it.each(["Solid", undefined, "Dashed"])("counts separate arrowheads on a %s line through visible round trips", async lineType => {
    const xml = wrap(`<graphic id="10" GraphicType="Line" ArrowheadHead="Full" ArrowheadTail="None" ArrowheadType="Solid"
      ${lineType ? `LineType="${lineType}"` : ""} BoundingBox="60 60 120 60"/><step id="21" ReactionStepArrows="10"/>`);
    for (const format of ["cdxml", "cdx"] as const) {
      let bytes: Uint8Array = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
      for (let cycle = 0; cycle <= 3; cycle++) {
        const document = (await open(bytes)).document!;
        expect(sourceSurvival(bytes)).toMatchObject({ stepArrows: 1, stepArrowLinks: [1], display: { arrow: 1 } });
        expect(nativeSurvival(document)).toMatchObject({ stepArrows: 1, stepArrowLinks: [1], display: { arrow: 1 } });
        if (cycle < 3) bytes = (await interchange(document, format)).bytes;
      }
    }
  });
});

describe("object-specific bracket loss diagnostics", () => {
  const bracket = (id: number, kind = "Square") => `<graphic id="${id}" GraphicType="Bracket" BracketType="${kind}" BoundingBox="${id * 5} 30 ${id * 5 + 8} 90"/>`;
  const group = (id: number, graphics: number[], children = "") => `<bracketedgroup id="${id}" RepeatCount="3">${graphics.map((graphic, index) => `<bracketattachment id="${id * 10 + index}" GraphicID="${graphic}"/>`).join("")}${children}</bracketedgroup>`;
  it.each([
    ["curly", bracket(10, "Curly") + bracket(11), 2, 0],
    ["four attachments", [10, 11, 12, 13].map(id => bracket(id, "Round")).join("") + group(20, [10, 11, 12, 13]), 4, 1],
    ["nested", [10, 11, 12, 13, 14, 15].map(id => bracket(id)).join("") + group(20, [10, 11], group(21, [12, 13], group(22, [14, 15]))), 6, 3]
  ] as const)("requires each missing %s object's own warning in both formats", async (_shape, content, glyphs, groups) => {
    const xml = wrap(content);
    for (const bytes of [Buffer.from(xml), writeCdx(parseSourceXml(xml))]) {
      const source = sourceSurvival(bytes), imported = await open(bytes);
      const native = nativeSurvival(imported.document!);
      expect(source.display["graphic.Bracket"]).toBe(glyphs);
      expect(source.display.bracketedgroup ?? 0).toBe(groups);
      expect(compareSurvival(source, native, imported.warnings).verdict).toBe("WARNED");
      expect(compareSurvival(source, native, [warning({ code: "cdxml.object_import_unsupported", sourceObjectId: "999", message: "Bracket group 999 was not imported" })]).verdict).toBe("DRAWN-DIFFERENTLY");
      if (groups === 3) {
        const oneGroupOnly = imported.warnings.filter(warning => warning.objectId !== "22");
        expect(compareSurvival(source, native, oneGroupOnly).verdict).toBe("DRAWN-DIFFERENTLY");
      }
    }
  });
});

describe("connectivity measurement", () => {
  it.each(["cdxml", "cdx"] as const)("ignores atom reordering around an expanded abbreviation through %s", async format => {
    const xml = wrap(`<fragment id="2"><n id="10" Element="7" p="0 0"/>
      <n id="11" NodeType="Nickname" p="30 0"><t><s>OMe</s></t><fragment id="12">
        <n id="13" NodeType="ExternalConnectionPoint" p="0 0"/><n id="14" Element="8" p="30 0"/>
        <n id="15" Element="6" p="60 0"/><b id="16" B="13" E="14" Order="1"/><b id="17" B="14" E="15" Order="1"/>
      </fragment></n><n id="19" Element="6" p="0 30"/>
      <b id="18" B="10" E="11" Order="1"/><b id="20" B="10" E="19" Order="1"/></fragment>`);
    const before = (await open(Buffer.from(xml))).document!;
    const after = (await open((await interchange(before, format)).bytes)).document!;
    const elements = (d: typeof before) => d.pages[0].objects.flatMap(o => o.type === "molecule" ? o.atoms.map(a => a.element) : []);
    expect(elements(after)).not.toEqual(elements(before));
    const a = await describeDocument(before, []), b = await describeDocument(after, []);
    expect(a.molecules[0].smiles).toBe(b.molecules[0].smiles);
    expect(compare(a, b, []).differences.filter(d => ["connectivity", "bond-order"].includes(d.feature))).toEqual([]);
  });

  it("checks equal connectivity values before consulting exhausted sigma evidence", async () => {
    const a = await describeStructure("C.C.C.C.C.C.C.C.C.C"), b = structuredClone(a);
    a.species!.graph!.atoms[0].isotope = b.species!.graph!.atoms[0].isotope = 13;
    a.species!.graph!.atoms[0].charge = b.species!.graph!.atoms[1].charge = 1;
    b.smiles = "synthetic differing identity";
    expect(compareSigma(a, b)?.status).toBe("undetermined");
    expect(compare(summary(a), summary(b), []).differences.filter(d => d.feature === "connectivity")).toEqual([]);
  });

  it("uses equal canonical SMILES before graph-search evidence", async () => {
    const a = await describeStructure("COC"), b = reordered(a);
    b.connectivity = "synthetic reordered recovery key";
    const result = compare(summary(a), summary(b), [], { exactGraphBudget: 0 });
    expect(result.verdict).toBe("PASS");
    expect(result.undetermined).toBeUndefined();
    expect(result.differences).toEqual([]);
  });

  it("finds an exact order-preserving automorphism instead of trusting the first sigma mapping", async () => {
    const a = await describeStructure("CCCCC"), b = reordered(a);
    // Synthetic graph with identical atom/H labels but asymmetric bond orders.
    a.species!.graph!.atoms.forEach(atom => { atom.h = 0; });
    b.species!.graph!.atoms.forEach(atom => { atom.h = 0; });
    a.species!.graph!.bonds[0].order = b.species!.graph!.bonds[0].order = 2;
    a.connectivity = "synthetic left key"; b.connectivity = "synthetic right key";
    a.smiles = "synthetic left identity"; b.smiles = "synthetic right identity";
    expect(compareSigma(a, b)?.orders?.[0]).not.toEqual(compareSigma(a, b)?.orders?.[1]);
    expect(compareExactGraph(a, b)).toBe("isomorphic");
    expect(compare(summary(a), summary(b), []).differences.filter(d => ["connectivity", "bond-order"].includes(d.feature))).toEqual([]);
  });

  it("reports a genuine bond-order change", async () => {
    const a = await describeStructure("CC"), b = await describeStructure("C=C");
    expect(compareExactGraph(a, b)).toBe("different");
    const result = compare(summary(a), summary(b), []);
    expect(result.verdict).toBe("FAIL");
    expect(result.differences.some(d => ["connectivity", "bond-order"].includes(d.feature))).toBe(true);
  });

  it("reports exhausted exact checks as undetermined, with neither equality nor a difference", async () => {
    const a = await describeStructure("CCCOC"), b = reordered(a);
    b.connectivity = "synthetic noncanonical recovery key";
    b.smiles = "synthetic identity requiring graph confirmation";
    expect(compareExactGraph(a, b, 1)).toBe("undetermined");
    const result = compare(summary(a), summary(b), [], { exactGraphBudget: 1 });
    expect(result.verdict).toBe("ERROR");
    expect(result.undetermined?.map(u => u.feature)).toEqual(["connectivity", "bond-order"]);
    expect(result.differences).toEqual([]);
    expect(result.identityPasses).toBeUndefined();
  });

  it("does not equate regular graphs that colour refinement cannot distinguish", async () => {
    const a = await describeStructure("C1CCCCC1"), b = await describeStructure("C1CC1.C1CC1");
    expect(compareExactGraph(a, b)).toBe("different");
    expect(compare(summary(a), summary(b), []).verdict).toBe("FAIL");
  });

  it.each(["z", "charge", "isotope", "h", "order"] as const)("requires exact agreement for %s labels", async feature => {
    const a = await describeStructure("CO"), b = structuredClone(a);
    if (feature === "order") b.species!.graph!.bonds[0].order++;
    else b.species!.graph!.atoms[0][feature]++;
    expect(compareExactGraph(a, b)).toBe("different");
  });
});

describe("shared abbreviation classification", () => {
  it.each([false, true])("excludes a text-only Unspecified atom with a symbolic Element property: %s", async symbolicElement => {
    const xml = wrap(`<fragment id="2"><n id="10" NodeType="Unspecified"${symbolicElement ? ' Element="Qq"' : ''} Charge="1" p="60 60"><t id="11"><s>Qq</s></t></n></fragment>`);
    for (const format of ["cdxml", "cdx"] as const) {
      let bytes: Uint8Array = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
      for (let cycle = 0; cycle < 3; cycle++) {
        const document = (await open(bytes)).document!;
        const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
        expect(molecule.atoms).toMatchObject([{ element: "Qq", labelLiteral: true, formalCharge: 1 }]);
        expect(molecule.superatoms).toHaveLength(0);
        expect(sourceSurvival(bytes).abbreviations).toBe(0);
        expect(nativeSurvival(document).abbreviations).toBe(0);
        bytes = (await interchange(document, format)).bytes;
      }
    }
  });

  it.each(["Fragment", "Nickname", "Unspecified"])("counts only outer and expanded inner %s records, never placeholders or connection points", async nodeType => {
    const xml = wrap(`<fragment id="2"><n id="10" NodeType="${nodeType}" p="60 60"><t id="11"><s>Outer</s></t><fragment id="12">
      <n id="13" NodeType="GenericNickname" GenericNickname="Placeholder" p="60 60"/>
      <n id="14" NodeType="Unspecified" p="90 60"><t id="15"><s>Literal</s></t></n>
      <n id="16" NodeType="${nodeType}" p="120 60"><fragment id="17"><n id="18" Element="8" p="120 60"/></fragment><t id="19"><s>Inner</s></t></n>
      <n id="20" NodeType="ExternalConnectionPoint"/>
      <b id="21" B="20" E="16" Order="1"/>
    </fragment></n></fragment>`);
    for (const format of ["cdxml", "cdx"] as const) {
      let bytes: Uint8Array = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
      for (let cycle = 0; cycle < 3; cycle++) {
        const document = (await open(bytes)).document!;
        const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
        expect(molecule.superatoms.map(group => group.label).sort()).toEqual(["Inner", "Outer"]);
        expect(molecule.atoms.map(atom => atom.element).sort()).toEqual(["Literal", "O", "Placeholder"]);
        expect(sourceSurvival(bytes).abbreviations).toBe(2);
        expect(nativeSurvival(document).abbreviations).toBe(2);
        bytes = (await interchange(document, format)).bytes;
      }
    }
  });

  it.each(["charge", "connections", "alternatives", "depth", "unlabelled"])("matches the import gate for %s and does not count hidden descendants", async reason => {
    let node = '<n id="30" NodeType="Nickname"><fragment id="31"><n id="32" Element="8"/></fragment><t id="33"><s>Inner</s></t></n>';
    if (reason === "depth") for (let i = 6; i >= 0; i--) node = `<n id="${40 + i * 3}" NodeType="Nickname"><fragment id="${41 + i * 3}">${node}</fragment><t id="${42 + i * 3}"><s>Layer${i}</s></t></n>`;
    else node = `<n id="10" NodeType="${reason === "alternatives" ? "AnonymousAlternativeGroup" : "Nickname"}"${reason === "charge" ? ' Charge="1"' : ''}>
      <fragment id="11">${node}${reason === "connections" ? '<n id="12" NodeType="ExternalConnectionPoint"/><n id="13" NodeType="ExternalConnectionPoint"/>' : ''}</fragment>
      ${reason === "unlabelled" ? '' : '<t id="14"><s>Outer</s></t>'}</n>`;
    const xml = wrap(`<fragment id="2">${node}</fragment>`);
    for (const bytes of [Buffer.from(xml), writeCdx(parseSourceXml(xml))]) {
      const document = (await open(bytes)).document!;
      const records = document.pages[0].objects.flatMap(object => object.type === "molecule" ? object.superatoms : []);
      const expected = reason === "depth" ? 5 : reason === "unlabelled" ? 1 : 0;
      expect(records).toHaveLength(expected);
      expect(sourceSurvival(bytes).abbreviations).toBe(expected);
      expect(nativeSurvival(document).abbreviations).toBe(expected);
    }
  });

  it.each(["Dashed", "Bold"])("counts the step link to a %s Line graphic in CDXML and CDX", async lineType => {
    const xml = wrap(`<graphic id="10" GraphicType="Line" ArrowType="FullHead" LineType="${lineType}" HeadSize="1000" Z="2" BoundingBox="60 60 120 60"/>
      <scheme id="20"><step id="21" ReactionStepArrows="10"/></scheme>`);
    for (const format of ["cdxml", "cdx"] as const) {
      let bytes: Uint8Array = format === "cdx" ? writeCdx(parseSourceXml(xml)) : Buffer.from(xml);
      for (let cycle = 0; cycle < 3; cycle++) {
        const document = (await open(bytes)).document!;
        expect(sourceSurvival(bytes)).toMatchObject({ stepArrows: 1, stepArrowLinks: [1], display: { arrow: 1 } });
        expect(nativeSurvival(document)).toMatchObject({ stepArrows: 1, stepArrowLinks: [1], display: { arrow: 1 } });
        bytes = (await interchange(document, format)).bytes;
      }
    }
  });

  it.each([undefined, "Element", "Nickname", "Fragment", "Formula", "GenericNickname", "Monomer", "4", "5", "6", "7", "14"])("counts labelled nested fragments with NodeType %s on both sides", async nodeType => {
    const xml = `<CDXML><page><fragment><n id="3"${nodeType ? ` NodeType="${nodeType}"` : ""}><t><s>Me</s></t><fragment><n id="5" Element="6"/></fragment></n></fragment></page></CDXML>`;
    for (const bytes of [Buffer.from(xml), writeCdx(parseSourceXml(xml))]) {
      expect(sourceSurvival(bytes).abbreviations).toBe(1);
      expect(nativeSurvival((await open(bytes)).document!).abbreviations).toBe(1);
    }
  });

  it.each(["Nickname", "Fragment", "Formula", "GenericNickname", "Monomer", "4", "5", "6", "7", "14"])("excludes blank %s placeholders on both sides", async nodeType => {
    const xml = `<CDXML><page><fragment><n id="3" NodeType="${nodeType}" GenericNickname=" "/></fragment></page></CDXML>`;
    for (const bytes of [Buffer.from(xml), writeCdx(parseSourceXml(xml))]) {
      const document = (await open(bytes)).document!;
      const molecule = document.pages[0].objects.find(object => object.type === "molecule");
      expect(molecule?.type === "molecule" && molecule.atoms[0]).toMatchObject({ element: "*", labelLiteral: true });
      expect(sourceSurvival(bytes).abbreviations).toBe(0);
      expect(nativeSurvival(document).abbreviations).toBe(0);
    }
  });

  it.each(["Nickname", "Fragment", "Formula", "GenericNickname", "Monomer", "4", "5", "6", "7", "14"])("excludes property-only %s labels on both sides", async nodeType => {
    const bytes = Buffer.from(wrap(`<fragment id="2"><n id="10" NodeType="${nodeType}" GenericNickname="OMe" p="0 0"/></fragment>`));
    const document = (await open(bytes)).document!;
    expect(sourceSurvival(bytes).abbreviations).toBe(0);
    expect(nativeSurvival(document).abbreviations).toBe(0);
  });

  it.each(["R", "R1", "R'", "R''"])("excludes %s on both sides in CDXML and CDX", async label => {
    for (const node of [
      `<n id="10" NodeType="GenericNickname" GenericNickname="${label}" p="0 0"/>`,
      `<n id="10"><t><s>${label}</s></t><fragment><n id="11" Element="6"/></fragment></n>`
    ]) {
      const xml = wrap(`<fragment id="2">${node}</fragment>`);
      for (const bytes of [Buffer.from(xml), writeCdx(parseSourceXml(xml))]) {
        expect(sourceSurvival(bytes).abbreviations).toBe(0);
        expect(nativeSurvival((await open(bytes)).document!).abbreviations).toBe(0);
      }
    }
  });

  it("excludes unexpanded text and property-only labels on both sides", async () => {
    const bytes = Buffer.from(wrap(`<fragment id="2">
      <n id="10" NodeType="Formula" p="0 0"><t><s>OMe</s></t></n>
      <n id="11" NodeType="Monomer" GenericNickname="Me" p="30 0"><t><s> </s></t></n>
      <n id="12" NodeType="GenericNickname" GenericNickname=" " p="60 0"><t><s> </s></t></n>
      </fragment>`));
    expect(sourceSurvival(bytes).abbreviations).toBe(0);
    expect(nativeSurvival((await open(bytes)).document!).abbreviations).toBe(0);
  });

  it("counts only the outer record when the bonded inner label has no expansion attachment", async () => {
    const xml = wrap(`<fragment id="2"><n id="10" NodeType="Nickname" p="0 0"><t><s>Et</s></t><fragment id="11">
      <n id="12" Element="6" p="0 0"/><n id="13" NodeType="Fragment" p="30 0"><t><s>Me</s></t>
        <fragment id="14"><n id="15" Element="6" p="30 0"/></fragment></n><b id="16" B="12" E="13" Order="1"/>
      </fragment></n></fragment>`);
    const bytes = Buffer.from(xml), document = (await open(bytes)).document!;
    expect(sourceSurvival(bytes).abbreviations).toBe(1);
    expect(nativeSurvival(document).abbreviations).toBe(1);
    for (const format of ["cdxml", "cdx"] as const) {
      const exported = await interchange(document, format);
      expect(sourceSurvival(exported.bytes).abbreviations).toBe(1);
      expect(nativeSurvival((await open(exported.bytes)).document!).abbreviations).toBe(1);
    }
  });
});
