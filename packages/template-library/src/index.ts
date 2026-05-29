export interface TemplateLibraryEntry {
  id: string;
  label: string;
  category: "ring" | "fragment" | "abbreviation" | "superatom" | "style-preset";
  license: "project-original";
}

export const builtInTemplateEntries: TemplateLibraryEntry[] = [];
