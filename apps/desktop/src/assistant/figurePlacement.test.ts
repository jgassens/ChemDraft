import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyPatch, createCustomPageLayout, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeRings, figurePlacementFrame, planPageSvgRender, representativeMoleculeBondLength,
  type PageSvgFragment, type PageSvgElementFragment } from "@chemdraft/layout-engine";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { ensureRdkit } from "../../../../packages/rdkit-adapter/src/conformer";
import { callAssistantTool } from "./assistantTools";
import { testContext } from "./tools/testContext";
import { cbpqt, crown, ttf } from "./figureFixtures";
import { buildMoveObjects, translateObject } from "./writeBuilder";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { toolSchemas } from "./tools/schemas";

beforeAll(() => installNodeRdkitModuleLoader());
function fixture(molecules: MoleculeObject[]) {
  const s = testContext();
  const doc = s.context.getDocument()!;
  doc.pages[0]!.objects = molecules.map((m, i) => translateObject(m, 300 + i * 300, 300));
  s.context.getSelectionAtSend = () => molecules.map(m => m.id);
  return { ...s, molecules: () => s.context.getDocument()!.pages[0]!.objects as MoleculeObject[] };
}
async function canonical(molecule: MoleculeObject) {
  const rdkit = await ensureRdkit();
  const warnings: string[] = [];
  const mol = rdkit.get_mol(stereoPerceptionMolfile(molecule, warnings)) as { get_smiles(): string; delete(): void } | null;
  expect(warnings).toEqual([]);
  expect(mol, `valid molecule ${molecule.id}`).not.toBeNull();
  try { return mol!.get_smiles(); } finally { mol?.delete(); }
}
function largestRing(molecule: MoleculeObject) {
  return [...nativeMoleculeRings(molecule)].sort((a, b) => b.area - a.area)[0]!;
}
function assertInterlock(s: ReturnType<typeof fixture>, a: string, b: string) {
  const page = s.context.getDocument()!.pages[0]!;
  const plan = planPageSvgRender(page);
  const crossings = plan.crossings.filter(c => c.bonds.some(r => r.objectId === a) && c.bonds.some(r => r.objectId === b));
  expect(crossings.length).toBeGreaterThanOrEqual(2);
  expect(new Set(crossings.map(c => c.front.objectId))).toEqual(new Set([a, b]));
  expect(new Set(crossings.map(c => c.back.objectId))).toEqual(new Set([a, b]));
  const overridden = crossings.filter(c => c.hasOverride);
  expect(new Set(overridden.map(c => c.front.objectId))).toEqual(new Set([a, b]));
  // Inspect actual emitted ink: each underpass must have a knockout gap.
  const gapped = new Set<string>();
  for (const c of overridden) {
    expect(c.clearancePx).toBeGreaterThan(0);
    const molecule = page.objects.find(o => o.id === c.back.objectId) as MoleculeObject;
    const alone = planPageSvgRender({ ...page, objects: [molecule], crossings: [] });
    const elements = (fragments: PageSvgFragment[]): PageSvgElementFragment[] => fragments.flatMap(f =>
      f.kind === "element" ? [f, ...elements(f.children)] : []);
    const ink = (fragments: typeof plan.fragments) => elements(fragments.filter(f => f.attrs["data-object-id"] === c.back.objectId))
      .filter(f => f.attrs["data-bond-id"] === c.back.bondId && String(f.attrs.class).includes("native-bond-line"));
    if (JSON.stringify(ink(plan.fragments)) !== JSON.stringify(ink(alone.fragments))) gapped.add(c.back.objectId);
  }
  expect(gapped).toEqual(new Set([a, b]));
  return overridden;
}
async function assertChemistry(s: ReturnType<typeof fixture>, before: MoleculeObject[], smiles: string[]) {
  expect(s.molecules()).toHaveLength(before.length);
  for (let i = 0; i < before.length; i++) {
    const after = s.molecules().find(m => m.id === before[i]!.id)!;
    expect(after.bonds).toEqual(before[i]!.bonds);
    expect(after.atoms.map(({ x: _x, y: _y, ...atom }) => atom)).toEqual(before[i]!.atoms.map(({ x: _x, y: _y, ...atom }) => atom));
    expect(await canonical(after)).toBe(smiles[i]);
  }
}
async function move(s: ReturnType<typeof fixture>, id: string, target: string, offset = { dx: 0, dy: 0 }, rotateDeg = 0) {
  const ring = largestRing(s.molecules().find(m => m.id === target)!);
  const result = await callAssistantTool(s.context, "move_objects", { objectIds: [id],
    to: { relativeTo: target, anchor: { ringKey: ring.ringKey }, offset, rotateDeg }, crossings: "auto" });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
}

