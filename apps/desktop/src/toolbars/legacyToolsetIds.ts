/**
 * Renamed identifiers, and the map that keeps a saved layout working across the rename.
 *
 * Toolbar state persists by id — `toolbar-state.json` (position and visibility) and
 * `toolbar-layout-state.json` (customization) are both keyed by toolset id, and a customized layout
 * additionally names command and widget ids. Renaming "Molecule Inspector" to "Drawn Structure
 * Settings" therefore orphans every id a user's saved layout refers to, and the visible symptom is
 * their customized toolbar silently reverting to default.
 *
 * So the rename carries its own migration. This is a one-way map applied on load: old id in, new id
 * out, everything else untouched. It stays until it is safe to assume no saved state predates
 * 2026-07-31 — which, for a file on a user's disk, is longer than it feels.
 */

/** Old id → new id. Exhaustive for the 2026-07-31 Molecule Inspector → Drawn Structure Settings rename. */
export const LEGACY_TOOLSET_ID_MIGRATIONS: Readonly<Record<string, string>> = {
  "core.moleculeInspector": "core.drawnStructureSettings",
  "core.moleculeInspector.toggle": "core.drawnStructureSettings.toggle",
  "view.toggleMoleculeInspector": "view.toggleDrawnStructureSettings",
  "widget.core.moleculeInspector": "widget.core.drawnStructureSettings",
  "moleculeInspector.template.import": "drawnStructureSettings.template.import",
  "moleculeInspector.template.export": "drawnStructureSettings.template.export"
};

/** One id, migrated if it is a known legacy id and returned unchanged otherwise. */
export function migrateLegacyId(id: string): string {
  return LEGACY_TOOLSET_ID_MIGRATIONS[id] ?? id;
}

/**
 * Rewrite every legacy id anywhere in a loaded state tree — object keys included, because the
 * persisted shapes key *by* toolset id rather than storing it in a field.
 *
 * Structural rather than a string replace over the JSON text: a substring pass would also rewrite a
 * user's toolbar *name* if they happened to have typed one of these ids into it, and would corrupt any
 * value that merely contained the id as a prefix.
 */
export function migrateLegacyToolsetIds<T>(state: T): T {
  if (typeof state === "string") {
    return migrateLegacyId(state) as unknown as T;
  }
  if (Array.isArray(state)) {
    return state.map((entry) => migrateLegacyToolsetIds(entry)) as unknown as T;
  }
  if (state !== null && typeof state === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
      out[migrateLegacyId(key)] = migrateLegacyToolsetIds(value);
    }
    return out as unknown as T;
  }
  return state;
}
