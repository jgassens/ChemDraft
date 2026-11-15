import { describe, expect, it } from "vitest";
import { describeDocument } from "./chemistry";
import { compare, compareSurvival } from "./model";
import { parseSourceXml } from "./xml";
import { writeCdx } from "../../packages/cdx-compat/src/cdxBinary";
import { interchange, open } from "./codec";
import { sourceSurvival, nativeSurvival } from "./survival";

// Authored synthetic inputs only. No private files or corpus-derived coordinates/text.
const fixture = (participants: string, objects: string, conditions = "") => `<CDXML><page id="1">
  <scheme id="900"><step id="901" ReactionStepReactants="${participants}"
    ReactionStepProducts="20" ReactionStepObjectsBelowArrow="${conditions}"/></scheme>
  <fragment id="20"><n id="21" Element="8" p="100 0"/></fragment>${objects}</page></CDXML>`;
async function imported(xml: string) {
  const result = await open(Buffer.from(xml));
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  return result.document!;
}

describe("synthetic reaction scheme summaries", () => {
  it.each(["cdxml", "cdx"] as const)("measures every link in a two-arrow step through %s round trips", async format => {
    const xml = `<CDXML><page id="1"><scheme id="90"><step id="91" ReactionStepArrows="51 52"/></scheme>
      <arrow id="51" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      <arrow id="52" Tail3D="0 20 0" Head3D="30 20 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      </page></CDXML>`;
    const source = sourceSurvival(Buffer.from(xml));
    expect(source).toMatchObject({ stepArrows: 2, stepArrowLinks: [2] });
    const document = await imported(xml);
    const before = await describeDocument(document, []);
    expect(compareSurvival(source, before.survival!, []).verdict).toBe("PASS");
    const reopened = (await open((await interchange(document, format)).bytes)).document!;
    const kept = await describeDocument(reopened, []);
    expect(kept.survival).toEqual(source);
    expect(compare(before, kept, []).verdict).toBe("PASS");
    const reaction = reopened.pages[0].objects.find(o => o.type === "reaction")!;
    expect(reaction.arrowObjectIds).toHaveLength(2);
    reaction.arrowObjectIds!.splice(1, 1);
    const lost = await describeDocument(reopened, []);
    expect(lost.survival).toMatchObject({ stepArrows: 1, stepArrowLinks: [1] });
    expect(compareSurvival(source, lost.survival!, [])).toMatchObject({ verdict: "FAIL", differences: [
      { feature: "reaction-step-arrow", before: { totalLinks: 2, linksPerStep: [2] }, after: { totalLinks: 1, linksPerStep: [1] }, warned: false }
    ] });
    expect(compare(before, lost, []).verdict).toBe("FAIL");
  });

  it("reports a link moved to another step even when the total and both arrow drawings survive", async () => {
    const document = await imported(`<CDXML><page id="1"><scheme id="90">
      <step id="91" ReactionStepArrows="51 52"/><step id="92" ReactionStepArrows="53"/></scheme>
      <arrow id="51" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full"/>
      <arrow id="52" Tail3D="0 20 0" Head3D="30 20 0" ArrowheadHead="Full"/>
      <arrow id="53" Tail3D="0 40 0" Head3D="30 40 0" ArrowheadHead="Full"/>
      </page></CDXML>`);
    const before = await describeDocument(document, []);
    const reactions = document.pages[0].objects.filter(o => o.type === "reaction");
    reactions[1].arrowObjectIds!.push(reactions[0].arrowObjectIds!.pop()!);
    const after = await describeDocument(document, []);
    expect(before.survival).toMatchObject({ stepArrows: 3, stepArrowLinks: [2, 1] });
    expect(after.survival).toMatchObject({ stepArrows: 3, stepArrowLinks: [1, 2] });
    expect(compareSurvival(before.survival!, after.survival!, []).verdict).toBe("FAIL");
    expect(compare(before, after, []).verdict).toBe("FAIL");
  });

  it.each(["cdxml", "cdx"] as const)("preserves links through SupersededBy in %s input", async format => {
    const xml = `<CDXML><page id="1"><scheme id="90"><step id="91" ReactionStepArrows="50"/></scheme>
      <graphic id="50" GraphicType="Line" ArrowType="FullHead" SupersededBy="51" BoundingBox="0 0 30 0"/>
      <arrow id="51" Tail3D="0 0 0" Head3D="30 0 0" ArrowheadHead="Full" ArrowheadType="Solid"/>
      </page></CDXML>`;
    const bytes = format === "cdxml" ? Buffer.from(xml) : writeCdx(parseSourceXml(xml));
    const source = sourceSurvival(bytes);
    // The superseded legacy graphic is not a second display object or a loss.
    expect(source).toEqual({ stepArrows: 1, stepArrowLinks: [1], stepIds: ["91"], abbreviations: 0, display: { arrow: 1 }, displayObjectIds: { arrow: ["51"] } });
    const opened = await open(bytes);
    const preserved = await describeDocument(opened.document!, []);
    expect(preserved.survival!.stepArrows).toBe(1);
    expect(compareSurvival(source, preserved.survival!, opened.warnings)).toMatchObject({ verdict: "PASS", differences: [] });
    // Direct reference to the replacement survives; the superseded graphic adds no display loss.
    const survivingXml = xml.replace('ReactionStepArrows="50"', 'ReactionStepArrows="51"');
    const survivingBytes = format === "cdxml" ? Buffer.from(survivingXml) : writeCdx(parseSourceXml(survivingXml));
    const surviving = await open(survivingBytes);
    const before = await describeDocument(surviving.document!, []);
    expect(before.survival).toEqual(source);
    expect(compareSurvival(source, before.survival!, []).verdict).toBe("PASS");
    for (const route of [["cdxml"], ["cdx"], ["cdx", "cdxml", "cdx"]] as const) {
      let current = surviving.document!;
      for (const leg of route) current = (await open((await interchange(current, leg)).bytes)).document!;
      expect(compare(before, await describeDocument(current, []), []).verdict).toBe("PASS");
    }
    const reaction = surviving.document!.pages[0].objects.find(o => o.type === "reaction")!;
    reaction.arrowObjectIds = [];
    const after = await describeDocument(surviving.document!, []);
    expect(compareSurvival(source, after.survival!, [])).toMatchObject({ verdict: "FAIL", differences: [{ feature: "reaction-step-arrow", before: { totalLinks: 1, linksPerStep: [1] }, after: { totalLinks: 0, linksPerStep: [0] }, warned: false }] });
    expect(compare(before, after, []).verdict).toBe("FAIL");
    // A dangling native reference does not resolve to a surviving arrow either.
    reaction.arrowObjectIds = ["missing-arrow"];
    expect(nativeSurvival(surviving.document!).stepArrows).toBe(0);
  });

  it("counts source links, labelled abbreviations and display objects before import", async () => {
    const xml = `<CDXML><page id="1"><scheme id="90"><step id="91" ReactionStepArrows="50"/></scheme>
      <graphic id="50" GraphicType="Line" SupersededBy="51"/><arrow id="51"/>
      <graphic id="52" GraphicType="Oval" OvalType="Circle" BoundingBox="0 0 10 10"/>
      <fragment id="10"><n id="11" NodeType="Nickname" p="0 0"><t><s>Me</s></t></n></fragment></page></CDXML>`;
    const source = sourceSurvival(Buffer.from(xml));
    expect(source).toEqual({ stepArrows: 1, stepArrowLinks: [1], stepIds: ["91"], abbreviations: 0, display: { arrow: 1, "graphic.Oval.Circle": 1 }, displayObjectIds: { arrow: ["51"], "graphic.Oval.Circle": ["52"] } });
    const noCircle = sourceSurvival(Buffer.from(xml.replace(/<graphic id="52"[^>]*\/>/, "")));
    expect(noCircle.display["graphic.Oval.Circle"] ?? 0).toBe(0);
    expect(sourceSurvival(Buffer.from(xml.replace('SupersededBy="51"', 'SupersededBy="999"'))).stepArrows).toBe(0);
    expect(sourceSurvival(Buffer.from(xml.replace('NodeType="Nickname"', 'NodeType="Element"'))).abbreviations).toBe(0);
    const document = await imported(fixture("10", '<fragment id="10"><n id="11" Element="6" p="0 0"/></fragment>'));
    expect(nativeSurvival(document).stepArrows).toBe(0);
  });
  it("compares exact multi-run condition text on all three interchange routes", async () => {
    const document = await imported(fixture("10", `<fragment id="10"><n id="11" Element="6" p="0 0"/></fragment>
      <t id="60" p="50 20"><s font="3">Na</s><s face="32">2</s><s>CO</s><s face="32">3</s><s font="4">\nTHF,  25 °C\n</s><s font="3">2 h</s></t>`, "60"));
    const before = await describeDocument(document, []);
    expect(before.reactions[0].conditions).toEqual(["Na2CO3\nTHF,  25 °C\n2 h"]);
    for (const formats of [["cdxml"], ["cdx"], ["cdx", "cdxml", "cdx"]] as const) {
      let current = document;
      for (const format of formats) current = (await open((await interchange(current, format)).bytes)).document!;
      const after = await describeDocument(current, []);
      expect(after.reactions[0].conditions).toEqual(before.reactions[0].conditions);
      expect(compare(before, after, []).verdict).toBe("PASS");
    }
    const condition = document.pages[0].objects.find(o => o.type === "text")!;
    condition.text = condition.text.replace("25 °C", "25  °C");
    expect(compare(before, await describeDocument(document, []), []).differences)
      .toContainEqual(expect.objectContaining({ feature: "reaction-roles" }));
  });

  it("records text participants by kind and exact text, retaining role, multiplicity and changes", async () => {
    const document = await imported(fixture("60 61", '<t id="60" p="0 0"><s>reagent A</s></t><t id="61" p="0 20"><s>reagent A</s></t>'));
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    expect(before.reactions[0].reactants).toEqual([{ kind: "text", text: "reagent A" }, { kind: "text", text: "reagent A" }]);
    for (const format of ["cdxml", "cdx"] as const) {
      const reopened = (await open((await interchange(document, format)).bytes)).document!;
      expect(compare(before, await describeDocument(reopened, []), []).verdict).toBe("PASS");
    }
    const reaction = document.pages[0].objects.find(o => o.type === "reaction")!;
    reaction.components.reverse();
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("PASS");
    reaction.components[0].role = "agent";
    expect(compare(before, await describeDocument(document, []), []).differences).toContainEqual(expect.objectContaining({ feature: "reaction-roles" }));
    reaction.components[0].role = "reactant";
    const text = document.pages[0].objects.find(o => o.type === "text")!;
    text.text = "reagent B";
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
    text.text = "reagent A";
    reaction.components.pop();
    expect(compare(before, await describeDocument(document, []), []).verdict).toBe("FAIL");
  });

  it.each(["Resin", "A"])("keeps abbreviation/generic %s participants as labelled graph identities", async label => {
    const document = await imported(fixture("10", `<fragment id="10"><n id="11" NodeType="GenericNickname" p="0 0"><t><s>${label}</s></t></n></fragment>`));
    const described = await describeDocument(document, []);
    expect(described.summaryErrors).toEqual([]);
    const molecule = described.molecules.find(m => m.dummyAtoms.some(d => d.label === label))!;
    expect(molecule).toBeDefined();
    expect(described.reactions[0].reactants).toEqual([molecule.smiles]);
  });

  it("expands participant groups without promoting decorative members to chemistry", async () => {
    const document = await imported(fixture("80", `<group id="80"><fragment id="10"><n id="11" Element="6" p="0 0"/></fragment>
      <t id="60" p="0 20"><s>reagent A</s></t><graphic id="70" GraphicType="Rectangle" BoundingBox="0 0 10 10"/></group>`));
    const before = await describeDocument(document, []);
    expect(before.summaryErrors).toEqual([]);
    expect(before.reactions[0].reactants).toEqual(expect.arrayContaining(["C", { kind: "text", text: "reagent A" }]));
    expect(before.reactions[0].reactants).toHaveLength(2);
    for (const format of ["cdxml", "cdx"] as const) {
      const reopened = (await open((await interchange(document, format)).bytes)).document!;
      expect(compare(before, await describeDocument(reopened, []), []).verdict).toBe("PASS");
    }
  });

  it("retains an unidentified molecule's role while keeping its RDKit failure as an error", async () => {
    const document = await imported(fixture("10", `<fragment id="10">
      <n id="11" Element="6" p="0 0"/><n id="12" Element="8" p="20 0"/>
      <b id="13" B="11" E="12" Order="1"/><b id="14" B="11" E="12" Order="1"/></fragment>`));
    const described = await describeDocument(document, []);
    expect(described.summaryErrors).toEqual([{ objectId: expect.any(String), summaryError: expect.objectContaining({ category: "summary.rdkit_rejected" }) }]);
    expect(described.reactions[0]).toMatchObject({
      reactants: [{ kind: "unidentified", objectType: "molecule" }],
      products: ["O"]
    });
    expect(compare(described, described, []).verdict).toBe("ERROR");
  });
});
