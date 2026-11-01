import { structureTemplates, structureTemplateFamilyOrder, type StructureTemplate } from "@chemdraft/template-library";
import { normalizeStructureTemplateName } from "@chemdraft/document-workflow-core";

/** Substrings are for the picker only; exact chemical name resolution stays unchanged. */
export function filterStructureTemplates(query: string, templates: readonly StructureTemplate[] = structureTemplates) {
  const key = normalizeStructureTemplateName(query);
  return templates.filter(template => [template.name, ...template.synonyms]
    .some(name => normalizeStructureTemplateName(name).includes(key)));
}

export function structureTemplatePickerFamilies(query: string, ids: readonly string[]) {
  const matches = filterStructureTemplates(query).filter(template => ids.includes(template.id));
  return structureTemplateFamilyOrder.flatMap(family => {
    const templates = matches.filter(template => template.family === family);
    // Pair each pillar[n]arene with its dimethoxy variant regardless of registry order.
    const pillars = templates.filter(template => /^(?:dimethoxy)?pillar-/.test(template.id));
    const ordered = pillars.length ? [...templates.filter(template => !pillars.includes(template)),
      ...pillars.sort((a, b) => Number(a.name.match(/\[(\d+)\]/)?.[1]) - Number(b.name.match(/\[(\d+)\]/)?.[1]) ||
        Number(a.name.startsWith("1,4")) - Number(b.name.startsWith("1,4")))] : templates;
    return ordered.length ? [{ family, templates: ordered }] : [];
  });
}
