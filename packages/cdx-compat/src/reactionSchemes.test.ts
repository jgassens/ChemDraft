import { describe, expect, it } from "vitest";
import { createEmptyDocument, parseDocument, type ChemDraftDocument, type ReactionObject } from "@chemdraft/chem-core";
import { documentInventory, documentReactionSummary } from "@chemdraft/document-workflow-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

// Entirely authored synthetic fixtures; no source documents or corpus excerpts.
const fragment = (id: string, x: number, y = 60) => `<fragment id="${id}">
  <n id="${id}1" p="${x} ${y}" Element="6" Isotope="13"/>
  <n id="${id}2" p="${x + 15} ${y}" Element="8" Charge="-1"/>
  <b id="${id}3" B="${id}1" E="${id}2" Order="1"/>
</fragment>`;
const arrow = (id: string, x: number, kind = "FullHead") =>
  `<graphic id="${id}" GraphicType="Line" ArrowType="${kind}" BoundingBox="${x + 60} 60 ${x} 60"/>`;
const oneStep = (extraReactant = "", arrowKind = "FullHead") => `<CDXML><page id="1">
  <scheme id="900" Z="9"><step id="901" ReactionStepReactants="10 20${extraReactant}"
    ReactionStepProducts="30" ReactionStepArrows="50" ReactionStepObjectsAboveArrow="40"
    ReactionStepObjectsBelowArrow="60" ReactionStepPlusses="70"/></scheme>
  ${fragment("10", 10)}${fragment("20", 45)}${fragment("30", 190)}${fragment("40", 115, 20)}
  ${arrow("50", 100, arrowKind)}<t id="60" p="105 100"><s>25 °C, 2 h</s></t>
  <t id="70" p="35 60"><s>+</s></t>
</page></CDXML>`;
const visibleOnly = (contents: string) => contents.replace(/<objecttag\b[^>]*\/>/g, "");
const objects = (document: ChemDraftDocument) => document.pages[0].objects;
const reactions = (document: ChemDraftDocument) => objects(document).filter((object): object is ReactionObject => object.type === "reaction");
const originalId = (document: ChemDraftDocument, id: string) => objects(document).find(object => object.id === id)?.compatibility?.originalId;
const summary = (document: ChemDraftDocument) => documentReactionSummary(document).map(step => ({
  id: originalId(document, step.reactionId),
  components: step.components.map(component => ({ role: component.role, id: originalId(document, component.objectId) })),
  arrows: step.arrowObjectIds.map(id => originalId(document, id)),
  pluses: step.plusObjectIds.map(id => originalId(document, id)),
  conditions: step.conditions.map(condition => ({ id: originalId(document, condition.objectId), text: condition.text }))
}));
const stepAttributes = (contents: string) => [...contents.matchAll(/<step\s+([^>]+)\/>/g)].map(match =>
  Object.fromEntries([...match[1].matchAll(/([\w]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]])));

function importFixture(contents: string) {
  const opened = openChemDraftPayload(contents);
  expect(opened.document, JSON.stringify(opened.warnings)).toBeDefined();
  expect(opened.warnings.filter(warning => warning.code === "cdxml.object_import_unsupported" && /"(?:scheme|step)"/.test(warning.message))).toHaveLength(0);
  expect(objects(opened.document!).filter(object => object.type === "unknown-compatibility-object" && ["scheme", "step"].includes(object.sourceObjectType))).toHaveLength(0);
  return { document: opened.document!, warnings: opened.warnings };
}

