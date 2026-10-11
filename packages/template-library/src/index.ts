export interface TemplateLibraryEntry {
  id: string;
  label: string;
  category: "ring" | "fragment" | "abbreviation" | "superatom" | "style-preset";
  license: "project-original";
}

export const builtInTemplateEntries: TemplateLibraryEntry[] = [];

export {
  type AbbreviationAtom,
  type AbbreviationBond,
  type AbbreviationDefinition,
  abbreviationBondedSpellings,
  abbreviationDefinitions,
  abbreviationElementCounts,
  abbreviationForBondedElementLabel,
  abbreviationForLabel,
  abbreviationSpellings,
  abbreviationSpellingSuggestion
} from "./abbreviations";
export { bondedElementLabelMeaning, isBondedGenericAtomLabel, isGenericAtomLabel } from "./genericLabels";
