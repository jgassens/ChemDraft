import { describe, expect, it } from "vitest";
import { applyPatches, cloneDocument, createDocumentHistory, deserializeDocument, JournalProfileSchema,
  JournalRequestSchema, redo, serializeDocument, undo, type ChemDraftDocument, type JournalRequest, type MoleculeObject } from "@chemdraft/chem-core";
import { applyJournalStyle, journalRulePixels } from "@chemdraft/document-workflow-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { applyNativeChainTool, createNativeSavePayload, openNativeDocument, createPhase4Document } from "../documentWorkflow";
import { initialJournalRequest, journals, profiles, resolveJournalProfile, searchJournals } from "./catalog";
import { checkJournalExport, journalPreflightMessages, savedJournalFigures } from "./preflight";
import { journalStylePreview } from "./owner";
import { parseDialogMessage } from "../dialogs/dialogProtocol";

const request = (profileId = "rsc-advances", extra: Partial<JournalRequest> = {}): JournalRequest => ({ profileId, figureType: "scheme", scope: "document", resizeBonds: false, ...extra });
const fixture = () => applyNativeChainTool(createPhase4Document("Journal fixture"), { x: 100, y: 100 }, { x: 200, y: 130 });
const molecule = (document: ChemDraftDocument) => document.pages[0].objects.find(object => object.type === "molecule") as MoleculeObject;
const chemistry = (molecule: MoleculeObject) => ({ ...molecule, style: {}, x: 0, y: 0, width: 0, height: 0,
  atoms: molecule.atoms.map(({ x: _x, y: _y, ...atom }) => atom) });

