/**
 * Command ids this app has renamed, old → new.
 *
 * One definition, because three separate consumers have to agree on it:
 *
 *  - Persisted layout state is id-based, so without a remap a user's saved hides and reordering
 *    silently stop applying after an upgrade (and the stale ids are then pruned as unknown, making
 *    the loss permanent on the next save) — see `migrateRenamedCommandIdsInLayoutState`.
 *  - Tool activation, so a legacy id still routed from a menu, shortcut, or older persisted state
 *    activates the tool that replaced it rather than the retired implementation behind it.
 *  - The Customize gallery, so a renamed id is not offered as a second tile beside its replacement.
 *
 * The semantic arrow buttons moved into the art-arrow family when they gained real art geometry.
 * The legacy ids used to build the retired `reaction-arrow` object type, which has none of the
 * current editing mechanics (Shift transform box, marker commands, default-style capture).
 *
 * This is a leaf module on purpose: `drawingTools` and the gallery must be able to read the map
 * without pulling in the toolsets manifest.
 */
export const RENAMED_COMMAND_IDS: Readonly<Record<string, string>> = {
  "tool.reactionArrow": "tool.art.reactionArrow",
  "tool.resonanceArrow": "tool.art.resonanceArrow",
  "tool.equilibriumArrow": "tool.art.equilibriumArrow",
  "tool.retroArrow": "tool.art.retroArrow",
  // The stamp-style curved/fishhook art arrows were replaced by real electron-pushing arrows
  // that anchor to atoms and charges (the art geometry stays for CDX-imported documents).
  "tool.art.curvedArrow90": "tool.mechanismArrow",
  "tool.art.curvedArrow180": "tool.mechanismArrow",
  "tool.art.fishhookArrow": "tool.mechanismFishhook",
  "tool.art.fishhookCurved": "tool.mechanismFishhook"
};

/**
 * Every lookup goes through `Object.hasOwn` first.
 *
 * A bracket read on an object literal resolves inherited members, so `RENAMED_COMMAND_IDS["toString"]`
 * returned a FUNCTION and `["__proto__"]` returned `Object.prototype` — both past the `?? id` and
 * `!== undefined` guards, and both typed as `string`. Persisted layout state is just ids from disk,
 * so a hidden-command entry of `__proto__` was rewritten to a non-string before schema validation,
 * and the gallery silently dropped any command named after an `Object.prototype` member.
 */
function renamedTarget(id: string): string | undefined {
  return Object.hasOwn(RENAMED_COMMAND_IDS, id) ? RENAMED_COMMAND_IDS[id] : undefined;
}

/** The id a renamed command now goes by, or the id itself when it was never renamed. */
export function canonicalCommandId(id: string): string {
  return renamedTarget(id) ?? id;
}

/** True when `id` is a retired alias that {@link canonicalCommandId} redirects somewhere else. */
export function isRenamedCommandId(id: string): boolean {
  return renamedTarget(id) !== undefined;
}

export function renamedCommandId(id: unknown): string | undefined {
  return typeof id === "string" ? renamedTarget(id) : undefined;
}
