// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: selected-fragment searches through shared commands, per-site consent and native browser opening.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { bracketPairs, type BracketObject, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { repeatUnitExportWarnings, repeatUnits } from "@chemdraft/export-engine";
import type { CommandSpec } from "./commands";
import { copyAsScopeMolecules, copyAsSmiles, createSelectionClipboardPayload, type NativeMoleculeFragmentSelection } from "./documentWorkflow";
import type { NativePromptOptions } from "./nativePrompt";

export type StructureSearchSite = "pubchem" | "reaxys";
export const STRUCTURE_SEARCH_SITES = ["pubchem", "reaxys"] as const;
export const STRUCTURE_SEARCH_SELECTION_REASON = "Select a structure to search.";

// Search scopes contain only molecules; retain the original brackets' semantics separately.
const searchBracketUsages = new WeakMap<ChemDraftDocument, Set<string>>();

export class StructureSearchRefusal extends Error {
  override name = "StructureSearchRefusal";
}

export function structureSearchErrorStatus(error: unknown): string {
  if (error instanceof StructureSearchRefusal) return error.message;
  return `Structure search failed: ${error instanceof Error ? error.message : String(error)}`;
}

export function structureSearchSite(commandId: string): StructureSearchSite | undefined {
  return STRUCTURE_SEARCH_SITES.find(site => commandId === `search.${site}`);
}

export function structureSearchCommands(enabled: boolean, searchable: boolean): CommandSpec[] {
  if (!isTauri()) return [];
  return STRUCTURE_SEARCH_SITES.map(site => ({
    id: `search.${site}`, title: `Search ${site === "pubchem" ? "PubChem" : "Reaxys"} (opens browser)`,
    icon: "export", source: "core", category: "tools", enabled: enabled && searchable,
    disabledReason: !enabled ? "Online structure search is off in Preferences." :
      !searchable ? STRUCTURE_SEARCH_SELECTION_REASON : undefined
  }));
}

function bracketCrossingsTouchMolecule(bracket: BracketObject, molecule: MoleculeObject, original?: MoleculeObject): boolean {
  const atomIds = new Set(molecule.atoms.map(atom => atom.id));
  const bondIds = new Set(molecule.bonds.map(bond => bond.id));
  const touches = (objectId: unknown, bondId: unknown, innerAtomId?: unknown) => {
    if (objectId !== molecule.id) return false;
    if (typeof innerAtomId === "string" && atomIds.has(innerAtomId)) return true;
    if (typeof bondId !== "string") return false;
    if (bondIds.has(bondId)) return true;
    // An atom-only selection omits its incident crossing bond from the scoped graph.
    const bond = original?.bonds.find(bond => bond.id === bondId);
    return !!bond && (atomIds.has(bond.fromAtomId) || atomIds.has(bond.toAtomId));
  };
  if (bracket.crossingBondIds?.some(ref => touches(ref.objectId, ref.bondId))) return true;
  const crossings = bracket.compatibility?.unknown.cdxmlBracketCrossings;
  return Array.isArray(crossings) && crossings.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("ref" in entry)) return false;
    const ref = entry.ref;
    if (typeof ref !== "object" || ref === null || !("objectId" in ref)) return false;
    return touches(ref.objectId, "bondId" in ref ? ref.bondId : undefined,
      "innerAtomId" in entry ? entry.innerAtomId : undefined);
  });
}

/** No whole-page fallback: extract exactly the selected objects and atom/bond fragments. */
export function structureSearchDocument(
  document: ChemDraftDocument, fragments: readonly NativeMoleculeFragmentSelection[] = []
): ChemDraftDocument | undefined {
  // A click also highlights the host object; explicit fragments take precedence for search.
  const fragmentHostIds = new Set(fragments.map(fragment => fragment.objectId));
  const payload = createSelectionClipboardPayload({ ...document, selection: {
    ...document.selection, objectIds: document.selection.objectIds.filter(id => !fragmentHostIds.has(id))
  } }, fragments);
  const molecules = payload?.objects.filter(object => object.type === "molecule");
  if (!molecules?.length) return undefined;
  // Read membership and crossing references before discarding the original graph and brackets.
  // A crossing still carries bracket semantics when imported members cannot resolve.
  const units = repeatUnits(document);
  const pairsByBracketId = new Map<string, BracketObject[]>();
  document.pages.forEach(page => bracketPairs(page.objects).forEach(pair =>
    pair.forEach(bracket => pairsByBracketId.set(bracket.id, pair))));
  const originalMolecules = new Map(document.pages.flatMap(page => page.objects.flatMap(object =>
    object.type === "molecule" ? [[object.id, object] as const] : [])));
  const bracketUsages = new Set<string>();
  const repeatWarnings = repeatUnitExportWarnings(document, "SMILES");
  const searchMolecules = molecules.map(molecule => {
    const atomIds = new Set(molecule.atoms.map(atom => atom.id));
    const selectedUnits = units.filter(unit => unit.members.some(member =>
      member.molecule.id === molecule.id &&
      member.atomIds.some(id => atomIds.has(id))
    ) || pairsByBracketId.get(unit.objectId)?.some(bracket =>
      bracketCrossingsTouchMolecule(bracket, molecule, originalMolecules.get(molecule.id))
    ));
    selectedUnits.forEach(unit => bracketUsages.add(unit.usage));
    const bracketIds = new Set(selectedUnits.map(unit => unit.objectId));
    const warnings = repeatWarnings.filter(warning => warning.objectId !== undefined && bracketIds.has(warning.objectId))
      .map(warning => ({ code: "chemistry.bracket_multiplier", objectId: molecule.id, message: warning.message }));
    return warnings.length ? { ...molecule, chemistry: {
      isotopeLabels: [], stereochemistry: [], ...molecule.chemistry,
      warnings: [...warnings, ...(molecule.chemistry?.warnings ?? []).filter(existing =>
        !warnings.some(warning => warning.message === existing.message)
      )]
    } } : molecule;
  });
  const page = document.pages[0]!;
  const scoped = {
    ...document, pages: [{ ...page, objects: searchMolecules }],
    selection: { ...document.selection, pageId: page.id, objectIds: molecules.map(object => object.id) }
  };
  if (!copyAsScopeMolecules(scoped).length) return undefined;
  searchBracketUsages.set(scoped, bracketUsages);
  return scoped;
}