describe("sourced journal catalog", () => {
  it("has exactly five identities verified through Crossref and rule-level official sources", () => {
    expect(journals).toHaveLength(5); expect(profiles).toHaveLength(5);
    expect(new Set(journals.map(journal => journal.publisher))).toEqual(new Set(["ACS", "RSC", "Nature Portfolio"]));
    for (const journal of journals) { expect(journal.identitySource).toContain("https://api.crossref.org/journals/"); expect(journal.issns.length).toBeGreaterThan(0); }
    for (const profile of profiles) {
      expect(JournalProfileSchema.safeParse(profile).success).toBe(true);
      expect(profile.status).toBe("partial");
      for (const rule of Object.values(profile.rules)) expect(rule?.sourceUrl).toMatch(/^https:\/\/(www\.nature\.com|www\.rsc\.org|researcher-resources\.acs\.org)\//);
    }
  });
  it.each(["JACS", "00027863", "0002-7863", "American Chemical Society", "ACS"])("searches name, alias, publisher and punctuation-free ISSN: %s", query => {
    // ACS is the displayed publisher name; the full name is also a journal title fragment.
    expect(searchJournals(query).some(journal => journal.id === "jacs")).toBe(true);
  });
  it("does not invent ACS bond lengths and correctly converts Nature's cm settings", () => {
    expect(resolveJournalProfile(initialJournalRequest).rules.bondLength).toBeUndefined();
    const nature = resolveJournalProfile(request("nature-chemistry"));
    expect(journalRulePixels(nature.rules.bondLength!)).toBeCloseTo(14.4);
    expect(journalRulePixels(nature.rules.fontSize!)).toBeCloseTo(8);
  });
  it("rejects unknown rules, bad units, impossible numbers, missing provenance and malformed custom input", () => {
    const valid = structuredClone(profiles[2]);
    for (const value of [NaN, Infinity, -1, 0]) {
      expect(JournalProfileSchema.safeParse({ ...valid, rules: { fontSize: { ...valid.rules.fontSize!, value } } }).success).toBe(false);
    }
    expect(JournalProfileSchema.safeParse({ ...valid, rules: { fabricated: valid.rules.fontSize } }).success).toBe(false);
    expect(JournalProfileSchema.safeParse({ ...valid, rules: { fontSize: { ...valid.rules.fontSize!, unit: "percent" } } }).success).toBe(false);
    expect(JournalProfileSchema.safeParse({ ...valid, rules: { fontSize: { ...valid.rules.fontSize!, sourceUrl: null } } }).success).toBe(false);
    expect(JournalRequestSchema.safeParse({ ...request(), scope: "all-files" }).success).toBe(false);
    expect(JournalRequestSchema.safeParse({ ...request(), profileId: "custom" }).success).toBe(false);
  });
});
describe("journal style transactions", () => {
  it.each(profiles.map(profile => [profile.id, profile.figures[0].id]))("preserves chemistry and coordinates for %s", (id, figureType) => {
    const original = fixture(), before = serializeDocument(original);
    const styled = applyJournalStyle(original, resolveJournalProfile(request(id, { figureType })), request(id, { figureType }));
    expect(chemistry(molecule(styled))).toEqual(chemistry(molecule(original)));
    expect(molecule(styled).atoms).toEqual(molecule(original).atoms);
    expect(molecule(styled).bonds).toEqual(molecule(original).bonds);
    expect(serializeDocument(original)).toBe(before);
    expect(styled.selection).toEqual(original.selection);
  });
  it("preserves charge, isotope, radical and wedge payloads during explicit uniform resizing", () => {
    let original = fixture(); const source = molecule(original);
    original = applyPatches(original, [{ op: "updateObject", objectId: source.id, changes: {
      chemistry: { ...source.chemistry, isotopeLabels: ["15N"], stereochemistry: ["R"], warnings: [], radicalCount: 1 },
      atoms: source.atoms.map((atom, index) => index === 0 ? { ...atom, element: "N", formalCharge: 1, markRadicals: 1 } : atom),
      bonds: source.bonds.map((bond, index) => index === 0 ? { ...bond, display: { ...bond.display, bondStyle: "wedge" as const } } : bond)
    } }]);
    const r = request("nature-chemistry", { resizeBonds: true });
    const styled = applyJournalStyle(original, resolveJournalProfile(r), r);
    expect(chemistry(molecule(styled))).toEqual(chemistry(molecule(original)));
    expect(molecule(styled).atoms).not.toEqual(molecule(original).atoms);
  });
  it("limits selection scope to selected page and includes selected group children", () => {
    let document = fixture(); const first = molecule(document);
    document = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0].id, object: { ...first, id: "untouched", x: 300 } },
      { op: "addObject", pageId: document.pages[0].id, object: { type: "group", id: "group", x: 0, y: 0, width: 100, height: 100, rotation: 0, style: {}, childObjectIds: [first.id] } },
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ["group"] }
    ]);
    const secondPage = { ...document.pages[0], id: "other-page", objects: [{ ...first, id: "other-molecule" }] };
    document = { ...document, pages: [...document.pages, secondPage] };
    const r = request("rsc-advances", { scope: "selection" });
    const styled = applyJournalStyle(document, resolveJournalProfile(r), r);
    expect(molecule(styled).style).toHaveProperty("journalPreset");
    expect(styled.pages[0].objects.find(o => o.id === "untouched")).toEqual(document.pages[0].objects.find(o => o.id === "untouched"));
    expect(styled.pages[1]).toEqual(secondPage);
    expect(styled.styles).not.toHaveProperty("journalPreset");
  });
  it("styles all pages in document scope, round trips offline, and supports one undo and redo", () => {
    const source = fixture();
    const original = { ...source, pages: [...source.pages, { ...source.pages[0], id: "page-two", objects: [{ ...molecule(source), id: "mol-two" }] }] };
    const r = request(); const styled = applyJournalStyle(original, resolveJournalProfile(r), r);
    expect(styled.pages[1].objects[0].style).toHaveProperty("journalPreset");
    expect(deserializeDocument(serializeDocument(styled))).toEqual(styled);
    expect(openNativeDocument(createNativeSavePayload(styled).contents).document).toEqual(styled);
    const history = { ...createDocumentHistory(original), past: [original], present: styled };
    expect(undo(history).present).toBe(original); expect(redo(undo(history)).present).toBe(styled);
  });
  it("rejects empty selections, unknown profiles, unverified rules and unavailable resizing", () => {
    const source = fixture(); const p = resolveJournalProfile(request());
    expect(() => applyJournalStyle({ ...source, selection: { objectIds: [] } }, p, request(p.id, { scope: "selection" }))).toThrow(/select/i);
    expect(() => applyJournalStyle(source, p, request("unknown"))).toThrow(/Unknown/);
    expect(() => applyJournalStyle(source, { ...p, status: "unverified" }, request())).toThrow(/verified/);
    expect(() => applyJournalStyle(source, profiles[0], { ...initialJournalRequest, resizeBonds: true })).toThrow(/bond length/);
  });
  it("does not recursively embed old snapshots when presets are applied repeatedly", () => {
    const r = request(), p = resolveJournalProfile(r); let document = fixture();
    for (let i = 0; i < 4; i++) document = applyJournalStyle(document, p, r);
    const snapshot = molecule(document).style.journalPreset as { resolvedStyle: Record<string, unknown> };
    expect(snapshot.resolvedStyle).not.toHaveProperty("journalPreset");
  });
  it("preserves explicit atom/bond display overrides and other editable objects", () => {
    let source = fixture(); const original = molecule(source);
    source = applyPatches(source, [{ op: "updateObject", objectId: original.id, changes: { style: { ...original.style, atomLabelColors: { [original.atoms[0].id]: "red" } } } }]);
    const r = request(); const styled = applyJournalStyle(source, resolveJournalProfile(r), r);
    expect(molecule(styled).style.atomLabelColors).toEqual(molecule(source).style.atomLabelColors);
  });
});
it("previews without changing the source and uses the shared layout/export plan", () => {
  const source = fixture(), before = cloneDocument(source), r = request();
  const preview = journalStylePreview(source, r);
  const styled = applyJournalStyle(source, resolveJournalProfile(r), r);
  const exported = exportDocumentToSvg(styled).contents;
  const svg = Buffer.from(preview.url.split(",")[1], "base64").toString("utf8");
  expect(source).toEqual(before);
  expect(preview.warnings.some(w => w.includes("page size"))).toBe(true);
  // The only preview difference is its root crop and background, not the render fragments.
  expect(svg.slice(svg.indexOf("\n"))).toBe(exportDocumentToSvg(styled, { background: "transparent" }).contents.slice(exported.indexOf("\n")));
  expect(planPageSvgRender(styled.pages[0]).fragments.length).toBeGreaterThan(0);
});
it("reports actual export dimensions, format and DPI; uses saved constraints after catalog changes", () => {
  const r = request("rsc-advances", { figureType: "toc" });
  const styled = applyJournalStyle(fixture(), resolveJournalProfile(r), r), figure = savedJournalFigures(styled)[0];
  expect(checkJournalExport(figure, "pdf", 90, 50)).toEqual(expect.arrayContaining([expect.stringMatching(/width/), expect.stringMatching(/height/), expect.stringMatching(/listed formats/)]));
  expect(checkJournalExport(figure, "tiff", 80, 40, 300)).toContainEqual(expect.stringMatching(/600 dpi/));
  expect(checkJournalExport(figure, "tiff", 80, 40, 600)).toEqual([]);
  expect(checkJournalExport(figure, "eps", 80, 40)).toContainEqual(expect.stringMatching(/not implemented/));
  expect(journalPreflightMessages(styled, "pdf", { widthMm: 80, heightMm: 40, scaleX: 0.5, scaleY: 0.5 })).toContainEqual(expect.stringMatching(/font size/));
});
it("strictly validates journal dialog actions and private preview receipts", () => {
  const envelope = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-1", dialogKind: "journalPresets", sessionId: "session-1", requestId: "request-1", snapshotRevision: 1 };
  expect(parseDialogMessage({ ...envelope, type: "snapshot", data: { title: "Drawing", selectionCount: 1 } })).toBeDefined();
  expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "apply", journal: request() } })).toBeDefined();
  expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "apply", journal: { ...request(), scope: "all-files" } } })).toBeUndefined();
  expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "export", options: {} } })).toBeUndefined();
  expect(parseDialogMessage({ ...envelope, type: "result", data: { status: "preview", preview: { url: "https://untrusted.example/image", kind: "image", width: 1, height: 1, warnings: [] } } })).toBeUndefined();
});
