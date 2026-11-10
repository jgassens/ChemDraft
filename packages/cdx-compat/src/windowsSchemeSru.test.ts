import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { BracketObject, ChemDraftDocument } from "@chemdraft/chem-core";
import { documentReactionSummary } from "@chemdraft/document-workflow-core";
import { exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";

const fixture = readFileSync(new URL("../../fixtures/cdxml/scheme-and-sru.cdxml", import.meta.url), "utf8");

function expectSru(document: ChemDraftDocument) {
  const objects = document.pages[0].objects;
  const brackets = objects.filter((object): object is BracketObject => object.type === "bracket");
  expect(brackets).toHaveLength(2);
  expect(brackets.every(bracket => bracket.bracketKind === "square" && bracket.bracketUsage === "sru")).toBe(true);
  expect(brackets.filter(bracket => bracket.label === "n")).toHaveLength(1);
  for (const bracket of brackets) expect(bracket.crossingBondIds).toHaveLength(1);
  expect(objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
}

it.each([false, true])("preserves a scheme and SRU through CDX (native payload: %s)", embedNativePayload => {
  const imported = openChemDraftPayload(fixture);
  expect(imported.document).toBeDefined();
  expectSru(imported.document!);

  const exported = exportDocumentToCdx(imported.document!, { embedNativePayload });
  const reopened = importCdx(exported.bytes);
  expect(reopened.document).toBeDefined();
  expectSru(reopened.document!);
  expect(reopened.warnings.some(warning => warning.code === "cdxml.bracket_group_preserved")).toBe(false);
  if (!embedNativePayload) {
    const steps = documentReactionSummary(reopened.document!);
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step.arrowObjectIds).toHaveLength(1);
  }
});