describe("supramolecular figure recipes through the real page renderer", () => {
  it("threads TTF through CBPQT4+ without changing either molecule", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    const before = structuredClone(s.molecules());
    const smiles = await Promise.all(before.map(canonical));
    expect(before[0]!.atoms.filter(a => a.element === "N")).toHaveLength(4);
    expect(before[0]!.atoms.reduce((sum, a) => sum + (a.formalCharge ?? 0), 0)).toBe(4);
    expect(before[1]!.atoms.filter(a => a.element === "S")).toHaveLength(4);
    await move(s, "ttf", "box");
    const center = figurePlacementFrame(s.molecules().find(m => m.id === "ttf")!).center;
    const ringCenter = largestRing(s.molecules().find(m => m.id === "box")!).center;
    expect(center.x).toBeCloseTo(ringCenter.x, 6);
    expect(center.y).toBeCloseTo(ringCenter.y, 6);
    const crossings = assertInterlock(s, "ttf", "box");
    const over = crossings.filter(c => c.front.objectId === "ttf");
    const under = crossings.filter(c => c.back.objectId === "ttf");
    expect(Math.min(...over.map(c => c.point.x))).toBeGreaterThan(Math.max(...under.map(c => c.point.x)));
    await assertChemistry(s, before, smiles);
  });
  it("interlocks two macrocycles as a [2]catenane, each over and under its partner", async () => {
    const s = fixture([cbpqt("box"), crown("crown")]);
    const before = structuredClone(s.molecules());
    const smiles = await Promise.all(before.map(canonical));
    await move(s, "crown", "box", { dx: 4, dy: 0.2 });
    assertInterlock(s, "box", "crown");
    await assertChemistry(s, before, smiles);
  });
  it("arranges the Olympiadane five-component recipe with an over/under pair at each interlock", async () => {
    const s = fixture([cbpqt("box1"), crown("crown1"), cbpqt("box2"), crown("crown2"), cbpqt("box3")]);
    const before = structuredClone(s.molecules());
    const smiles = await Promise.all(before.map(canonical));
    for (let i = 1; i < before.length; i++) {
      const target = s.molecules().find(m => m.id === before[i - 1]!.id)!;
      await move(s, before[i]!.id, target.id, { dx: 90 / representativeMoleculeBondLength(target)!, dy: 0.15 });
      assertInterlock(s, before[i]!.id, target.id);
    }
    for (let i = 1; i < before.length; i++) assertInterlock(s, before[i]!.id, before[i - 1]!.id);
    const plan = planPageSvgRender(s.context.getDocument()!.pages[0]!);
    const neighbors = new Set(before.slice(1).map((m, i) => [m.id, before[i]!.id].sort().join("|")));
    for (const c of plan.crossings.filter(c => c.bonds[0].objectId !== c.bonds[1].objectId)) {
      expect(neighbors.has(c.bonds.map(b => b.objectId).sort().join("|"))).toBe(true);
    }
    await assertChemistry(s, before, smiles);
  });
  it("refuses the entire move when the ring is outside Send scope", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    s.context.getSelectionAtSend = () => ["ttf"];
    const before = structuredClone(s.context.getDocument());
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center" }, crossings: "auto" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("box was not selected") }] });
    expect(s.context.getDocument()).toEqual(before);
    expect(s.context.write).not.toHaveBeenCalled();
  });
  it("refuses auto placement with no intersecting bonds instead of claiming a threaded figure", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    const before = structuredClone(s.context.getDocument());
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center", offset: { dx: 10, dy: 0 } }, crossings: "auto" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("at least two intersections") }] });
    expect(s.context.getDocument()).toEqual(before);
  });
});

