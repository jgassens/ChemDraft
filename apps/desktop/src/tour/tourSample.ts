import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { insertStructureTemplate } from "../structureTemplateInsertion";

export function buildTourSample(document: ChemDraftDocument) {
  const page = document.pages[0];
  return insertStructureTemplate(document, "12-crown-4", { x: page.width / 2, y: page.height / 2 });
}
