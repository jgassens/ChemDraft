import {
  Acs1996StylePreset, RscJournalStylePreset, applyPatches, createEmptyDocument,
  type ArrowObject, type MoleculeObject, type TextObject
} from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";
import {
  documentDrawingDefaults, layoutReactionScheme, listFigureStylePresets, normalizeNativeMoleculeGeometry,
  planFigureArrangement, planFigureReaction, planFigureStyle, representativeNativeMoleculeBondLength
} from "../src";

function chain(id: string, length = 22, x = 130): MoleculeObject {
  return normalizeNativeMoleculeGeometry({
    id, type: "molecule", x, y: 100, width: length, height: 0, rotation: 20,
    style: { bondLengthPx: length, ringStyles: { ring: { fillColor: "#11aacc" } },
      atomLabelBackgroundColors: { a: "transparent" }, bondColors: { b: "#332211" } },
    atoms: [
      { id: "a", element: "C", x, y: 100, formalCharge: 0 },
      { id: "z", element: "C", x: x + length, y: 100, formalCharge: 0 }
    ],
    bonds: [{ id: "b", fromAtomId: "a", toAtomId: "z", order: "single", display: { bondStyle: "wedge" } }],
    structureFormat: "smiles", structure: "CC", superatoms: [], rGroups: []
  });
}

describe("figure style proposals", () => {
  it.each([Acs1996StylePreset, RscJournalStylePreset])("plans $name while keeping independently authored art", preset => {
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    const molecule = chain("molecule");
    page.objects = [molecule];
    document.styles = { drawing: { bondLengthPx: 29 }, text: { fontFamily: "Courier" } };
    const before = structuredClone(document);
    const catalog = listFigureStylePresets(document);
    expect(catalog.defaults).toMatchObject({ drawing: { bondLengthPx: 29 }, text: { fontFamily: "Courier" } });
    expect(catalog.presets).toContainEqual(expect.objectContaining({
      id: preset.id, bondLengthPx: preset.drawing.bondLengthPx, bondStrokeWidthPx: preset.drawing.bondStrokeWidthPx,
      atomLabelFontFamily: preset.drawing.atomLabelFontFamily
    }));
    const plan = planFigureStyle(page, { objectIds: [molecule.id], presetId: preset.id });
    expect(plan.updates).toEqual([expect.objectContaining({ op: "updateObject", objectId: molecule.id })]);
    const [result] = applyPatches(document, plan.updates).pages[0]!.objects;
    expect(result!.style).toMatchObject({
      ringStyles: molecule.style.ringStyles, bondColors: molecule.style.bondColors,
      atomLabelBackgroundColors: molecule.style.atomLabelBackgroundColors,
      stylePresetId: preset.id, bondLengthPx: preset.drawing.bondLengthPx,
      bondStrokeWidthPx: preset.drawing.bondStrokeWidthPx
    });
    expect(document).toEqual(before);
  });

  it("scales three molecules around their centres and keeps stereo and document-level state", () => {
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    const molecules = [chain("short", 14), chain("medium", 22, 230), chain("long", 40, 340)];
    page.objects = molecules;
    document.selection.objectIds = ["short"];
    document.styles.drawing = { bondLengthPx: 21 };
    const before = structuredClone(document);
    const plan = planFigureStyle(page, { objectIds: molecules.map(object => object.id), targetBondLength: 30 });
    expect(plan.warnings).toEqual([]);
    expect(plan.updates.map(update => update.op)).toEqual(["updateObject", "updateObject", "updateObject"]);
    const result = applyPatches(document, plan.updates);
    expect(result.styles).toEqual(before.styles);
    expect(result.selection).toEqual(before.selection);
    for (const [index, updated] of (result.pages[0]!.objects as MoleculeObject[]).entries()) {
      const original = molecules[index]!;
      expect(representativeNativeMoleculeBondLength(updated)).toBeCloseTo(30);
      expect(updated.x + updated.width / 2).toBeCloseTo(original.x + original.width / 2);
      expect(updated.y + updated.height / 2).toBeCloseTo(original.y + original.height / 2);
      expect(updated.bonds).toEqual(original.bonds);
      expect(updated.rotation).toBe(original.rotation);
    }
    expect(document).toEqual(before);
  });

  it.each([0, 90, 45])("scales the lone-pair offset from the rendered atom at %i degrees", rotation => {
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    const molecule = { ...chain("m", 12), rotation };
    const atom = molecule.atoms[0]!;
    const rendered = transformPointForObject(molecule, atom);
    page.objects = [molecule, { id: "pair", type: "electron-mark", markKind: "lone-pair",
      atomAssociation: "explicit", anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id },
      x: rendered.x - 3, y: rendered.y - 7, width: 6, height: 6, style: {}, rotation: 0 }];
    const plan = planFigureStyle(page, { objectIds: ["m", "pair"], targetBondLength: 24 });
    expect(plan.warnings).toEqual([]);
    const [scaled, mark] = applyPatches(document, plan.updates).pages[0]!.objects;
    if (scaled?.type !== "molecule" || mark?.type !== "electron-mark") throw new Error("Missing scaled objects");
    const after = transformPointForObject(scaled, scaled.atoms[0]!);
    expect(mark.x + mark.width / 2 - after.x).toBeCloseTo(0);
    expect(mark.y + mark.height / 2 - after.y).toBeCloseTo(-8);
  });

  it("reports an incomplete group and carries only explicitly targeted electron marks", () => {
    const page = createEmptyDocument().pages[0]!;
    const molecule = chain("m");
    const { x, y } = molecule.atoms[0]!;
    const frame = { x, y, width: 10, height: 10, rotation: 0, style: {} };
    page.objects = [molecule, { ...frame, id: "group", type: "group", childObjectIds: ["m"] },
      { ...frame, id: "mark", type: "electron-mark", markKind: "lone-pair", atomAssociation: "explicit",
        anchor: { kind: "atom", objectId: "m", atomId: "a" } }];
    const plan = (objectIds: string[]) => planFigureStyle(page, { objectIds, targetBondLength: 40 });
    expect(plan(["group"])).toMatchObject({ updates: [], warnings: [expect.stringContaining('Group "group"')] });
    expect(plan(["group", "m"])).toMatchObject({ updates: [], warnings: [expect.stringContaining("mark")] });
    expect(plan(["group", "m", "mark"])).toMatchObject({ affectedObjectIds: ["m", "mark"], movedMarkIds: ["mark"], warnings: [] });
  });
});

