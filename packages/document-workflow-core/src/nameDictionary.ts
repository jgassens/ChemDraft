// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: injected lazy loading and OPSIN-first resolution with provenance.

import { nameKey } from "./nameDictionaryKey.mjs";

export const nameDictionaryUrl = new URL("../../../data/names/dictionary.tsv.gz", import.meta.url);

export interface DictionaryMatch {
  smiles: string;
  matchedName?: string;
  matchedCas?: string;
}

const casPattern = /^(?:CAS(?:\s*(?:RN|No\.?|number|registry number))?\s*[:#]?\s*)?\[?(\d{2,7})-(\d{2})-(\d)\]?$/i;

/** Parse once on first fallback; concurrent callers share loading. A failed load may be retried. */
export function createNameDictionary(loadText: () => Promise<string>) {
  let loading: Promise<{ names: Map<string, DictionaryMatch>; cas: Map<string, DictionaryMatch> }> | undefined;
  return async (query: string): Promise<DictionaryMatch | undefined> => {
    const text = query.trim();
    if (!text || text.length > 200) return undefined;
    loading ??= (async () => {
      const names = new Map<string, DictionaryMatch>();
      const identities = new Map<string, string>();
      const ambiguous = new Set<string>();
      const cas = new Map<string, DictionaryMatch>();
      const lines = (await loadText()).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i % 2000 === 1999) await new Promise<void>(resolve => setTimeout(resolve, 0));
        const [smiles, nameList, casList, inchiKey, opsinNames] = lines[i]!.split("\t");
        if (!smiles || smiles.length > 4000) continue;
        // Column 5 contains exact source names that upstream used only for suggestions
        // because its OPSIN already read them. They are valid on our parse-miss path too.
        for (const raw of [...(nameList?.split("|") ?? []), ...(opsinNames?.split("|") ?? [])]) {
          const matchedName = raw.replace(/^!/, "");
          const key = nameKey(matchedName);
          if (!key || ambiguous.has(key)) continue;
          const identity = inchiKey || smiles;
          if (identities.has(key) && identities.get(key) !== identity) {
            names.delete(key);
            ambiguous.add(key);
          } else if (!names.has(key)) {
            identities.set(key, identity);
            names.set(key, { smiles, matchedName });
          }
        }
        for (const matchedCas of casList?.split("|") ?? []) {
          if (matchedCas && !cas.has(matchedCas)) cas.set(matchedCas, { smiles, matchedCas });
        }
      }
      return { names, cas };
    })().catch(error => { loading = undefined; throw error; });
    const index = await loading;
    const parts = casPattern.exec(text);
    if (parts) {
      const checksum = [...parts[1]! + parts[2]!].reverse()
        .reduce((sum, digit, i) => sum + Number(digit) * (i + 1), 0) % 10;
      return checksum === Number(parts[3])
        ? index.cas.get(`${Number(parts[1])}-${parts[2]}-${parts[3]}`) : undefined;
    }
    return index.names.get(nameKey(text));
  };
}

export interface NameParseResult {
  smiles?: string | null;
  failureReason?: string | null;
  warnings?: readonly string[];
}

/** Engine failures propagate. Only an actual parse miss consults the offline dictionary. */
export async function resolveChemicalName(
  query: string,
  opsin: (query: string) => Promise<NameParseResult>,
  dictionary: (query: string) => Promise<DictionaryMatch | undefined>
) {
  const result = await opsin(query);
  if (result.smiles) return { ...result, source: "opsin" as const };
  const match = await dictionary(query);
  if (match) return { ...match, source: "dictionary" as const, warnings: [] as readonly string[], failureReason: undefined };
  return { ...result, source: "opsin" as const,
    failureReason: `OPSIN and the offline Wikidata dictionary could not interpret chemical name "${query}": ${result.failureReason ?? "no matching entry"}` };
}