export function stripSearchCxSmiles(smiles: string): string {
  return smiles.split(/\s/, 1)[0] ?? "";
}

export function structureSearchNotice(site: StructureSearchSite): NativePromptOptions {
  const name = site === "pubchem" ? "PubChem" : "Reaxys";
  return {
    title: `Search ${name}`, owner: "document", kind: "warning",
    message: `Search sends the selected structure to ${name} in a web address. It will appear in your browser's history and any browser sync. Continue?`,
    choices: [{ id: "continue", label: "Continue" }, { id: "cancel", label: "Cancel", cancel: true }]
  };
}

interface SearchDependencies {
  enabled: () => boolean;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
  serialize?: typeof copyAsSmiles;
  prompt?: (options: NativePromptOptions) => Promise<string>;
  open?: (site: StructureSearchSite, smiles: string) => Promise<void>;
}

/** One controller per document window; busy covers engine loading and the consent prompt too. */
export function createStructureSearchController(deps: SearchDependencies) {
  const accepted = new Set<StructureSearchSite>();
  let busy = false;
  let nextAllowed = -Infinity;
  const now = deps.now ?? (() => performance.now());
  const storage = () => deps.storage ?? globalThis.localStorage;
  return async (site: StructureSearchSite, document: ChemDraftDocument | undefined): Promise<boolean | undefined> => {
    if (!deps.enabled()) throw new Error("Online structure search is off in Preferences.");
    if (!document) throw new Error(STRUCTURE_SEARCH_SELECTION_REASON);
    if (busy || now() < nextAllowed) return;
    busy = true;
    try {
      const molecules = copyAsScopeMolecules(document);
      const serializableIds = new Set(molecules.map(molecule => molecule.id));
      const omitted = document.pages.flatMap(page => page.objects).filter(object =>
        object.type === "molecule" && !serializableIds.has(object.id));
      if (omitted.length) {
        throw new Error(`Part of the selection cannot be searched: structures without editable native graphs (${omitted.map(object => object.id).join(", ")}). Select only drawn structures.`);
      }
      // The scoped document carries bracket membership on its selected atoms.
      // Refuse before serialization: copy/export diagnostics may contain bracket ids
      // and repeated context, which should not become the search status message.
      if (molecules.some(molecule => molecule.chemistry?.warnings.some(
        warning => warning.code === "chemistry.bracket_multiplier"
      ))) {
        const usages = searchBracketUsages.get(document) ?? new Set(repeatUnits(document, molecules).map(unit => unit.usage));
        const description = usages.has("sru") ? "a polymer repeat unit" : usages.has("multiple")
          ? "a repeated (multiple) bracket group" : "bracketed structure";
        throw new StructureSearchRefusal(`Search can't include ${description}. Select atoms outside the brackets.`);
      }
      const warnings: string[] = [];
      const result = await (deps.serialize ?? copyAsSmiles)(document, warnings);
      // A lossy clipboard fallback is unsuitable for a structure search: refuse its warnings.
      if (warnings.length) throw new Error(`Structure search refused: ${warnings.join(" ")}`);
      const smiles = stripSearchCxSmiles(result ?? "");
      if (!smiles) throw new Error(STRUCTURE_SEARCH_SELECTION_REASON);
      const key = `chemdraft.structure-search.consent.${site}.v1`;
      try { if (storage()?.getItem(key) === "true") accepted.add(site); } catch { /* Session consent still works. */ }
      if (!accepted.has(site)) {
        const answer = await (deps.prompt ?? (async options => {
          const { nativePrompt } = await import("./nativePrompt");
          return nativePrompt(options, async () => "cancel");
        }))(structureSearchNotice(site));
        if (answer !== "continue") return;
        accepted.add(site);
        try { storage()?.setItem(key, "true"); } catch { /* Remember for this session. */ }
      }
      if (!deps.enabled()) throw new Error("Online structure search is off in Preferences.");
      // Reserve the interval before opening so a held command cannot queue extra browser tabs.
      nextAllowed = now() + 1000;
      await (deps.open ?? ((searchSite, searchSmiles) =>
        invoke<void>("open_structure_search", { site: searchSite, smiles: searchSmiles })))(site, smiles);
      return true;
    } finally { busy = false; }
  };
}
