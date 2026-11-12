import { expect, it } from "vitest";
import { createEmptyDocument, type ArrowObject, type MoleculeObject, type ReactionObject, type TextObject } from "@chemdraft/chem-core";
import { reactionConditionsPlacement } from "./reactionConditionsLayout";
import { arrowAttachmentPoint } from "./arrowAttachmentFrames";

it("places horizontal conditions above and below a shaft without importing the public entry point", () => {
  const page = createEmptyDocument().pages[0];
  const base = { rotation: 0, style: {} };
  const arrow: ArrowObject = { ...base, id: "arrow", type: "reaction-arrow", x: 200, y: 200, width: 200, height: 0,
    arrowKind: "forward", labels: [], start: { kind: "point", point: { x: 200, y: 200 } }, end: { kind: "point", point: { x: 400, y: 200 } } };
  const label: TextObject = { ...base, id: "label", type: "text", x: 0, y: 0, width: 80, height: 24, text: "THF", spans: [] };
  page.objects = [arrow];
  for (const side of ["above", "below"] as const) {
    const placement = reactionConditionsPlacement(page, arrow, label, side)!;
    expect(placement).toBeDefined();
    const center = arrowAttachmentPoint(placement.frame, placement.offset);
    expect(center.x).toBe(300);
    expect(side === "above" ? center.y < 188 : center.y > 212).toBe(true);
  }
});

function reactionFixture() {
  const page = createEmptyDocument().pages[0];
  const base = { rotation: 0, style: {} };
  const arrow: ArrowObject = { ...base, id: "arrow", type: "reaction-arrow", x: 200, y: 200, width: 200, height: 0,
    arrowKind: "forward", labels: [], start: { kind: "point", point: { x: 200, y: 200 } }, end: { kind: "point", point: { x: 400, y: 200 } } };
  const label: TextObject = { ...base, id: "label", type: "text", x: 0, y: 0, width: 80, height: 24, text: "THF", spans: [] };
  const reaction: ReactionObject = { ...base, id: "reaction", type: "reaction", x: 100, y: 100, width: 400, height: 200,
    components: [], arrowObjectIds: [arrow.id], conditionsTextObjectIds: [label.id], mappingState: "unknown" };
  page.objects = [arrow, reaction];
  return { page, arrow, label, reaction };
}

it("keeps conditions at the clear midpoint inside their own reaction container", () => {
  const { page, arrow, label } = reactionFixture();
  expect(reactionConditionsPlacement(page, arrow, label, "above")?.offset).toEqual({ x: 0, y: 24 });
});

it.each(["arrow", "label"] as const)("recognizes ownership through the %s reference alone", member => {
  const { page, arrow, label, reaction } = reactionFixture();
  reaction.arrowObjectIds = member === "arrow" ? [arrow.id] : undefined;
  reaction.conditionsTextObjectIds = member === "label" ? [label.id] : [];
  expect(reactionConditionsPlacement(page, arrow, label, "above")?.offset).toEqual({ x: 0, y: 24 });
});

it("keeps another reaction's container as an obstacle even with an owning container present", () => {
  const { page, arrow, label, reaction } = reactionFixture();
  page.objects.push({ ...reaction, id: "other-reaction", arrowObjectIds: ["other-arrow"], conditionsTextObjectIds: ["other-label"] });
  expect(reactionConditionsPlacement(page, arrow, label, "above")?.offset).toEqual({ x: 0, y: 132 });
});

it("preserves midpoint placement without a reaction container", () => {
  const { page, arrow, label } = reactionFixture();
  page.objects = [arrow];
  expect(reactionConditionsPlacement(page, arrow, label, "above")?.offset).toEqual({ x: 0, y: 24 });
});

it("still avoids text ink belonging to the owning reaction", () => {
  const { page, arrow, label, reaction } = reactionFixture();
  const otherLabel = { ...label, id: "other-label", x: 260, y: 164 };
  reaction.conditionsTextObjectIds.push(otherLabel.id);
  page.objects.push(otherLabel);
  const placement = reactionConditionsPlacement(page, arrow, label, "above");
  expect(placement).toBeDefined();
  expect(placement?.offset).not.toEqual({ x: 0, y: 24 });
  page.objects = [arrow, otherLabel];
  expect(reactionConditionsPlacement(page, arrow, label, "above")).toEqual(placement);
});

it("still avoids arrow ink belonging to the owning reaction", () => {
  const { page, arrow, label, reaction } = reactionFixture();
  const otherArrow: ArrowObject = { ...arrow, id: "other-arrow", y: 176,
    start: { kind: "point", point: { x: 200, y: 176 } }, end: { kind: "point", point: { x: 400, y: 176 } } };
  reaction.arrowObjectIds!.push(otherArrow.id);
  page.objects.push(otherArrow);
  const placement = reactionConditionsPlacement(page, arrow, label, "above");
  expect(placement).toBeDefined();
  expect(placement?.offset).not.toEqual({ x: 0, y: 24 });
  page.objects = [arrow, otherArrow];
  expect(reactionConditionsPlacement(page, arrow, label, "above")).toEqual(placement);
});

it("still avoids molecule ink belonging to the owning reaction", () => {
  const { page, arrow, label, reaction } = reactionFixture();
  const molecule: MoleculeObject = { id: "molecule", type: "molecule", x: 200, y: 176, width: 200, height: 0,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "CC", superatoms: [], rGroups: [],
    atoms: [{ id: "c1", element: "C", formalCharge: 0, x: 200, y: 176 },
      { id: "c2", element: "C", formalCharge: 0, x: 400, y: 176 }],
    bonds: [{ id: "bond", fromAtomId: "c1", toAtomId: "c2", order: "single" }] };
  reaction.components.push({ objectId: molecule.id, role: "reactant" });
  page.objects.push(molecule);
  const placement = reactionConditionsPlacement(page, arrow, label, "above");
  expect(placement).toBeDefined();
  expect(placement?.offset).not.toEqual({ x: 0, y: 24 });
  page.objects = [arrow, molecule];
  expect(reactionConditionsPlacement(page, arrow, label, "above")).toEqual(placement);
});
