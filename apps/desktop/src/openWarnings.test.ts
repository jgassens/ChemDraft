import { readFileSync } from "node:fs";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { describe, expect, it } from "vitest";
import { allShellCommands, createOpenWarningsAction } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import {
  activeOpenWarnings,
  describeOpenWarningTarget,
  fileWarningReports,
  fileWarningsTooltip,
  NO_OPEN_WARNINGS_REASON,
  openWarningsHeading,
  TOGGLE_OPEN_WARNINGS_COMMAND_ID,
  warningCountLabel,
  type OpenWarning
} from "./openWarnings";
import { SHELL_COMMAND_IDS } from "./shellCommandIds";

function openFixture(name: string) {
  const opened = openChemDraftPayload(readFileSync(`packages/fixtures/cdxml/${name}`, "utf8"));
  if (!opened.document) {
    throw new Error(`Expected ${name} to open.`);
  }
  return { document: opened.document, warnings: opened.warnings };
}

function onlyMolecule(document: ChemDraftDocument): MoleculeObject {
  const molecules = document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
  expect(molecules).toHaveLength(1);
  return molecules[0];
}

function withoutObject(document: ChemDraftDocument, objectId: string): ChemDraftDocument {
  return { ...document, pages: document.pages.map((page) => ({ ...page, objects: page.objects.filter((object) => object.id !== objectId) })) };
}

function replaceMolecule(document: ChemDraftDocument, molecule: MoleculeObject): ChemDraftDocument {
  return { ...document, pages: document.pages.map((page) => ({ ...page, objects: page.objects.map((object) => (object.id === molecule.id ? molecule : object)) })) };
}

