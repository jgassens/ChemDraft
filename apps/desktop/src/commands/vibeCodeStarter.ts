import type { CommandSpec } from "../commands";
import type { VibeCodeStarterSaveOptions } from "../plugins/vibeCodeStarter";

export const VIBE_CODE_STARTER_COMMAND_ID = "plugins.vibeCodeStarter";

export const VIBE_CODE_SAVE_COMMAND_ID = "plugins.saveVibeCodeStarter";

export const vibeCodeStarterCommand: CommandSpec = {
  id: VIBE_CODE_STARTER_COMMAND_ID,
  title: "Vibe Code Your Own Plugin…",
  icon: "plugin",
  source: "core",
  category: "plugins",
  description: "Save instructions for a coding agent to build your own ChemDraft plugin"
};

export function registerVibeCodeStarter(
  register: (spec: CommandSpec, handler: () => Promise<void>) => void,
  options: VibeCodeStarterSaveOptions,
  setStatus: (message: string) => void,
  openGuide: () => void | Promise<void>
): void {
  register(vibeCodeStarterCommand, async () => { await openGuide(); });
  register({ ...vibeCodeStarterCommand, id: VIBE_CODE_SAVE_COMMAND_ID, title: "Save Starter File…" }, async () => {
    try {
      const { saveVibeCodeStarter } = await import("../plugins/vibeCodeStarter");
      const filename = await saveVibeCodeStarter(options);
      if (filename) setStatus(`Saved plugin starter to ${filename}`);
    } catch (error) {
      setStatus(`Could not save plugin starter: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
