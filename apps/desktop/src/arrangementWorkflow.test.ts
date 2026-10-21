import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { describe, expect, it } from "vitest";
import { applyPatches, serializeDocument, deserializeDocument, type ChemDraftDocument, type DocumentPatch, type MoleculeObject, type TextObject, type ElectronMarkObject } from "@chemdraft/chem-core";
import { ArrangementLayouts, moleculeVisualBoundsForArrangement, textVisualBoundsForArrangement } from "@chemdraft/layout-engine";
import { nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { arrangeSelectedDocumentObjects, createNativeSingleBondMolecule, createPhase4Document,
  groupSelectedDocumentObjects, selectedArrangementObjectIds, selectDocumentObjects, setDocumentCustomPageSize,
  adjustArrangementSpacing, arrangementSpacingRange, arrangementSpacingPreviewBounds,
  normalizeCommittedDocument, reconcileNativeChargeMarks, moveDocumentObjects, alignSelectedDocumentObjects, phase4Timestamp } from "./documentWorkflow";
import { arrangementCommandId, arrangementLayoutForCommand, arrangementGridAlignmentForCommand, arrangementIconName, createLayerActions } from "./commands";

function selectedCompounds(count = 6): ChemDraftDocument {
  let document = createPhase4Document("Catalytic cycle");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const molecule = createNativeSingleBondMolecule(document, { x: 200 + i % 3 * 120, y: 250 + Math.floor(i / 3) * 150 },
      i === 4 ? { bondStyle: "wedge" } : {});
    // A long visible label tests the stored atom box's insufficient width.
    if (i === 2) molecule.atoms[0].element = "PhosphineLigand";
    if (i === 3) { molecule.atoms[1].formalCharge = 1; }
    ids.push(molecule.id);
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: molecule }]);
  }
  return selectDocumentObjects(document, document.pages[0].id, ids);
}

function groupedRotatedCaption(rotation = 90): ChemDraftDocument {
  let document = createPhase4Document("Rotated caption");
  const first = createNativeSingleBondMolecule(document, { x: 120, y: 260 });
  const second = { ...createNativeSingleBondMolecule(document, { x: 550, y: 30 }), id: "other-molecule" };
  const caption: TextObject = { id: "rotated-caption", type: "text", text: "Grouped caption", spans: [],
    x: 120, y: 290, width: 400, height: 20, rotation, style: {} };
  document = applyPatches(document, [first, second, caption].map(object => ({ op: "addObject" as const, pageId: document.pages[0].id, object })));
  document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [first.id, caption.id]));
  return selectDocumentObjects(document, document.pages[0].id, [...document.selection.objectIds, second.id]);
}

function stickyChargeFixture(): ChemDraftDocument {
  let document = createPhase4Document("Sticky oxygen charge");
  const molecule = { ...createNativeSingleBondMolecule(document, { x: 200, y: 200 }), id: "charged" };
  molecule.atoms[0].element = "O";
  const second = { ...createNativeSingleBondMolecule(document, { x: 500, y: 500 }), id: "second" };
  const [oxygen, carbon] = molecule.atoms;
  // Still attached to O, but visibly nearer C: re-inferring an anchor would change chemistry.
  const x = oxygen.x + (carbon.x - oxygen.x) * 0.65, y = oxygen.y + (carbon.y - oxygen.y) * 0.65;
  const charge: ElectronMarkObject = { id: "sticky-charge", type: "electron-mark", markKind: "charge", charge: -1,
    x: x - 5, y: y - 5, width: 10, height: 10, rotation: 0, style: {},
    anchor: { kind: "atom", objectId: molecule.id, atomId: oxygen.id } };
  document = applyPatches(document, [molecule, second, charge].map(object => ({ op: "addObject" as const, pageId: document.pages[0].id, object })));
  document = normalizeCommittedDocument(reconcileNativeChargeMarks(document));
  return selectDocumentObjects(document, document.pages[0].id, [molecule.id, second.id]);
}