describe("figure layout proposals", () => {
  const document = createEmptyDocument();
  const defaults = documentDrawingDefaults(document);
  const anchor = { x: 100, y: 130 };
  const reactants = [chain("start")];
  const products = [chain("end", 22, 350)];
  const makeOptions = () => {
    let id = 0;
    return { anchor, textStyle: defaults.textStyle, bondLength: 22,
      nextId: (kind: string) => `${kind}-${++id}`, compoundNumbers: new Map<string, string>() };
  };

  it("uses the shared reaction geometry for native above and below condition blocks", () => {
    const step = { reactants, products, arrowKind: "equilibrium" as const, above: ["Pd(OAc)2", "EtOH"],
      below: ["25 °C, 2 h"] };
    const { objects, placements } = planFigureReaction([step], makeOptions());
    const original = layoutReactionScheme({ ...step, reactants: reactants.map(molecule => ({ molecule })),
      products: products.map(molecule => ({ molecule })), anchor, textStyle: defaults.textStyle,
      bondLength: 22, gutter: 22, pagePadding: 0 });
    const arrow = objects.find(object => object.type === "reaction-arrow")!;
    expect(arrow).toMatchObject({ start: original.arrow.start, end: original.arrow.end, style: original.arrow.style });
    const conditions = objects.filter((object): object is TextObject => object.type === "text" && !!object.arrowAttachment);
    for (const [index, text] of [original.above!, original.below!].entries()) {
      expect(conditions[index]).toMatchObject({ x: text.x, y: text.y, text: text.text, spans: text.spans,
        arrowAttachment: { parentObjectId: arrow.id, side: index === 0 ? "above" : "below" } });
    }
    expect(placements.get("end")!.atoms).toEqual(original.molecules[1]!.atoms);
  });

  it("draws shared intermediates once across three steps and allows explicit and width-triggered breaks", () => {
    const middle1 = chain("middle1", 22, 250), middle2 = chain("middle2", 22, 300);
    const steps = [
      { reactants, products: [middle1], arrowKind: "forward" as const },
      { reactants: [middle1], products: [middle2], arrowKind: "forward" as const },
      { reactants: [middle2], products, arrowKind: "forward" as const }
    ];
    const options = makeOptions();
    options.compoundNumbers.set(middle1.id, "2");
    const joined = planFigureReaction(steps, { ...options, rows: { maxWidth: 800, gap: 16 } });
    const arrows = (plan: typeof joined) => plan.objects.filter((object): object is ArrowObject => object.type === "reaction-arrow");
    expect(joined.placements.size).toBe(4);
    expect(arrows(joined).map(arrow => arrow.start.point!.y)).toEqual([130, 130, 130]);
    expect(joined.objects.filter(object => object.type === "text" && object.text === "2")).toHaveLength(1);
    expect(joined.objects.filter(object => object.type === "reaction").map(object => object.components.map(c => c.objectId)))
      .toEqual([["start", "middle1"], ["middle1", "middle2"], ["middle2", "end"]]);
    for (const rows of [{ maxWidth: 220, gap: 16 }, { maxWidth: 800, gap: 16, breakBefore: [1] }]) {
      const wrapped = planFigureReaction(steps, { ...options, rows });
      expect(wrapped.placements.size).toBe(4);
      expect(arrows(wrapped)[1]!.start.point!.y).toBeGreaterThan(130);
      expect(wrapped.warnings).toContainEqual(expect.stringContaining("middle1"));
    }
  });

  it.each(["row", "grid"] as const)("wraps a %s at its maximum width in input order", layout => {
    const page = document.pages[0]!;
    const items = [chain("right", 22, 400), chain("left", 22, 100), chain("middle", 22, 250)]
      .map(molecule => ({ id: molecule.id, objects: [molecule] }));
    const result = planFigureArrangement(page, items, layout, { anchor, gap: 10, wrapWidth: 70 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.placements.map(item => item.id)).toEqual(["right", "left", "middle"]);
    expect(result.bounds.width).toBeLessThanOrEqual(70);
    expect(result.placements[2]!.bounds.y).toBeGreaterThan(result.placements[0]!.bounds.y);
  });
});
