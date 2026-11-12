import { afterEach, describe, expect, it, vi } from "vitest";
import { Molecule } from "openchemlib";
import { applyPatch, createDocumentHistory, createEmptyDocument, DocumentObjectSchema, undo, redo, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { applyPageFitDecision, commitWithPageFit, PageEnlargementConsent, planDocumentPageFit } from "./pageEnlargement";
import { applyChargeToolAtNativeAtom, insertTableIntoDocument, normalizeCommittedDocument, setDocumentCustomPageSize, translateDocumentPage } from "./documentWorkflow";
import { setNativePromptProvider } from "./nativePrompt";

const plus = (id: string, x: number, y: number, width = 8, height = 8) =>
  DocumentObjectSchema.parse({ id, type: "plus", x, y, width, height });
const cases = [
  { name: "left only", x: -24, y: 20, width: 8, height: 8, dx: 24, dy: 0, pageWidth: 124, pageHeight: 100 },
  { name: "top only", x: 20, y: -32, width: 8, height: 8, dx: 0, dy: 32, pageWidth: 100, pageHeight: 132 },
  { name: "left and bottom", x: -24, y: 92, width: 8, height: 48, dx: 24, dy: 0, pageWidth: 124, pageHeight: 140 },
  { name: "all four sides", x: -24, y: -32, width: 176, height: 184, dx: 24, dy: 32, pageWidth: 176, pageHeight: 184 }
];
afterEach(() => vi.restoreAllMocks());

it("retains right/bottom-only growth without shifting or fitting unrelated existing overflow", () => {
  const blank = setDocumentCustomPageSize(createEmptyDocument(), { width: 100, height: 100, unit: "css-px" });
  const page = blank.pages[0]!;
  const before = { ...blank, pages: [{ ...page, objects: [plus("existing", 300, 300)] }] };
  const proposed = applyPatch(before, { op: "addObject", pageId: page.id, object: plus("new", 132, 132) });
  const after = applyPageFitDecision(planDocumentPageFit(before, proposed), true);
  expect(after.pages[0]).toMatchObject({ width: 140, height: 140, objects: proposed.pages[0]!.objects });
});

describe.each(["macos", "windows"] as const)("page-wide enlargement translation on %s", platform => {
  it.each(cases.flatMap(test => [true, false].flatMap(enlarge => [true, false].map(second => ({ ...test, enlarge, second })))))(
    "$name / enlarge=$enlarge / second page=$second preserves geometry, selection and history", async test => {
    const blank = setDocumentCustomPageSize(createEmptyDocument(), { width: 100, height: 100, unit: "css-px" });
    const page = blank.pages[0]!;
    const molecule = createSmilesMolecule(blank, { x: 50, y: 50 }, depictSmiles2D("CC"), "CC");
    const pages = [{ ...page, objects: [molecule, plus("edge", 92, 92)] },
      { ...page, id: "other-page", objects: [plus("other-object", 20, 20)] }];
    const before = { ...blank, pages: test.second ? pages.reverse() : pages };
    const affected = test.second ? 1 : 0, unaffected = test.second ? 0 : 1;
    const object = plus("inserted", test.x, test.y, test.width, test.height);
    const proposed = applyPatch(before, { op: "batch", patches: [
      { op: "addObject", pageId: page.id, object }, { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ] });
    const prompt = vi.fn(async () => test.enlarge ? "enlarge" : "keep");
    const restore = setNativePromptProvider(prompt);
    let history = createDocumentHistory(before);
    let baseline = before;
    try {
      await commitWithPageFit(before, proposed, (after, fitBaseline) => {
        baseline = fitBaseline(before);
        history = { past: [before], present: after, future: [] };
      },
        { consent: new PageEnlargementConsent(platform) });
      const after = history.present;
      expect(prompt).toHaveBeenCalledOnce();
      expect(after.selection.objectIds).toEqual(["inserted"]);
      expect(after.pages[unaffected]).toEqual(before.pages[unaffected]);
      // The baseline receives exactly the host's page layout and movement, with no insertion
      // or selection from the proposed document. It must also leave other pages alone.
      expect(baseline.selection).toEqual(before.selection);
      expect(baseline.pages).toEqual(after.pages.map(page => ({ ...page,
        objects: page.objects.filter(object => object.id !== "inserted") })));
      if (!test.enlarge) expect(after).toEqual(proposed);
      else {
        const fitted = after.pages[affected]!;
        expect(fitted.width).toBe(test.pageWidth); expect(fitted.height).toBe(test.pageHeight);
        for (const original of proposed.pages[affected]!.objects) {
          const shifted = fitted.objects.find(candidate => candidate.id === original.id)!;
          expect(shifted.x).toBe(original.x + test.dx); expect(shifted.y).toBe(original.y + test.dy);
          expect(shifted.width).toBe(original.width); expect(shifted.height).toBe(original.height);
          if (original.type === "molecule" && shifted.type === "molecule") {
            expect(Molecule.fromMolfile(stereoPerceptionMolfile(shifted)).toIsomericSmiles())
              .toBe(Molecule.fromMolfile(stereoPerceptionMolfile(original)).toIsomericSmiles());
            expect(shifted.bonds).toEqual(original.bonds); expect(shifted.chemistry).toEqual(original.chemistry);
            expect(shifted.atoms).toEqual(original.atoms.map(atom => ({ ...atom, x: atom.x + test.dx, y: atom.y + test.dy })));
          }
        }
      }
      expect(history.past).toHaveLength(1);
      expect(undo(history).present).toEqual(before);
      expect(redo(undo(history)).present).toEqual(after);
      expect(prompt).toHaveBeenCalledOnce();
    } finally { restore(); }
  });
});

it("translates every native object kind, absolute anchors, graphics and attachments once, preserving chemistry and references", () => {
  const document = createEmptyDocument(), page = document.pages[0]!;
  const smiles = "[13CH3]/C=C/[C@@H]([NH3+])Cl";
  const molecule = createSmilesMolecule(document, { x: 150, y: 150 }, depictSmiles2D(smiles), smiles);
  const point = { kind: "point" as const, point: { x: 10, y: 20 } };
  const atom = { kind: "atom" as const, objectId: molecule.id, atomId: molecule.atoms[0]!.id };
  const make = (id: string, data: object): DocumentObject => DocumentObjectSchema.parse({ id, x: 10, y: 20, width: 20, height: 30, ...data });
  let nextId = 0;
  const table = insertTableIntoDocument(document, { rows: 2, columns: 2, headerRows: 1, preset: "grid",
    center: { x: 200, y: 200 }, newId: prefix => `${prefix}-shift-${++nextId}` }).pages[0]!.objects[0]!;
  const objects = [molecule, table,
    make("reaction", { type: "reaction", components: [{ role: "reactant", objectId: molecule.id }] }),
    make("arrow", { type: "reaction-arrow", arrowKind: "forward", start: point, end: atom }),
    make("mechanism", { type: "mechanism-arrow", arrowKind: "full-headed", source: atom, target: atom, controlPoints: [{ x: 10, y: 20 }] }),
    ...["charge", "lone-pair", "radical-dot"].flatMap(markKind => [point, atom].map((anchor, i) =>
      make(`${markKind}${i}`, { type: "electron-mark", markKind, anchor, ...(markKind === "charge" ? { charge: 1 } : {}) }))),
    make("text", { type: "text", text: "Caption" }),
    make("bracket", { type: "bracket", bracketKind: "square", containedObjectIds: [molecule.id] }),
    make("path", { type: "graphic", graphicKind: "path", data: { lineStart: { x: 10, y: 20 }, lineEnd: { x: 30, y: 50 },
      pathControlPoint: { x: 10, y: 20 }, arcCenter: { x: 10, y: 20 },
      pathNodes: [{ point: { x: 10, y: 20 }, inControl: { x: 10, y: 20 }, outControl: { x: 30, y: 50 } }],
      freehandPoints: [{ x: 10, y: 20 }, { x: 30, y: 50 }] } }),
    plus("plus", 10, 20), make("group", { type: "group", childObjectIds: [molecule.id] }),
    make("annotation", { type: "annotation", message: "Note", targetObjectIds: [molecule.id] }),
    make("superatom", { type: "superatom", label: "Me", metadata: { label: "Me", attachmentPoints: [point, atom] } }),
    make("rgroup", { type: "r-group-label", label: "R", display: { label: "R", attachmentPoints: [point, atom] } }),
    make("generic", { type: "generic-atom-label", label: "X" }),
    make("unknown", { type: "unknown-compatibility-object", sourceFormat: "test", sourceObjectType: "opaque", warning: "Unrecognized", raw: { preserve: true } })
  ];
  molecule.superatoms = [{ label: "Me", attachmentPoints: [point, atom], warnings: [] }];
  molecule.rGroups = [{ label: "R", querySemantics: "display-only", attachmentPoints: [point, atom], warnings: [] }];
  const before = { ...document, pages: [{ ...page, objects }] };
  const after = translateDocumentPage(before, page.id, 24, 32);
  for (const original of objects) {
    const shifted = after.pages[0]!.objects.find(object => object.id === original.id)!;
    expect(shifted.x).toBe(original.x + 24); expect(shifted.y).toBe(original.y + 32);
    expect(shifted.width).toBe(original.width); expect(shifted.height).toBe(original.height);
  }
  const shifted = after.pages[0]!.objects[0] as MoleculeObject;
  expect(Molecule.fromMolfile(stereoPerceptionMolfile(shifted)).toIsomericSmiles())
    .toBe(Molecule.fromMolfile(stereoPerceptionMolfile(molecule)).toIsomericSmiles());
  expect(shifted.atoms.map(({ x, y, ...rest }) => rest)).toEqual(molecule.atoms.map(({ x, y, ...rest }) => rest));
  expect(shifted.bonds).toEqual(molecule.bonds);
  expect(shifted.superatoms[0]!.attachmentPoints).toEqual([{ ...point, point: { x: 34, y: 52 } }, atom]);
  expect(shifted.rGroups[0]!.attachmentPoints).toEqual(shifted.superatoms[0]!.attachmentPoints);
  const get = (id: string) => after.pages[0]!.objects.find(object => object.id === id)!;
  expect(get("arrow")).toMatchObject({ start: { ...point, point: { x: 34, y: 52 } }, end: atom });
  expect(get("mechanism")).toMatchObject({ source: atom, target: atom, controlPoints: [{ x: 34, y: 52 }] });
  for (const kind of ["charge", "lone-pair", "radical-dot"]) {
    expect(get(`${kind}0`)).toMatchObject({ anchor: { ...point, point: { x: 34, y: 52 } } });
    expect(get(`${kind}1`)).toMatchObject({ anchor: atom });
  }
  expect(get("path")).toMatchObject({ data: { lineStart: { x: 34, y: 52 }, lineEnd: { x: 54, y: 82 },
    pathControlPoint: { x: 34, y: 52 }, arcCenter: { x: 34, y: 52 },
    pathNodes: [{ point: { x: 34, y: 52 }, inControl: { x: 34, y: 52 }, outControl: { x: 54, y: 82 } }],
    freehandPoints: [{ x: 34, y: 52 }, { x: 54, y: 82 }] } });
  expect(get("superatom")).toMatchObject({ metadata: { attachmentPoints: shifted.superatoms[0]!.attachmentPoints } });
  expect(get("rgroup")).toMatchObject({ display: { attachmentPoints: shifted.rGroups[0]!.attachmentPoints } });
  expect(after.selection).toEqual(before.selection);
  expect(planDocumentPageFit(before, before).growth).toEqual([]);
});

it("keeps an anchored charge's canonical chemistry and association through desktop normalization after translation", () => {
  const document = createEmptyDocument(), page = document.pages[0]!;
  const molecule = createSmilesMolecule(document, { x: 150, y: 150 }, depictSmiles2D("CN"), "CN");
  const source = applyPatch(document, { op: "addObject", pageId: page.id, object: molecule });
  const nitrogen = molecule.atoms.find(atom => atom.element === "N")!;
  const before = normalizeCommittedDocument(applyChargeToolAtNativeAtom(source, 1,
    { kind: "atom", objectId: molecule.id, atomId: nitrogen.id, distanceToPointer: 0 }));
  const original = before.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
  expect(original.atoms.find(atom => atom.id === nitrogen.id)!.formalCharge).toBe(1);
  const moved = translateDocumentPage(before, page.id, 24, 32);
  const normalized = normalizeCommittedDocument(moved);
  expect(normalized.pages[0]!.objects).toEqual(moved.pages[0]!.objects);
  const shifted = normalized.pages[0]!.objects.find(object => object.id === molecule.id) as MoleculeObject;
  expect(Molecule.fromMolfile(stereoPerceptionMolfile(shifted)).toIsomericSmiles())
    .toBe(Molecule.fromMolfile(stereoPerceptionMolfile(original)).toIsomericSmiles());
  expect(shifted.atoms).toEqual(original.atoms.map(atom => ({ ...atom, x: atom.x + 24, y: atom.y + 32 })));
});
