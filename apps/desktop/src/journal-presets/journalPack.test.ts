import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyJournalStyle, journalRulePixels } from "@chemdraft/document-workflow-core";
import { applyPatches, serializeDocument } from "@chemdraft/chem-core";
import { applyNativeChainTool, createPhase4Document, createNativeSavePayload, openNativeDocument } from "../documentWorkflow";
import identities from "../../../../examples/plugins/journal-style-pack/data/journals.json";
import formatting from "../../../../examples/plugins/journal-style-pack/data/profiles.json";
import { checkJournalExport } from "./preflight";
import { ensureJournalProfile, isJournalPackLoaded, journals, loadJournalStylePack, profiles, searchJournals, validateJournalCatalog } from "./catalog";

const pack = validateJournalCatalog(identities, formatting);
describe("optional journal data pack", () => {
  it("contains fifteen sourced additional identities and no unverified entries", () => {
    expect(pack.journals).toHaveLength(15);
    expect(pack.profiles.filter(p => p.status === "partial")).toHaveLength(15);
    expect(pack.profiles.filter(p => p.status === "unverified")).toHaveLength(0);
    expect(pack.journals.find(j => j.id === "cell")?.publisher).toBe("Cell Press");
    expect(pack.journals.some(j => j.id === "applied-catalysis-b")).toBe(false);
    for (const journal of pack.journals) expect(journal.identitySource).toMatch(/^https:\/\/api.crossref.org\/journals\//);
  });
  it("rejects duplicate identities, orphan profiles and malformed identity data before mutation", () => {
    expect(() => validateJournalCatalog([...identities, identities[0]], formatting)).toThrow();
    expect(() => validateJournalCatalog(identities.slice(1), formatting)).toThrow();
    expect(() => validateJournalCatalog([{ ...identities[0], issns: ["guessed"] }], [formatting[0]])).toThrow();
    expect(journals).toHaveLength(5);
  });
  it("retains unknowns, withholds conflicting TOC option and distinguishes recommendations", () => {
    const angew = pack.profiles.find(p => p.id === "angewandte-chemie")!;
    expect(angew.figures.some(f => f.maxWidthMm === 110 || f.maxWidthMm === 115)).toBe(false);
    expect(angew.rules.fontSize).toBeUndefined();
    expect(angew.limitations.join(" ")).toContain("conflict");
    const wiley = pack.profiles.find(p => p.id === "advanced-materials")!;
    expect(wiley.rules.bondSpacing).toBeUndefined();
    expect(wiley.rules.bondLength?.value).toBe(17);
    expect(wiley.figures[1].minDpi?.["line-art"]).toBe(1200);
    expect(pack.profiles.find(p => p.id === "chemical-reviews")?.figures.find(f => f.id === "toc")?.maxWidthMm).toBe(50);
    expect(pack.profiles.find(p => p.id === "molecules")?.rules).toEqual({});
  });
  it.each(pack.profiles)("preserves chemistry, coordinates and offline saved settings for $id; blocks unverified", profile => {
    const source = applyNativeChainTool(createPhase4Document("Pack test"), { x: 100, y: 100 }, { x: 200, y: 130 });
    const before = serializeDocument(source);
    const request = { profileId: profile.id, figureType: profile.figures[0].id, scope: "document" as const, resizeBonds: false };
    if (profile.status === "unverified") {
      expect(profile.rules).toEqual({});
      expect(() => applyJournalStyle(source, profile, request)).toThrow(/not been verified/i);
    } else {
      const next = applyJournalStyle(source, profile, request);
      const molecule = next.pages[0].objects.find(o => o.type === "molecule")!;
      const original = source.pages[0].objects.find(o => o.type === "molecule")!;
      if (molecule.type !== "molecule" || original.type !== "molecule") throw Error("fixture");
      expect(molecule.atoms).toEqual(original.atoms); expect(molecule.bonds).toEqual(original.bonds);
      expect(molecule.chemistry).toEqual(original.chemistry);
      const reopened = openNativeDocument(createNativeSavePayload(next).contents).document;
      if (!reopened) throw Error("Native reopen failed");
      const reopenedMolecule = reopened.pages[0].objects.find(o => o.id === molecule.id);
      if (reopenedMolecule?.type !== "molecule") throw Error("Native molecule missing");
      expect(reopenedMolecule.style.journalPreset).toEqual(molecule.style.journalPreset);
    }
    expect(serializeDocument(source)).toBe(before);
  });
  it("applies Cell's physical chemical settings and validates article-layout widths", () => {
    const cell = pack.profiles.find(p => p.id === "cell")!;
    expect(cell.status).toBe("partial"); expect(cell.version).toBe("1.0.1");
    expect(cell.rules.fontSize?.value).toBe(7);
    expect(journalRulePixels(cell.rules.bondLength!)).toBeCloseTo(0.45 * 96 / 2.54);
    expect(journalRulePixels(cell.rules.lineWidth!)).toBeCloseTo(0.015 * 96 / 2.54);
    expect(cell.rules.bondSpacing?.value).toBe(20);
    expect(cell.figures.map(f => f.maxWidthMm)).toEqual([85, 114, 174, 55, 114, 174]);
    expect(checkJournalExport(cell.figures[0], "pdf", 86, 50).join(" ")).toContain("exceeds 85.0");
    expect(checkJournalExport(cell.figures[0], "tiff", 85, 50, 300).join(" ")).toContain("1000 dpi");
    expect(cell.limitations.join(" ")).toContain("0.056 cm");
    expect(cell.figures.some(f => f.id.includes("abstract"))).toBe(false);
  });
  it("keeps Cell chemistry intact during explicit resizing, including charged isotope and wedge metadata", () => {
    const cell = pack.profiles.find(p => p.id === "cell")!;
    let source = applyNativeChainTool(createPhase4Document("Cell fixture"), { x: 100, y: 100 }, { x: 200, y: 130 });
    const original = source.pages[0].objects.find(o => o.type === "molecule")!;
    if (original.type !== "molecule") throw Error("fixture");
    source = applyPatches(source, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: original.atoms.map((a, i) => i ? a : { ...a, element: "N", formalCharge: 1 }),
      bonds: original.bonds.map((b, i) => i ? b : { ...b, display: { ...b.display, bondStyle: "wedge" } }),
      chemistry: { ...original.chemistry, warnings: original.chemistry?.warnings ?? [], isotopeLabels: ["15N"], stereochemistry: ["R"], radicalCount: 1 }
    } }]);
    const before = source.pages[0].objects.find(o => o.type === "molecule")!;
    const next = applyJournalStyle(source, cell, { profileId: "cell", figureType: "research-single", scope: "document", resizeBonds: true });
    const after = next.pages[0].objects.find(o => o.type === "molecule")!;
    if (before.type !== "molecule" || after.type !== "molecule") throw Error("fixture");
    expect(after.atoms.map(({ x, y, ...a }) => a)).toEqual(before.atoms.map(({ x, y, ...a }) => a));
    expect(after.bonds).toEqual(before.bonds); expect(after.chemistry).toEqual(before.chemistry);
    expect(after.atoms).not.toEqual(before.atoms);
    expect(after.style.atomLabelFontSizePx).toBeCloseTo(7 * 96 / 72);
    expect(after.style.bondSpacingPercent).toBe(20);
  });
  it("refuses an unverified profile even if it is supplied outside the approved catalog", () => {
    const profile = pack.profiles.find(p => p.id === "cell")!;
    const source = applyNativeChainTool(createPhase4Document("Unverified input"), { x: 100, y: 100 }, { x: 200, y: 130 });
    expect(() => applyJournalStyle(source, { ...profile, status: "unverified" }, { profileId: "cell", figureType: "research-single", scope: "document", resizeBonds: false })).toThrow("not been verified");
  });
  it("allowlists every catalog source in the restricted native opener", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
    const sourceCheck = rust.slice(rust.indexOf("fn journal_source_allowed"), rust.indexOf("/// User-clicked source links"));
    for (const journal of pack.journals) expect(sourceCheck).toContain(JSON.stringify(journal.guidelinesUrl));
    for (const profile of pack.profiles) for (const rule of Object.values(profile.rules)) expect(sourceCheck).toContain(JSON.stringify(rule!.sourceUrl));
  });
  it("loads local data once in each host, supports owner loading and searches old titles and ISSNs", async () => {
    expect(isJournalPackLoaded()).toBe(false);
    await Promise.all([ensureJournalProfile({ profileId: "advanced-materials", figureType: "structure-vector", scope: "document", resizeBonds: false }), loadJournalStylePack()]);
    await loadJournalStylePack();
    expect(isJournalPackLoaded()).toBe(true); expect(journals).toHaveLength(20); expect(profiles).toHaveLength(20);
    expect(searchJournals("Applied Catalysis B: Environmental")).toHaveLength(0);
    expect(searchJournals("15214095")[0].id).toBe("advanced-materials");
  });
});
