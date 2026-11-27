/**
 * Build-time toolbar profiles, selected by `CHEMDRAFT_TOOLBAR_PROFILE` (vite.config.ts `define`).
 * Kept free of app imports so vite.config.ts can validate the name and fail the build on a typo.
 */
export const TOOLBAR_PROFILE_NAMES = ["molecule-drawing"] as const;

export type ToolbarProfileName = (typeof TOOLBAR_PROFILE_NAMES)[number];

/** `undefined` for an unset or empty value (today's toolbars); throws on a name no profile has. */
export function parseToolbarProfileName(value: string | undefined): ToolbarProfileName | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if ((TOOLBAR_PROFILE_NAMES as readonly string[]).includes(name)) return name as ToolbarProfileName;
  throw new Error(
    `Unknown CHEMDRAFT_TOOLBAR_PROFILE "${name}". Known profiles: ${TOOLBAR_PROFILE_NAMES.join(", ")}; leave it unset for the standard toolbars.`
  );
}