describe("figure placement options and atomic refusals", () => {
  it.each([{ dx: -100, dy: 0 }, { dx: 0, dy: -100 }])("refuses an anchor outside the fixed page origin (%j) without moving its reference", async offset => {
    const s = fixture([cbpqt("box"), crown("crown")]);
    const before = structuredClone(s.context.getDocument());
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["crown"],
      to: { relativeTo: "box", anchor: "center", offset } });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("left or top page margin") }] });
    expect(s.context.getDocument()).toEqual(before);
    expect(s.context.write).not.toHaveBeenCalled();
    expect(s.context.confirmPageGrowth).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope crossing before asking to enlarge the page", async () => {
    const s = fixture([cbpqt("box"), crown("crown")]);
    const document = s.context.getDocument()!;
    // The crossing extends to the right of this page; its read-only anchor is not writable.
    s.replace(applyPatch(document, { op: "updatePageLayout", pageId: document.pages[0]!.id,
      layout: createCustomPageLayout(400, document.pages[0]!.height, "css-px", document.pages[0]!.margin) }));
    s.context.getSelectionAtSend = () => ["crown"];
    const before = structuredClone(s.context.getDocument());
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["crown"],
      to: { relativeTo: "box", anchor: "center", offset: { dx: 4, dy: 0.2 } }, crossings: "auto" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("box was not selected") }] });
    expect(s.context.getDocument()).toEqual(before);
    expect(s.context.confirmPageGrowth).not.toHaveBeenCalled();
    expect(s.context.write).not.toHaveBeenCalled();
  });

  it.each([37, -90, 180])("threads against a ring rotated %s degrees using page-space crossing geometry", async rotation => {
    const s = fixture([{ ...cbpqt("box"), rotation }, ttf("ttf")]);
    const before = structuredClone(s.molecules());
    const smiles = await Promise.all(before.map(canonical));
    await move(s, "ttf", "box", { dx: 0, dy: 0 }, rotation);
    assertInterlock(s, "ttf", "box");
    const target = s.molecules()[0]!;
    const center = figurePlacementFrame(s.molecules()[1]!).center;
    const anchor = figurePlacementFrame(target, largestRing(target)).center;
    expect(center.x).toBeCloseTo(anchor.x);
    expect(center.y).toBeCloseTo(anchor.y);
    await assertChemistry(s, before, smiles);
  });
  it("accepts macrocycle keys longer than an object id and exposes usable ring and bond references", async () => {
    const box = cbpqt("box");
    box.bonds = box.bonds.map(bond => ({ ...bond, id: `bond_imported_macrocycle_${bond.id}` }));
    const s = fixture([box, ttf("ttf")]);
    expect(largestRing(box).ringKey.length).toBeGreaterThan(256);
    await move(s, "ttf", "box");
    assertInterlock(s, "ttf", "box");
    const result = await callAssistantTool(s.context, "get_document", { includeSmiles: false });
    const summary = result.structuredContent!.objects as { id: string; rings: { ringKey: string; bondIds: string[] }[]; bonds: { bondId: string }[] }[];
    const entry = summary.find(o => o.id === "box")!;
    expect(entry.rings.some(r => r.ringKey === largestRing(box).ringKey)).toBe(true);
    expect(entry.bonds.map(b => b.bondId)).toEqual(box.bonds.map(b => b.id));
  });
  it("aligns the axis, then rotates, with page-axis offsets in the target bond length", async () => {
    const s = fixture([{ ...cbpqt("box"), rotation: 31 }, { ...ttf("ttf"), rotation: 73 }]);
    const target = s.molecules()[0]!;
    const before = structuredClone(s.molecules());
    const smiles = await Promise.all(before.map(canonical));
    const frame = figurePlacementFrame(target, largestRing(target).ringKey);
    const length = representativeMoleculeBondLength(target)!;
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "axis", rotateDeg: 90, offset: { dx: 2, dy: -1 } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const placed = figurePlacementFrame(s.molecules()[1]!);
    expect(placed.center.x).toBeCloseTo(frame.center.x + length * 2);
    expect(placed.center.y).toBeCloseTo(frame.center.y - length);
    expect(placed.axis.x * frame.axis.x + placed.axis.y * frame.axis.y).toBeCloseTo(0);
    await assertChemistry(s, before, smiles);
  });
  it("allows intentional overlap against a read-only center anchor when no crossing is written", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    s.context.getSelectionAtSend = () => ["ttf"];
    const before = structuredClone(s.molecules()[0]);
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"], to: { relativeTo: "box", anchor: "center" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.warnings).toEqual([]);
    expect(s.molecules()[0]).toEqual(before);
    expect(figurePlacementFrame(s.molecules()[1]!).center).toEqual(figurePlacementFrame(s.molecules()[0]!).center);
  });
  it.each([
    ["front", ["box", "crown", "ttf"]], ["behind", ["ttf", "box", "crown"]],
    [{ above: "crown" }, ["box", "crown", "ttf"]], [{ below: "box" }, ["ttf", "box", "crown"]]
  ])("uses the native setObjectOrder patch for %j", async (zOrder, expected) => {
    const s = fixture([cbpqt("box"), ttf("ttf"), crown("crown")]);
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center" }, zOrder });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(s.molecules().map(m => m.id)).toEqual(expected);
    const patch = vi.mocked(s.context.write).mock.calls[0]![0];
    expect(patch.op === "batch" && patch.patches.some(p => p.op === "setObjectOrder")).toBe(true);
  });
  it("threads with z-order beside an unchanged out-of-scope object (the formerly refused patch)", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf"), crown("bystander")]);
    s.context.getSelectionAtSend = () => ["box", "ttf"];
    const before = structuredClone(s.context.getDocument());
    const built = buildMoveObjects(s.context, { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center" }, crossings: "auto", zOrder: "front" });
    expect(built.patch).toMatchSnapshot("formerly refused threading patch");
    // Capture the exact refused write before relaxing any gate: the only operation naming
    // bystander is [box, bystander, ttf] page order, and normalization preserves its content.
    expect(built.patch).toMatchObject({ op: "batch", patches: [
      { op: "updateObject", objectId: "ttf" },
      { op: "setObjectOrder", objectIds: ["box", "bystander", "ttf"] },
      ...Array.from({ length: built.patch.op === "batch" ? built.patch.patches.length - 2 : 0 }, () =>
        ({ op: "setCrossingOverride" }))
    ] });
    const normalized = normalizeCommittedDocument(applyPatch(s.context.getDocument()!, built.patch));
    expect(JSON.stringify(normalized.pages[0]!.objects.find(o => o.id === "bystander")))
      .toBe(JSON.stringify(before!.pages[0]!.objects.find(o => o.id === "bystander")));
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center" }, crossings: "auto", zOrder: "front" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(s.context.getDocument()!.pages[0]!.objects.map(o => o.id)).toEqual(["box", "bystander", "ttf"]);
    expect(JSON.stringify(s.context.getDocument()!.pages[0]!.objects.find(o => o.id === "bystander")))
      .toBe(JSON.stringify(before!.pages[0]!.objects.find(o => o.id === "bystander")));
  });
  it("applies explicit over/under references and refuses nonexistent crossings without moving anything", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    await move(s, "ttf", "box");
    const crossing = planPageSvgRender(s.context.getDocument()!.pages[0]!).crossings.find(c => c.hasOverride)!;
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: { ringKey: largestRing(s.molecules()[0]!).ringKey } },
      crossings: [{ over: crossing.back, under: crossing.front }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(planPageSvgRender(s.context.getDocument()!.pages[0]!).crossings.find(c => c.key === crossing.key)!.front).toEqual(crossing.back);
    const before = structuredClone(s.context.getDocument());
    const failed = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: "center", offset: { dx: 20, dy: 0 } },
      crossings: [{ over: crossing.back, under: crossing.front }] });
    expect(failed.isError).toBe(true);
    expect(s.context.getDocument()).toEqual(before);
  });
  it("refuses explicit crossings when either referenced object is out of scope", async () => {
    const s = fixture([cbpqt("box"), ttf("ttf")]);
    await move(s, "ttf", "box");
    const crossing = planPageSvgRender(s.context.getDocument()!.pages[0]!).crossings.find(c => c.hasOverride)!;
    s.context.getSelectionAtSend = () => ["ttf"];
    const before = structuredClone(s.context.getDocument());
    const result = await callAssistantTool(s.context, "move_objects", { objectIds: ["ttf"],
      to: { relativeTo: "box", anchor: { ringKey: largestRing(s.molecules()[0]!).ringKey } },
      crossings: [{ over: crossing.back, under: crossing.front }] });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("box was not selected") }] });
    expect(s.context.getDocument()).toEqual(before);
  });
  it("anchors text and a whole reaction scheme using the shared insert options", async () => {
    const s = fixture([cbpqt("box")]);
    const destination = figurePlacementFrame(s.molecules()[0]!).center;
    const text = await callAssistantTool(s.context, "insert_text", { text: "Threaded figure",
      to: { relativeTo: "box", anchor: "center", offset: { dx: 0, dy: 2 }, rotateDeg: 20 }, zOrder: "behind" });
    expect(text.isError, JSON.stringify(text)).not.toBe(true);
    const caption = s.context.getDocument()!.pages[0]!.objects.find(o => o.type === "text")!;
    expect(caption.rotation).toBe(20);
    expect(figurePlacementFrame(caption).center.x).toBeCloseTo(destination.x);
    expect(figurePlacementFrame(caption).center.y).toBeCloseTo(destination.y + 40);
    const reaction = await callAssistantTool(s.context, "insert_reaction", { reactants: ["CC"], products: ["CC"],
      to: { relativeTo: "box", anchor: "center", rotateDeg: -30 } });
    expect(reaction.isError, JSON.stringify(reaction)).not.toBe(true);
    const added = s.context.getDocument()!.pages[0]!.objects.filter(o => (reaction.structuredContent!.objectIds as string[]).includes(o.id));
    expect(added.some(o => o.type === "reaction-arrow")).toBe(true);
    expect(added.every(o => o.rotation === -30)).toBe(true);
    const centers = added.filter(o => o.type === "molecule").map(o => figurePlacementFrame(o).center);
    expect(centers.reduce((sum, p) => sum + p.x, 0) / centers.length).toBeCloseTo(destination.x);
    expect(centers.reduce((sum, p) => sum + p.y, 0) / centers.length).toBeCloseTo(destination.y);
  });
  it("inserts a separately built axle through a selected ring in one batch, then permits refining the insertion", async () => {
    const s = fixture([cbpqt("box")]);
    const axle = ttf("new_ttf");
    const smiles = await canonical(axle);
    s.context.chemistry.inspectStructure = async (_format, value) => {
      const mol = (await ensureRdkit()).get_mol(value) as { get_smiles(): string; delete(): void } | null;
      if (!mol) return { valid: false, reason: "Invalid structure" };
      try { return { valid: true, canonicalSmiles: mol.get_smiles(), heavyAtoms: 10, formula: "C6H4S4", warnings: [] }; }
      finally { mol.delete(); }
    };
    s.context.chemistry.structureFromSmiles = async () => ({ available: true, built: true, object: axle });
    const result = await callAssistantTool(s.context, "insert_structures", { items: [{ kind: "molecule", smiles }],
      to: { relativeTo: "box", anchor: { ringKey: largestRing(s.molecules()[0]!).ringKey } }, crossings: "auto" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(s.context.write).toHaveBeenCalledOnce();
    const inserted = s.molecules().find(m => m.id !== "box")!;
    assertInterlock(s, inserted.id, "box");
    expect(await canonical(inserted)).toBe(smiles);
    const refined = await callAssistantTool(s.context, "move_objects", { objectIds: [inserted.id],
      to: { relativeTo: "box", anchor: "center" }, crossings: "auto" });
    expect(refined.isError).not.toBe(true);
  });
  it("rejects an anchor changed during insertion preparation", async () => {
    const s = fixture([cbpqt("box")]);
    s.context.chemistry.structureFromSmiles = async () => {
      s.replace(applyPatch(s.context.getDocument()!, { op: "updateObject", objectId: "box", changes: { x: 900 } }));
      return { available: true, built: true, object: ttf("new_ttf") };
    };
    const result = await callAssistantTool(s.context, "insert_structures", { items: [{ kind: "molecule", smiles: "CC" }],
      to: { relativeTo: "box", anchor: "center" } });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("read it again and retry") }] });
    expect(s.context.write).not.toHaveBeenCalled();
    expect(s.molecules()).toHaveLength(1);
  });
  it.each([
    { anchor: "center", offset: { dx: 101, dy: 0 } }, { anchor: "center", rotateDeg: Infinity },
    { anchor: "center", rotateDeg: 361 }, { anchor: { ringKey: "" } }, { anchor: "bogus" }
  ])("rejects invalid figure target %j", target => {
    expect(toolSchemas.move_objects.safeParse({ objectIds: ["a"], to: { relativeTo: "b", ...target } }).success).toBe(false);
  });
});
