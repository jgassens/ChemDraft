import type { CommandSpec } from "../commands";
import type { VibeCodeStarterSaveOptions } from "../plugins/vibeCodeStarter";

export const VIBE_CODE_STARTER_COMMAND_ID = "plugins.vibeCodeStarter";

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
  onError: (message: string) => void
): void {
  register(vibeCodeStarterCommand, async () => {
    try {
      const { saveVibeCodeStarter } = await import("../plugins/vibeCodeStarter");
      await saveVibeCodeStarter(options);
    } catch (error) {
      onError(`Could not save plugin starter: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
