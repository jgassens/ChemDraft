import { applyPatch, createEmptyDocument, type BracketObject, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, layoutReactionScheme, documentDrawingDefaults, moleculeGeometryFromAtoms,
  representativeNativeMoleculeBondLength } from "@chemdraft/document-workflow-core";
import { PluginPlanLayoutResultSchema, pluginRequestPermissions, type PluginRequestArguments,
  type PluginRequestPatch } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createFigurePlanProviders } from "./index";

describe("desktop figure plan providers", () => {
  function fixture() {
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    const molecule = createSmilesMolecule(document, { x: 100, y: 100 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "CC");
    const product = { ...molecule, id: "product" };
    page.objects.push(molecule, product);
    const binding = { document, signal: new AbortController().signal, revision: () => "revision", check: vi.fn() };
    const reaction = { kind: "reaction" as const, reactants: [molecule.id], products: [product.id],
      arrowKind: "forward" as const, anchor: { x: 400, y: 200 } };
    const plan = (spec: PluginRequestArguments<"depiction", "planLayout">["spec"],
      build?: typeof import("../pluginChemistry").structureFromSmilesForPlugin) =>
      createFigurePlanProviders(build).planLayout({ requestId: "request", pageId: page.id, spec }, binding);
    return { document, page, molecule, product, reaction, plan };
  }

  const bracket: BracketObject = { id: "open-bracket", type: "bracket", bracketKind: "square", side: "open",
    x: 80, y: 80, width: 10, height: 40, rotation: 0, style: {}, containedObjectIds: [] };

  it.each(["row", "grid"] as const)("moves both halves of a bracket pair in a %s when only one is requested", async kind => {
    const { page, plan } = fixture();
    const open: BracketObject = { ...bracket, pairId: "pair" };
    const close: BracketObject = { ...open, id: "close-bracket", side: "close", x: 140 };
    page.objects = [open, close];
    const requested = kind === "row" ? open : close;
    const result = await plan({ kind, anchor: { x: 400, y: 200 }, objectIds: [requested.id] });
    if (!result.ok) throw new Error(result.error.message);
    const { transforms } = result.value;
    expect(transforms).toHaveLength(2);
    const { dx, dy } = transforms[0]!;
    expect([dx, dy]).not.toEqual([0, 0]);
    for (const glyph of [open, close]) {
      expect(transforms.find(move => move.objectId === glyph.id)).toEqual({
        objectId: glyph.id, dx, dy, changes: { x: glyph.x + dx, y: glyph.y + dy }
      });
    }
  });

  it.each(["row", "grid"] as const)("moves an unpaired bracket on its own in a %s", async kind => {
    const { page, plan } = fixture();
    page.objects.push(bracket);
    const result = await plan({ kind, anchor: { x: 400, y: 200 }, objectIds: [bracket.id] });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.transforms).toEqual([{
      objectId: bracket.id, dx: expect.any(Number), dy: expect.any(Number), changes: { x: expect.any(Number), y: expect.any(Number) }
    }]);
  });

  it.each(["row", "grid"] as const)("refuses a %s that would attach a floating legacy charge", async kind => {
    const { page, molecule, plan } = fixture();
    const anchor = { x: 400, y: 200 };
    page.objects.push({ ...anchor, id: "legacy-charge", width: 8, height: 8, rotation: 0, style: {},
      type: "electron-mark", markKind: "charge", charge: 1, anchor: { kind: "point", point: anchor } });
    await expect(plan({ kind, anchor, objectIds: [molecule.id] }))
      .rejects.toMatchObject({ code: "chemistry", message: expect.stringContaining("legacy-charge") });
  });

  it.each(["membership", "crossing"])("refuses to strand a bracket referenced by %s", async relation => {
    const { page, molecule, reaction, plan } = fixture();
    page.objects.push({ id: "polymer-bracket", type: "bracket", bracketKind: "polymer",
      x: 80, y: 80, width: 10, height: 40, rotation: 0, style: {},
      containedObjectIds: relation === "membership" ? [molecule.id] : [],
      crossingBondIds: relation === "crossing" ? [{ objectId: molecule.id, bondId: molecule.bonds[0]!.id }] : [] });
    await expect(plan(reaction)).rejects.toMatchObject({ code: "scope", message: expect.stringContaining("polymer-bracket") });
  });

  it("rejects 501 parsed heavy atoms before calling the structure builder", async () => {
    const { reaction, plan, molecule } = fixture();
    const build = vi.fn<typeof import("../pluginChemistry").structureFromSmilesForPlugin>(
      async () => ({ available: true, built: true, object: molecule }));
    await expect(plan({ ...reaction, products: [{ ref: "small", smiles: "CC" }, { ref: "oversize", smiles: "C".repeat(501) }] }, build))
      .rejects.toMatchObject({ code: "limit" });
    expect(build).not.toHaveBeenCalled();
  });

  it("checks the resulting page budget before returning a reaction", async () => {
    const { page, reaction, plan } = fixture();
    while (page.objects.length < 256) page.objects.push({ id: `text-${page.objects.length}`, type: "text",
      x: 0, y: 0, width: 20, height: 20, rotation: 0, style: {}, text: "label", spans: [] });
    await expect(plan(reaction)).rejects.toMatchObject({ code: "limit" });
  });

  it("matches native NaOH layout for a new SMILES component and preserves pinned ions", async () => {
    const { document, page, product, reaction, plan } = fixture();
    const smiles = "[Na+].[OH-]";
    const salt = createSmilesMolecule(document, { x: 100, y: 100 }, {
      atoms: [{ element: "Na", x: 0, y: 0, charge: 1 }, { element: "O", x: 4, y: 0, charge: -1 }], bonds: []
    }, smiles);
    const defaults = documentDrawingDefaults(document);
    const native = layoutReactionScheme({ ...reaction, reactants: [{ molecule: salt }], products: [{ molecule: product }],
      bondLength: defaults.bondLengthPx, gutter: defaults.bondLengthPx, textStyle: defaults.textStyle, pagePadding: 0 });
    const build = vi.fn<typeof import("../pluginChemistry").structureFromSmilesForPlugin>(
      async () => ({ available: true, built: true, object: salt }));
    const proposed = await plan({ ...reaction, reactants: [{ ref: "salt", smiles }] }, build);
    if (!proposed.ok) throw new Error(proposed.error.message);
    expect(proposed.value.objects.find(object => object.type === "reaction-arrow"))
      .toMatchObject({ start: native.arrow.start, end: native.arrow.end });
    expect(proposed.value.objects.find(object => object.type === "molecule"))
      .toMatchObject({ atoms: native.molecules[0]!.atoms });
    const plannedSalt = proposed.value.objects.find(object => object.type === "molecule")!;
    expect(plannedSalt).toMatchObject({ ...moleculeGeometryFromAtoms(plannedSalt.atoms), bonds: [] });
    expect(native.molecules[0]!.atoms).toMatchObject([{ element: "NaOH" }]);
    page.objects = [salt, product];
    const pinned = await plan({ ...reaction, reactants: [salt.id] });
    if (!pinned.ok) throw new Error(pinned.error.message);
    expect(pinned.value.warnings).toContainEqual(expect.stringMatching(/Na⁺.*OH⁻.*NaOH.*arrow/));
    expect(pinned.value.transforms.find(move => move.objectId === salt.id)?.changes)
      .toMatchObject({ atoms: [{ element: "Na", formalCharge: 1 }, { element: "O", formalCharge: -1 }] });
  });

  it("refuses a style scale that would capture a floating lone pair", async () => {
    const { document, page, molecule } = fixture();
    const right = molecule.atoms.reduce((a, b) => a.x > b.x ? a : b);
    const point = { x: right.x + 40, y: right.y };
    page.objects = [molecule, { id: "floating", type: "electron-mark", markKind: "lone-pair",
      anchor: { kind: "point", point }, x: point.x - 4, y: point.y - 4, width: 8, height: 8, rotation: 0, style: {} }];
    const plan = await createFigurePlanProviders().planStyle({
      requestId: "request", pageId: page.id, objectIds: [molecule.id], targetBondLength: 44
    }, { document, signal: new AbortController().signal, revision: () => "revision", check: vi.fn() });
    expect(plan).toMatchObject({ ok: true, value: { updates: [], warnings: [expect.stringContaining("floating")] } });
  });

  it("builds new SMILES with pinned defaults and exposes shared local references for preview and commit", async () => {
    const document = createEmptyDocument();
    const page = document.pages[0]!;
    document.styles.drawing = { bondLengthPx: 27 };
    const depict = (smiles: string) => createSmilesMolecule(document, { x: 200, y: 200 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "C", x: 1, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, smiles);
    const left = depict("CC");
    page.objects = [left];
    const before = structuredClone(document);
    const signal = new AbortController().signal;
    const build = vi.fn<typeof import("../pluginChemistry").structureFromSmilesForPlugin>(
      async (request, read, receivedSignal) => {
        expect(read()).toMatchObject({ pages: [{ id: page.id }], styles: { drawing: { bondLengthPx: 27 } } });
        expect(receivedSignal).toBe(signal);
        return { available: true, built: true, object: depict(request.smiles) };
      }
    );
    const params = { requestId: "request", pageId: page.id, spec: {
      kind: "reactionRows", anchor: { x: 50, y: 140 }, bondLength: 24, maxWidth: 650,
      steps: [
        { reactants: [left.id], products: [{ ref: "middle", smiles: "CC" }], arrowKind: "forward", above: ["EtOH"] },
        { reactants: [{ ref: "middle" }], products: [{ ref: "end", smiles: "CC" }], arrowKind: "forward", below: ["25 °C"],
          compoundNumbers: [{ component: { ref: "middle" }, text: "2" }] }
      ]
    } } satisfies PluginRequestArguments<"depiction", "planLayout">;
    expect(pluginRequestPermissions("depiction", "planLayout", params)).toEqual(["document.read", "chemistry.compute"]);
    const result = await createFigurePlanProviders(build).planLayout(params, {
      document, signal, revision: () => "revision", check: vi.fn()
    });
    const parsed = PluginPlanLayoutResultSchema.parse(result);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(build).toHaveBeenCalledTimes(2);
    const { objects, transforms, insertionSources } = parsed.value;
    expect(insertionSources).toHaveLength(2);
    const middle = insertionSources!.find(source => source.ref === "middle")!.objectId;
    expect(objects.filter(object => object.type === "molecule" && object.id === middle)).toHaveLength(1);
    expect(objects.filter(object => object.type === "reaction").map(step => step.components)).toEqual([
      [{ objectId: left.id, role: "reactant" }, { objectId: middle, role: "product" }],
      [{ objectId: middle, role: "reactant" }, { objectId: insertionSources![1]!.objectId, role: "product" }]
    ]);
    expect(transforms).toEqual([{ objectId: left.id, dx: expect.any(Number), dy: expect.any(Number),
      changes: expect.objectContaining({ atoms: expect.any(Array) }) }]);
    const patch: PluginRequestPatch = { op: "batch", patches: [
      ...objects.map(object => ({ op: "addObject" as const, pageId: page.id, object })),
      ...transforms.map(item => ({ op: "updateObject" as const, objectId: item.objectId, changes: item.changes }))
    ] };
    const preview = applyPatch(document, patch);
    const molecules = preview.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
    expect(molecules).toHaveLength(3);
    molecules.forEach(molecule => expect(representativeNativeMoleculeBondLength(molecule)).toBeCloseTo(24));
    expect(document).toEqual(before);
  });
});
