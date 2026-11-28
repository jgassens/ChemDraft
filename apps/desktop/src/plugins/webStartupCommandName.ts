/**
 * Build-time startup command for the browser build, selected by `CHEMDRAFT_WEB_STARTUP_COMMAND`
 * (vite.config.ts `define`). The game build (`dev:web:game` / `build:web:game`) sets it so the page opens
 * with a preloaded plugin's board already showing. Kept free of app imports so vite.config.ts can read
 * and refuse it before anything builds; `webStartupCommand.ts` decides at runtime whether it may run.
 */

export const WEB_STARTUP_COMMAND_ENV = "CHEMDRAFT_WEB_STARTUP_COMMAND";

/** `undefined` for an unset or blank value (no startup command: today's behaviour); otherwise trimmed. */
export function parseWebStartupCommand(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id ? id : undefined;
}

/**
 * The startup command for this Vite run. Browser build only: inside a Tauri build (`tauri dev` /
 * `tauri build` set `TAURI_ENV_*` for their before-commands) any non-empty value is refused, so an
 * inherited variable can never make the desktop app run a command on launch. `scripts/desktop-tauri.mjs`
 * refuses it earlier, before anything builds; this catches `tauri` invoked any other way.
 */
export function webStartupCommandForBuild(value: string | undefined, tauriBuild: boolean): string | undefined {
  if (tauriBuild && value !== undefined && value.trim() !== "") {
    throw new Error(
      `${WEB_STARTUP_COMMAND_ENV}="${value}" is set inside a Tauri build. A startup command is for the browser build only ` +
        "(pnpm --filter @chemdraft/desktop build:web:game). Unset it to build or run the desktop app."
    );
  }
  return parseWebStartupCommand(value);
}