describe("synthetic CDXML reaction schemes", () => {
  it("imports participants, an agent, conditions, arrows and pluses into the native reaction", () => {
    const { document } = importFixture(oneStep());
    expect(summary(document)).toEqual([{
      id: "901", components: [
        { role: "reactant", id: "10" }, { role: "reactant", id: "20" },
        { role: "product", id: "30" }, { role: "agent", id: "40" }
      ], arrows: ["50"], pluses: ["70"], conditions: [{ id: "60", text: "25 °C, 2 h" }]
    }]);
    expect(documentInventory(document).reactions).toEqual(documentReactionSummary(document));
    expect(reactions(document)[0].mappingState).toBe("absent");
  });

  it("round-trips source ids and every step list through visible CDXML, and native state exactly", () => {
    const source = oneStep();
    const { document } = importFixture(source);
    const exported = exportDocumentToCdxml(document);
    expect(exported.warnings).toEqual([]);
    expect(stepAttributes(exported.contents)).toEqual(stepAttributes(source));
    expect(exported.contents).toContain('<scheme Z="9" id="900">');
    expect(openChemDraftPayload(exported.contents).document).toEqual(document);
    const reopened = importFixture(visibleOnly(exported.contents)).document;
    expect(summary(reopened)).toEqual(summary(document));
    const graph = (doc: ChemDraftDocument) => objects(doc).flatMap(object => object.type === "molecule" ? [{
      id: object.compatibility?.originalId, atoms: object.atoms, bonds: object.bonds
    }] : []);
    expect(graph(reopened)).toEqual(graph(document));
    expect(stepAttributes(exportDocumentToCdxml(reopened).contents)).toEqual(stepAttributes(source));
  });

  it("keeps two steps ordered with one shared intermediate across repeated visible round trips", () => {
    const source = `<CDXML><page id="1"><scheme id="900">
      <step id="902" ReactionStepReactants="10" ReactionStepProducts="20" ReactionStepArrows="50"/>
      <step id="901" ReactionStepReactants="20" ReactionStepProducts="30" ReactionStepArrows="60"/>
    </scheme>${fragment("10", 0)}${arrow("50", 30)}${fragment("20", 110)}${arrow("60", 145)}${fragment("30", 220)}</page></CDXML>`;
    let { document } = importFixture(source);
    for (let iteration = 0; iteration < 3; iteration++) {
      const steps = reactions(document);
      expect(steps.map(step => step.compatibility?.originalId)).toEqual(["902", "901"]);
      expect(steps[0].components.find(component => component.role === "product")?.objectId)
        .toBe(steps[1].components.find(component => component.role === "reactant")?.objectId);
      expect(objects(document).filter(object => object.type === "molecule")).toHaveLength(3);
      const exported = exportDocumentToCdxml(document);
      expect(stepAttributes(exported.contents)).toEqual(stepAttributes(source));
      expect(exported.contents.match(/<scheme /g)).toHaveLength(1);
      document = importFixture(visibleOnly(exported.contents)).document;
    }
  });

  it("preserves an equilibrium arrow and its step reference without changing reaction roles", () => {
    const { document } = importFixture(oneStep("", "Equilibrium"));
    const reaction = reactions(document)[0];
    const linkedArrow = objects(document).find(object => object.id === reaction.arrowObjectIds?.[0]);
    expect(linkedArrow).toMatchObject({ type: "graphic", data: { artToolId: "equilibriumArrow" } });
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('ArrowType="Equilibrium"');
    expect(summary(importFixture(visibleOnly(exported.contents)).document)).toEqual(summary(document));
  });

  it("ignores an unresolved id with a named warning, retaining the resolved participants", () => {
    const { document, warnings } = importFixture(oneStep(" 999999"));
    expect(reactions(document)[0].components.filter(component => component.role === "reactant")).toHaveLength(2);
    expect(warnings.filter(warning => warning.code === "cdxml.reaction_reference_unresolved")).toEqual([
      expect.objectContaining({ sourceObjectId: reactions(document)[0].id, message: expect.stringContaining('ReactionStepReactants id "999999"') })
    ]);
    expect(stepAttributes(exportDocumentToCdxml(document).contents)[0].ReactionStepReactants).toBe("10 20");
  });

  it("resolves nested groups to roles while exporting the original container ids, including a singleton", () => {
    const source = `<CDXML><page id="1"><scheme id="900"><step id="901"
      ReactionStepReactants="80" ReactionStepProducts="30" ReactionStepArrows="50"
      ReactionStepObjectsAboveArrow="90 61" ReactionStepObjectsBelowArrow="60"/></scheme>
      <group id="80"><group id="81">${fragment("10", 0)}</group>${fragment("20", 40)}</group>
      ${fragment("30", 190)}${arrow("50", 100)}<group id="90">${fragment("40", 110, 20)}</group><t id="61" p="100 0"><s>dry</s></t>
      <t id="60" p="100 100"><s>heat</s></t></page></CDXML>`;
    const { document } = importFixture(source);
    expect(summary(document)[0].components).toEqual([
      { role: "reactant", id: "10" }, { role: "reactant", id: "20" },
      { role: "product", id: "30" }, { role: "agent", id: "40" }
    ]);
    expect(summary(document)[0].conditions).toEqual([{ id: "61", text: "dry" }, { id: "60", text: "heat" }]);
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('<group id="90">');
    expect(stepAttributes(exported.contents)).toEqual(stepAttributes(source));
    expect(summary(importFixture(visibleOnly(exported.contents)).document)).toEqual(summary(document));
    expect(exported.contents.match(/<fragment id="10"/g)).toHaveLength(1);
  });

  it("exports native reactions using native role and arrow fields, without a source scheme", () => {
    const { document } = importFixture(oneStep());
    const reaction = reactions(document)[0];
    delete reaction.compatibility;
    const parsed = parseDocument(document);
    const exported = exportDocumentToCdxml(parsed);
    const reopened = importFixture(visibleOnly(exported.contents)).document;
    expect(summary(reopened)[0]).toMatchObject({
      components: summary(document)[0].components,
      arrows: ["50"], pluses: ["70"], conditions: [{ id: "60", text: "25 °C, 2 h" }]
    });
    expect(exported.warnings).toEqual([]);
  });

  it("updates source lists when native roles change instead of restoring stale source semantics", () => {
    const { document } = importFixture(oneStep());
    const reaction = reactions(document)[0];
    reaction.components[0].role = "product";
    reaction.conditionsTextObjectIds = [];
    const attrs = stepAttributes(exportDocumentToCdxml(document).contents)[0];
    expect(attrs.ReactionStepReactants).toBe("20");
    expect(attrs.ReactionStepProducts).toBe("30 10");
    expect(attrs.ReactionStepObjectsBelowArrow).toBe("");
  });

  it("preserves opaque atom maps explicitly and retains their original atom ids", () => {
    const source = oneStep().replace('ReactionStepPlusses="70"', 'ReactionStepPlusses="70" ReactionStepAtomMap="101 301"');
    const { document, warnings } = importFixture(source);
    expect(reactions(document)[0].mappingState).toBe("unknown");
    expect(warnings).toContainEqual(expect.objectContaining({ code: "cdxml.reaction_step_attribute_preserved", message: expect.stringContaining("ReactionStepAtomMap") }));
    const exported = exportDocumentToCdxml(document);
    expect(stepAttributes(exported.contents)).toEqual(stepAttributes(source));
    expect(exported.contents).toContain('<n id="101"');
    expect(exported.contents).toContain('<n id="301"');
    expect(exported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.reaction_step_attribute_preserved" }));
    reactions(document)[0].mappingState = "absent";
    expect(stepAttributes(exportDocumentToCdxml(document).contents)[0]).not.toHaveProperty("ReactionStepAtomMap");
  });

  it("accepts empty native reactions and warns about unrepresentable mapping state", () => {
    const document = createEmptyDocument();
    document.pages[0].objects.push({ id: "r", type: "reaction", x: 0, y: 0, width: 0, height: 0,
      rotation: 0, style: {}, components: [], conditionsTextObjectIds: [], mappingState: "partial" });
    expect(exportDocumentToCdxml(document).warnings.map(warning => warning.code)).toContain("cdxml.reaction_mapping_payload_only");
  });

  it("preserves unrecognized scheme and step children in the native payload with a warning", () => {
    const source = oneStep().replace('/></scheme>', '><objecttag Name="synthetic-step" Value="step-data"/></step><objecttag Name="synthetic-scheme" Value="scheme-data"/></scheme>');
    const { document, warnings } = importFixture(source);
    expect(warnings.map(warning => warning.code)).toContain("cdxml.reaction_children_payload_only");
    expect(reactions(document)[0].compatibility?.unknown).toMatchObject({
      cdxmlStepExtraChildren: expect.stringContaining("step-data"),
      cdxmlSchemeExtraChildren: expect.stringContaining("scheme-data")
    });
    const exported = exportDocumentToCdxml(document);
    expect(exported.warnings.map(warning => warning.code)).toContain("cdxml.reaction_children_payload_only");
    expect(openChemDraftPayload(exported.contents).document).toEqual(document);
  });
});
