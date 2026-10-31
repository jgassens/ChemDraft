import { calixarenesPillararenesTemplates } from "./calixarenesPillararenes";
import { crownEthersCryptandsTemplates } from "./crownEthersCryptands";
import { cucurbiturilsTemplates } from "./cucurbiturils";
import { cyclodextrinsTemplates } from "./cyclodextrins";
import { cyclophanesTemplates } from "./cyclophanes";
import { fullerenesTemplates } from "./fullerenes";
import { porphyrinsTemplates } from "./porphyrins";
import type { StructureTemplate, StructureTemplateFamily } from "./types";

export type {
  StructureTemplate,
  StructureTemplateAtom,
  StructureTemplateBond,
  StructureTemplateFamily
} from "./types";

/** Picker order is also the registry's stable family order. */
export const structureTemplateFamilyOrder: readonly StructureTemplateFamily[] = [
  "crown-ethers-cryptands",
  "cyclodextrins",
  "cucurbiturils",
  "calixarenes-pillararenes",
  "cyclophanes",
  "porphyrins",
  "fullerenes"
];

export const structureTemplateFamilyNames: Readonly<Record<StructureTemplateFamily, string>> = {
  "crown-ethers-cryptands": "Crown ethers & cryptands",
  cyclodextrins: "Cyclodextrins",
  cucurbiturils: "Cucurbiturils",
  "calixarenes-pillararenes": "Calixarenes & pillararenes",
  cyclophanes: "Cyclophanes",
  porphyrins: "Porphyrins",
  fullerenes: "Fullerenes"
};

export const structureTemplates: readonly StructureTemplate[] = [
  ...crownEthersCryptandsTemplates,
  ...cyclodextrinsTemplates,
  ...cucurbiturilsTemplates,
  ...calixarenesPillararenesTemplates,
  ...cyclophanesTemplates,
  ...porphyrinsTemplates,
  ...fullerenesTemplates
];

const templatesById = new Map(structureTemplates.map((template) => [template.id, template]));

/** Exact stable-ID lookup; name matching is a separate concern. */
export function structureTemplateById(id: string): StructureTemplate | undefined {
  return templatesById.get(id);
}
