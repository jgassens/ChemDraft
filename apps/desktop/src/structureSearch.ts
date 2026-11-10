// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: selected-fragment searches through shared commands, per-site consent and native browser opening.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import { copyAsScopeMolecules, copyAsSmiles, createSelectionClipboardPayload, type NativeMoleculeFragmentSelection } from "./documentWorkflow";
import type { NativePromptOptions } from "./nativePrompt";

export type StructureSearchSite = "pubchem" | "reaxys";
export const STRUCTURE_SEARCH_SITES = ["pubchem", "reaxys"] as const;
export const STRUCTURE_SEARCH_SELECTION_REASON = "Select a structure to search.";

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

/** No whole-page fallback: extract exactly the selected objects and atom/bond fragments. */
export function structureSearchDocument(
  document: ChemDraftDocument, fragments: readonly NativeMoleculeFragmentSelection[] = []
): ChemDraftDocument | undefined {
  const payload = createSelectionClipboardPayload(document, fragments);
  const molecules = payload?.objects.filter(object => object.type === "molecule");
  if (!molecules?.length) return undefined;
  const page = document.pages[0]!;
  const scoped = {
    ...document, pages: [{ ...page, objects: molecules }],
    selection: { ...document.selection, pageId: page.id, objectIds: molecules.map(object => object.id) }
  };
  return copyAsScopeMolecules(scoped).length ? scoped : undefined;
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
      const serializableIds = new Set(copyAsScopeMolecules(document).map(molecule => molecule.id));
      const omitted = document.pages.flatMap(page => page.objects).filter(object =>
        object.type === "molecule" && !serializableIds.has(object.id));
      if (omitted.length) {
        throw new Error(`Part of the selection cannot be searched: structures without editable native graphs (${omitted.map(object => object.id).join(", ")}). Select only drawn structures.`);
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
