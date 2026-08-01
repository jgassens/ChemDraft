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
  "tool.retroArrow": "tool.art.retroArrow"
};

/** The id a renamed command now goes by, or the id itself when it was never renamed. */
export function canonicalCommandId(id: string): string {
  return RENAMED_COMMAND_IDS[id] ?? id;
}

/** True when `id` is a retired alias that {@link canonicalCommandId} redirects somewhere else. */
export function isRenamedCommandId(id: string): boolean {
  return RENAMED_COMMAND_IDS[id] !== undefined;
}

export function renamedCommandId(id: unknown): string | undefined {
  return typeof id === "string" ? RENAMED_COMMAND_IDS[id] : undefined;
}