describe("open warnings model", () => {
  it("counts warnings in words, never \"1 warnings\"", () => {
    expect(warningCountLabel(1)).toBe("1 warning");
    expect(warningCountLabel(2)).toBe("2 warnings");
    expect(warningCountLabel(11)).toBe("11 warnings");
    const report = { displayName: "a.cdxml", sourceLabel: "external CDXML subset", warnings: [{ code: "x", message: "y" }] };
    expect(openWarningsHeading(report)).toBe("Opened a.cdxml as external CDXML subset: 1 warning");
    expect(openWarningsHeading({ ...report, warnings: [...report.warnings, ...report.warnings] })).toBe("Opened a.cdxml as external CDXML subset: 2 warnings");
  });

  it("offers a report only when it has warnings", () => {
    const report = { displayName: "a.cdxml", sourceLabel: "external CDXML subset", warnings: [] };
    expect(activeOpenWarnings(undefined)).toBeUndefined();
    expect(activeOpenWarnings(report)).toBeUndefined();
    const warned = { ...report, warnings: [{ code: "x", message: "y" }] };
    expect(activeOpenWarnings(warned)).toBe(warned);
  });

  it("labels save reports distinctly while keeping older open reports compatible", () => {
    const report = {
      operation: "save" as const,
      displayName: "table.chemdraft",
      sourceLabel: "ChemDraft CDXML envelope",
      warnings: [{ code: "cdxml.table_approximated", message: "Table written as text and lines." }]
    };
    expect(activeOpenWarnings(report)).toBe(report);
    expect(openWarningsHeading(report)).toBe("Saved table.chemdraft: 1 warning");
    expect(openWarningsHeading({ ...report, warnings: [...report.warnings, ...report.warnings] }))
      .toBe("Saved table.chemdraft: 2 warnings");
    expect(activeOpenWarnings({ ...report, warnings: [] })).toBeUndefined();
  });

  it("combines independent reports in open/save order and labels their tooltip messages", () => {
    const open = Object.freeze({
      displayName: "import.cdxml", sourceLabel: "external CDXML subset",
      warnings: Object.freeze([{ code: "open", message: "Imported a supported subset." }])
    });
    const save = Object.freeze({
      operation: "save" as const, displayName: "table.chemdraft", sourceLabel: "ChemDraft CDXML envelope",
      warnings: Object.freeze([{ code: "save", message: "Table written as text and lines." }])
    });
    const reports = fileWarningReports(open, save);
    expect(reports).toEqual([open, save]);
    expect(reports[0]).toBe(open);
    expect(reports[1]).toBe(save);
    expect(fileWarningsTooltip(reports)).toBe(
      "Opened import.cdxml as external CDXML subset: 1 warning\nImported a supported subset.\n\n" +
      "Saved table.chemdraft: 1 warning\nTable written as text and lines."
    );
    expect(fileWarningReports(open, undefined)).toEqual([open]);
    expect(fileWarningReports(open, { ...save, warnings: [] })).toEqual([open]);
    expect(fileWarningReports(undefined, save)).toEqual([save]);
    expect(fileWarningsTooltip(fileWarningReports(undefined, undefined))).toBeUndefined();
  });

  it("names the atom an unknown Element became, and selects it", () => {
    const { document, warnings } = openFixture("invalid-element.cdxml");
    const molecule = onlyMolecule(document);
    const unknown = warnings.find((warning) => warning.code === "cdxml.atom_element_unknown");
    expect(unknown).toBeDefined();
    const star = molecule.atoms.find((atom) => atom.element === "*");
    expect(star).toBeDefined();

    const target = describeOpenWarningTarget(document, unknown!);
    expect(target).toEqual({
      label: `Atom * in Molecule (CDXML fragment ${molecule.compatibility?.originalId})`,
      selection: { objectId: molecule.id, atomIds: [star!.id], bondIds: [] },
      missing: false
    });
  });

  it("names a whole molecule, or the whole file, when a warning names no atom", () => {
    const { document, warnings } = openFixture("ten-metals.cdxml");
    const fileLevel = warnings.find((warning) => warning.code === "cdxml.external_subset_imported");
    expect(describeOpenWarningTarget(document, fileLevel!)).toEqual({ label: "Whole file", missing: false });

    const perMolecule = warnings.filter((warning) => warning.code === "cdxml.structure_string_not_derived");
    expect(perMolecule).toHaveLength(10);
    for (const warning of perMolecule) {
      const target = describeOpenWarningTarget(document, warning);
      expect(target.missing).toBe(false);
      expect(target.label).toMatch(/^Molecule \(CDXML fragment [^)]+\)$/);
      expect(target.selection).toEqual({ objectId: warning.sourceObjectId, atomIds: [], bondIds: [] });
    }
  });

  it("says when what a warning named has been deleted, and offers nothing to select", () => {
    const { document, warnings } = openFixture("invalid-element.cdxml");
    const molecule = onlyMolecule(document);
    const unknown = warnings.find((warning) => warning.code === "cdxml.atom_element_unknown")!;

    expect(describeOpenWarningTarget(withoutObject(document, molecule.id), unknown)).toEqual({
      label: "An object no longer in the document",
      missing: true
    });

    const starId = unknown.atomIds![0];
    const withoutStar = replaceMolecule(document, {
      ...molecule,
      atoms: molecule.atoms.filter((atom) => atom.id !== starId),
      bonds: molecule.bonds.filter((bond) => bond.fromAtomId !== starId && bond.toAtomId !== starId)
    });
    expect(describeOpenWarningTarget(withoutStar, unknown)).toEqual({
      label: `1 atom no longer in Molecule (CDXML fragment ${molecule.compatibility?.originalId})`,
      missing: true
    });
  });

  it("counts several named bonds and keeps only those still there", () => {
    const { document } = openFixture("invalid-element.cdxml");
    const molecule = onlyMolecule(document);
    const warning: OpenWarning = {
      code: "cdxml.dashed_single_read_as_dative",
      message: "2 dashed single bonds were read as dative",
      sourceObjectId: molecule.id,
      bondIds: [...molecule.bonds.map((bond) => bond.id), "bond_gone"]
    };
    expect(describeOpenWarningTarget(document, warning)).toEqual({
      label: `${molecule.bonds.length} bonds in Molecule (CDXML fragment ${molecule.compatibility?.originalId})`,
      selection: { objectId: molecule.id, atomIds: [], bondIds: molecule.bonds.map((bond) => bond.id) },
      missing: false
    });
  });

  it("is a view command, disabled with a reason when the document has no warnings", () => {
    expect(createOpenWarningsAction()).toMatchObject({
      id: TOGGLE_OPEN_WARNINGS_COMMAND_ID,
      title: "Show Open Warnings",
      category: "view",
      source: "core",
      disabledReason: NO_OPEN_WARNINGS_REASON
    });
    expect(createOpenWarningsAction({ hasOpenWarnings: true }).disabledReason).toBeUndefined();

    // The shell catalogue feeds the menus, shortcuts and the Customize gallery.
    const document = createPhase4Document();
    expect(allShellCommands(document).find((command) => command.id === TOGGLE_OPEN_WARNINGS_COMMAND_ID)?.disabledReason).toBe(NO_OPEN_WARNINGS_REASON);
    expect(allShellCommands(document, undefined, { availability: { hasOpenWarnings: true } })
      .find((command) => command.id === TOGGLE_OPEN_WARNINGS_COMMAND_ID)?.disabledReason).toBeUndefined();
    expect(SHELL_COMMAND_IDS.has(TOGGLE_OPEN_WARNINGS_COMMAND_ID)).toBe(true);
  });
});
