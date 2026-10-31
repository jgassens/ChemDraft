import { structureTemplates, structureTemplateById } from "@chemdraft/template-library";
import type { CommandSpec } from "./commands";

export function templateInsertCommandId(id: string): string {
  if (!structureTemplateById(id)) throw new Error(`Unknown structure template: ${id}`);
  return `template.insert.${id}`;
}

export const templateDialogAction: CommandSpec = {
  id: "template.insertDialog", title: "Templates…", icon: "templates", source: "core", category: "insert"
};
export const templateInsertActions: CommandSpec[] = structureTemplates.map(template => ({
  id: templateInsertCommandId(template.id), title: `Insert ${template.name}`, icon: "templates", source: "core", category: "insert"
}));