describe("arranging document selections", () => {
  it.each([...ArrangementLayouts, "spacing"] as const)("preserves a sticky charge's atom identity through %s and commit normalization", operation => {
    const before = stickyChargeFixture();
    const moved = operation === "spacing" ? adjustArrangementSpacing(before, 1.1).document :
      arrangeSelectedDocumentObjects(before, operation).document;
    expect(moved).not.toBe(before);
    const after = normalizeCommittedDocument(moved);
    const old = before.pages[0].objects.find(object => object.id === "charged")! as MoleculeObject;
    const next = after.pages[0].objects.find(object => object.id === old.id)! as MoleculeObject;
    expect(old.atoms.map(atom => atom.formalCharge ?? 0)).toEqual([-1, 0]);
    expect(next.atoms.map(atom => atom.formalCharge ?? 0)).toEqual([-1, 0]);
    expect(next.chemistry).toEqual(old.chemistry);expect(next.bonds).toEqual(old.bonds);
    expect(nativeSingleBondGraphSmiles(next.atoms, next.bonds)).toBe(nativeSingleBondGraphSmiles(old.atoms, old.bonds));
    const dx = next.x - old.x, dy = next.y - old.y;
    next.atoms.forEach((atom, i) => {
      expect({ ...atom, x: old.atoms[i].x, y: old.atoms[i].y }).toEqual(old.atoms[i]);
      expect(atom.x - old.atoms[i].x).toBeCloseTo(dx);expect(atom.y - old.atoms[i].y).toBeCloseTo(dy);
    });
    const oldMark = before.pages[0].objects.find(object => object.id === "sticky-charge")! as ElectronMarkObject;
    const mark = after.pages[0].objects.find(object => object.id === oldMark.id)! as ElectronMarkObject;
    expect(mark.anchor).toEqual(oldMark.anchor);
    expect(mark.x - oldMark.x).toBeCloseTo(dx);expect(mark.y - oldMark.y).toBeCloseTo(dy);
    const reopened = normalizeCommittedDocument(deserializeDocument(serializeDocument(after)));
    expect(reopened.pages[0].objects).toEqual(after.pages[0].objects);
    expect(after.selection).toEqual(before.selection);
  });
  // Charge stickiness for group drags and alignment is a separate change.
  it.each(["group drag", "alignment"] as const)("keeps main's exact document behavior for %s", operation => {
    const before = stickyChargeFixture();
    const expected = applyPatches(before, before.pages[0].objects.flatMap<DocumentPatch>(object => {
      const dx = operation === "group drag" ? 50 : object.id === "second" ? 0 : 300;
      const dy = operation === "group drag" ? 40 : 0;
      if (dx === 0 && dy === 0) return [];
      const x = object.x + dx, y = object.y + dy;
      if (object.type === "molecule") return [{ op: "updateObject", objectId: object.id, changes: {
        x, y, atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
      } }];
      if (object.type === "electron-mark") return [{ op: "updateObject", objectId: object.id, changes: {
        x, y, anchor: { ...object.anchor, kind: "point", point: { x: x + object.width / 2, y: y + object.height / 2 } }
      } }];
      return [];
    }), { now: phase4Timestamp });
    const moved = operation === "group drag" ? moveDocumentObjects(before, before.selection.objectIds, 50, 40) :
      alignSelectedDocumentObjects(before, "right");
    expect(moved).toEqual(expected);
    const after = normalizeCommittedDocument(moved);
    expect(after).toEqual(normalizeCommittedDocument(expected));
    const molecule = after.pages[0].objects.find(object => object.id === "charged")! as MoleculeObject;
    expect(molecule.atoms.map(atom => atom.formalCharge ?? 0)).toEqual([0, -1]);
    expect(after.pages[0].objects.find(object => object.id === "sticky-charge"))
      .toMatchObject({ anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[1].id } });
  });
  it.each([...ArrangementLayouts, "spacing"] as const)("carries a selected mark with a stale atomId exactly once through %s", operation => {
    let before = stickyChargeFixture();
    const oldMark = before.pages[0].objects.find(object => object.id === "sticky-charge")! as ElectronMarkObject;
    before = applyPatches(before, [{ op: "updateObject", objectId: oldMark.id,
      changes: { anchor: { ...oldMark.anchor, atomId: "stale-atom" } } }]);
    before = selectDocumentObjects(before, before.pages[0].id, [...before.selection.objectIds, oldMark.id]);
    expect(selectedArrangementObjectIds(before)).toEqual(["charged", "second"]);
    const result = operation === "spacing" ? adjustArrangementSpacing(before, 1.1) : arrangeSelectedDocumentObjects(before, operation);
    expect(result.document).not.toBe(before);
    const old = before.pages[0].objects.find(object => object.id === "charged")!;
    const next = result.document.pages[0].objects.find(object => object.id === old.id)!;
    const mark = result.document.pages[0].objects.find(object => object.id === oldMark.id)!;
    const dx = next.x - old.x, dy = next.y - old.y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1);
    expect(mark.x - oldMark.x).toBeCloseTo(dx);expect(mark.y - oldMark.y).toBeCloseTo(dy);
    expect(result.document.selection).toEqual(before.selection);
  });
  it("still lets an independently moved charge mark attach to a different atom", () => {
    const before = stickyChargeFixture();
    const after = normalizeCommittedDocument(moveDocumentObjects(before, ["sticky-charge"], 1, 0));
    const molecule = after.pages[0].objects.find(object => object.id === "charged")! as MoleculeObject;
    expect(molecule.atoms.map(atom => atom.formalCharge ?? 0)).toEqual([0, -1]);
    const mark = after.pages[0].objects.find(object => object.id === "sticky-charge")! as ElectronMarkObject;
    expect(mark.anchor).toMatchObject({ kind: "atom", objectId: molecule.id, atomId: molecule.atoms[1].id });
  });
  it.each(ArrangementLayouts)("keeps a grouped rotated caption inside the page for %s and spacing previews", layout => {
    const before = groupedRotatedCaption();
    const result = arrangeSelectedDocumentObjects(before, layout);
    expect(result.status).toContain("Arranged 2 objects");
    expect(result.document).not.toBe(before);
    const assertCaption = (document: ChemDraftDocument) => {
      const page = document.pages[0];
      const caption = page.objects.find(object => object.id === "rotated-caption")! as TextObject;
      // A 400 × 20 box rotated 90° has visible bounds (x+190, y-190, 20, 400).
      expect(caption.x + 190).toBeGreaterThanOrEqual(-1e-7);
      expect(caption.y - 190).toBeGreaterThanOrEqual(-1e-7);
      expect(caption.x + 210).toBeLessThanOrEqual(page.width + 1e-7);
      expect(caption.y + 210).toBeLessThanOrEqual(page.height + 1e-7);
      const oldCaption = before.pages[0].objects.find(object => object.id === caption.id)! as TextObject;
      const oldMolecule = before.pages[0].objects.find(object => object.type === "molecule")! as MoleculeObject;
      const molecule = page.objects.find(object => object.id === oldMolecule.id)! as MoleculeObject;
      expect({ ...caption, x: oldCaption.x, y: oldCaption.y }).toEqual(oldCaption);
      expect(caption.x - oldCaption.x).toBeCloseTo(molecule.x - oldMolecule.x);
      expect(caption.y - oldCaption.y).toBeCloseTo(molecule.y - oldMolecule.y);
      expect({ ...molecule, x: oldMolecule.x, y: oldMolecule.y, atoms: oldMolecule.atoms }).toEqual(oldMolecule);
      const frame = arrangementSpacingPreviewBounds(document)!;
      const visible = textVisualBoundsForArrangement(caption);
      expect(frame.x).toBeLessThanOrEqual(visible.x + 1e-7);
      expect(frame.y).toBeLessThanOrEqual(visible.y + 1e-7);
      expect(frame.x + frame.width).toBeGreaterThanOrEqual(visible.x + visible.width - 1e-7);
      expect(frame.y + frame.height).toBeGreaterThanOrEqual(visible.y + visible.height - 1e-7);
    };
    assertCaption(result.document);
    const range = arrangementSpacingRange(result.document);
    for (const factor of [range.min, range.max]) {
      const spaced = adjustArrangementSpacing(result.document, factor);
      expect(spaced.ok).toBe(true);assertCaption(spaced.document);
    }
    expect(result.document.selection).toEqual(before.selection);
  });
  it("refuses a rotated grouped caption that is taller than the page without changing the document", () => {
    const before = setDocumentCustomPageSize(groupedRotatedCaption(), { width: 8.5, height: 3, unit: "inch" });
    const result = arrangeSelectedDocumentObjects(before, "row");
    expect(result.status).toContain("does not fit");expect(result.document).toBe(before);
    const spaced = adjustArrangementSpacing(before, 1.1);
    expect(spaced.ok).toBe(false);expect(spaced.document).toBe(before);
  });
  it.each(["circle", "oval", "grid"] as const)("switches from %s to tight rows and columns without changing molecular geometry", from => {
    for (const to of ["row", "column"] as const) {
      let before = arrangeSelectedDocumentObjects(selectedCompounds(3), from).document;
      const frames = before.pages[0].objects.map(object => moleculeVisualBoundsForArrangement(object as MoleculeObject));
      const occupied = frames.reduce((sum, bounds) => sum + (to === "row" ? bounds.width : bounds.height), 0);
      const span = occupied + 20 * (frames.length - 1);
      before = setDocumentCustomPageSize(before, {
        width: (to === "row" ? span : 1200) / 96,
        height: (to === "column" ? span : 1200) / 96, unit: "inch"
      });
      expect(arrangeSelectedDocumentObjects(before, to, { gap: 48 }).document).toBe(before);
      const result = arrangeSelectedDocumentObjects(before, to);
      expect(result.status).toContain(`in a ${to}`);
      expect(result.document).not.toBe(before);
      expect(result.document.selection).toEqual(before.selection);
      const page = result.document.pages[0];
      for (const object of page.objects) {
        const old = before.pages[0].objects.find(candidate => candidate.id === object.id)! as MoleculeObject;
        const next = object as MoleculeObject;
        const bounds = moleculeVisualBoundsForArrangement(next);
        expect(bounds.x).toBeGreaterThanOrEqual(-1e-7);
        expect(bounds.y).toBeGreaterThanOrEqual(-1e-7);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.width + 1e-7);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.height + 1e-7);
        expect({ ...next, x: old.x, y: old.y, atoms: old.atoms }).toEqual(old);
        const dx = next.atoms[0].x - old.atoms[0].x, dy = next.atoms[0].y - old.atoms[0].y;
        next.atoms.forEach((atom, i) => {
          expect({ ...atom, x: old.atoms[i].x, y: old.atoms[i].y }).toEqual(old.atoms[i]);
          expect(atom.x - old.atoms[i].x).toBeCloseTo(dx);
          expect(atom.y - old.atoms[i].y).toBeCloseTo(dy);
        });
      }
    }
  });
  it.each(ArrangementLayouts)("%s rigidly translates chiral, isotopic and charged molecules", layout => {
    let doc=createPhase4Document("Stereo preservation");
    for (const [i,smiles] of ["N[C@@H](C)C(=O)O", "[13CH3][C@H](F)Cl", "C[N+](C)(C)C"].entries()) {
      const molecule=createSmilesMolecule(doc,{x:180+i*150,y:250},depictSmiles2D(smiles),smiles);
      doc=applyPatches(doc,[{op:"addObject",pageId:doc.pages[0].id,object:molecule}]);
    }
    doc=selectDocumentObjects(doc,doc.pages[0].id,doc.pages[0].objects.map(o=>o.id));
    const after=arrangeSelectedDocumentObjects(doc,layout).document;
    for(const before of doc.pages[0].objects) if(before.type==="molecule") {
      const next=after.pages[0].objects.find(o=>o.id===before.id) as MoleculeObject;
      expect(next.structure).toBe(before.structure);expect(next.chemistry).toEqual(before.chemistry);
      expect(next.bonds).toEqual(before.bonds);expect(next.atoms).toHaveLength(before.atoms.length);
      const dx=next.atoms[0].x-before.atoms[0].x,dy=next.atoms[0].y-before.atoms[0].y;
      for(let i=0;i<before.atoms.length;i++) {
        expect({...next.atoms[i],x:before.atoms[i].x,y:before.atoms[i].y}).toEqual(before.atoms[i]);
        expect(next.atoms[i].x-before.atoms[i].x).toBeCloseTo(dx);expect(next.atoms[i].y-before.atoms[i].y).toBeCloseTo(dy);
      }
      expect({...next,x:before.x,y:before.y,atoms:before.atoms}).toEqual(before);
    }
    expect(after.selection).toEqual(doc.selection);
    expect(after.pages[0].objects).toHaveLength(3);
  });
  it.each(ArrangementLayouts)("%s preserves every molecular property and rigid internal geometry, and saves/reopens", (layout) => {
    const before = selectedCompounds();
    const result = arrangeSelectedDocumentObjects(before, layout);
    expect(result.document).not.toBe(before);
    expect(result.document.selection).toEqual(before.selection);
    const reopened = deserializeDocument(serializeDocument(result.document));
    expect(reopened).toEqual(result.document);
    for (const object of reopened.pages[0].objects.filter((object) => object.type === "molecule")) {
      const old = before.pages[0].objects.find((candidate) => candidate.id === object.id)! as MoleculeObject;
      const next = object as MoleculeObject;
      expect({ ...next, x: old.x, y: old.y, atoms: old.atoms }).toEqual(old);
      const dx = next.x - old.x, dy = next.y - old.y;
      next.atoms.forEach((atom, i) => {
        expect(atom.x - old.atoms[i].x).toBeCloseTo(dx, 7);
        expect(atom.y - old.atoms[i].y).toBeCloseTo(dy, 7);
        expect({ ...atom, x: old.atoms[i].x, y: old.atoms[i].y }).toEqual(old.atoms[i]);
      });
      expect(next.atoms).toHaveLength(old.atoms.length);
      expect(next.bonds).toHaveLength(old.bonds.length);
      expect(nativeSingleBondGraphSmiles(next.atoms, next.bonds)).toBe(nativeSingleBondGraphSmiles(old.atoms, old.bonds));
    }
  });
  it("includes long atom labels in the visible clearance", () => {
    const before = selectedCompounds();
    const after = arrangeSelectedDocumentObjects(before, "row", { gap: 24 }).document;
    const bounds = after.pages[0].objects.map((object) => moleculeVisualBoundsForArrangement(object as MoleculeObject)).sort((a, b) => a.x - b.x);
    for (let i = 1; i < bounds.length; i++) expect(bounds[i].x - bounds[i - 1].x - bounds[i - 1].width).toBeCloseTo(24, 6);
  });
  it("moves grouped compounds and labels together and excludes selected descendants and carried marks", () => {
    let document = selectedCompounds(2);
    const [first, second] = document.pages[0].objects as MoleculeObject[];
    const label: TextObject = { id: "caption", type: "text", x: first.x, y: first.y + 50, width: 160, height: 24,
      rotation: 0, style: {}, text: "Intermediate A", spans: [] };
    document = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0].id, object: label },
      { op: "addObject", pageId: document.pages[0].id, object: {
        id: "mark", type: "electron-mark", markKind: "lone-pair", x: first.x, y: first.y - 12, width: 8, height: 8,
        rotation: 0, style: {}, anchor: { kind: "atom", objectId: first.id, atomId: first.atoms[0].id }
      } }
    ]);
    document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [first.id, label.id]));
    const groupId = document.selection.objectIds[0];
    document = applyPatches(document, [{ op: "setSelection", pageId: document.pages[0].id, objectIds: [groupId, first.id, "mark", second.id] }]);
    expect(selectedArrangementObjectIds(document)).toEqual([second.id, groupId]);
    const arranged = arrangeSelectedDocumentObjects(document, "circle").document;
    const movedFirst = arranged.pages[0].objects.find((o) => o.id === first.id)!;
    const dx = movedFirst.x - first.x, dy = movedFirst.y - first.y;
    for (const id of [label.id, "mark"]) {
      const old = document.pages[0].objects.find((o) => o.id === id)!;
      const next = arranged.pages[0].objects.find((o) => o.id === id)!;
      expect(next.x - old.x).toBeCloseTo(dx, 7);
      expect(next.y - old.y).toBeCloseTo(dy, 7);
    }
    expect(arranged.pages[0].objects.find((o) => o.id === "mark" && o.type === "electron-mark"))
      .toMatchObject({ anchor: { kind: "atom", objectId: first.id, atomId: first.atoms[0].id } });
    expect(arranged.pages[0].objects.find((o) => o.id === groupId)).toEqual(document.pages[0].objects.find((o) => o.id === groupId));
  });
  it("changes only selected objects on the selected page, and does nothing on insufficient selections", () => {
    const document = selectedCompounds(3);
    const selected = selectDocumentObjects(document, document.pages[0].id, document.selection.objectIds.slice(0, 2));
    const result = arrangeSelectedDocumentObjects(selected, "circle");
    expect(result.document.pages[0].objects[2]).toEqual(document.pages[0].objects[2]);
    const single = selectDocumentObjects(document, document.pages[0].id, [document.selection.objectIds[0]]);
    expect(arrangeSelectedDocumentObjects(single, "circle").document).toBe(single);
    const otherPage = { ...document.pages[0], id: "page_other", objects: document.pages[0].objects.map((o) => ({ ...o, id: `${o.id}_other` })) };
    const twoPages = { ...selected, pages: [otherPage, selected.pages[0]] };
    const arranged = arrangeSelectedDocumentObjects(twoPages, "circle").document;
    expect(arranged.pages[0]).toEqual(otherPage);
    expect(arranged.pages[1].objects[0]).not.toEqual(selected.pages[0].objects[0]);
  });
  it("refuses page overflow without moving, resizing or recording a document change", () => {
    const document = selectedCompounds();
    const result = arrangeSelectedDocumentObjects(document, "circle", { gap: 1000 });
    expect(result.document).toBe(document);
    expect(result.status).toContain("does not fit");
  });
  it("does not arrange a nested selected group twice", () => {
    let document = selectedCompounds(3);
    const [first, second, third] = document.selection.objectIds;
    document = groupSelectedDocumentObjects(selectDocumentObjects(document, document.pages[0].id, [first, second]));
    const inner = document.selection.objectIds[0];
    document = applyPatches(document, [{ op: "addObject", pageId: document.pages[0].id, object: {
      id: "outer", type: "group", childObjectIds: [inner], x: 0, y: 0, width: 1, height: 1, rotation: 0, style: {}
    } }, { op: "setSelection", pageId: document.pages[0].id, objectIds: ["outer", inner, first, third] }]);
    expect(selectedArrangementObjectIds(document)).toEqual([third, "outer"]);
    const arranged = arrangeSelectedDocumentObjects(document, "circle").document;
    const old = document.pages[0].objects.filter((o) => o.id === first || o.id === second);
    const next = arranged.pages[0].objects.filter((o) => o.id === first || o.id === second);
    expect(next[0].x - old[0].x).toBeCloseTo(next[1].x - old[1].x, 7);
    expect(next[0].y - old[0].y).toBeCloseTo(next[1].y - old[1].y, 7);
  });
  it("registers every layout with truthful availability and strict command parsing", () => {
    const document = selectedCompounds();
    for (const layout of ArrangementLayouts) {
      const id = arrangementCommandId(layout);
      expect(arrangementLayoutForCommand(id)).toBe(layout);
      expect(createLayerActions(document, true).find((c) => c.id === id)?.enabled).toBe(true);
      expect(createLayerActions(createPhase4Document(), true).find((c) => c.id === id)?.enabled).toBe(false);
    }
    expect(arrangementLayoutForCommand("layout.arrange.circle.other")).toBeUndefined();
    for (const alignment of ["left", "center", "right"] as const) {
      const id = arrangementCommandId("grid", alignment);
      expect(arrangementLayoutForCommand(id)).toBe("grid");
      expect(arrangementGridAlignmentForCommand(id)).toBe(alignment);
      expect(createLayerActions(document, true).find((command) => command.id === id)).toMatchObject({ enabled: true, icon: arrangementIconName("grid", alignment) });
      expect(createLayerActions(createPhase4Document(), true).find((command) => command.id === id)?.enabled).toBe(false);
    }
    expect(arrangementLayoutForCommand("layout.arrange.grid.left.extra")).toBeUndefined();
    expect(arrangementGridAlignmentForCommand("layout.arrange.grid.extra")).toBeUndefined();
  });
});
