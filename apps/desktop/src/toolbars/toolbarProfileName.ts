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

/**
 * The profile for this Vite run. A toolbar profile is for the browser build alone (`dev:web:game` /
 * `build:web:game`): inside a Tauri build (`tauri dev` / `tauri build` set `TAURI_ENV_*` for their
 * before-commands) any non-empty value is refused, so an inherited variable can never ship the game
 * toolbars in the desktop app. `scripts/desktop-tauri.mjs` refuses it earlier, before anything builds;
 * this catches `tauri` invoked any other way.
 */
export function toolbarProfileForBuild(value: string | undefined, tauriBuild: boolean): ToolbarProfileName | undefined {
  if (tauriBuild && value !== undefined && value.trim() !== "") {
    throw new Error(
      `CHEMDRAFT_TOOLBAR_PROFILE="${value}" is set inside a Tauri build. Toolbar profiles are for the browser build only ` +
        "(pnpm --filter @chemdraft/desktop build:web:game). Unset it to build or run the desktop app."
    );
  }
  return parseToolbarProfileName(value);
}
