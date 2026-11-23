import { KEYBOARD_PREFERENCES_COMMAND_ID } from "../commands";
import { NAME_TO_STRUCTURE_COMMAND_ID } from "../plugins/officialPluginMenus";
import type { PluginAppMenuItem } from "../appMenu";
import type { KeybindingScheme } from "../keybindingSettings";

export const SHOW_TOUR_COMMAND = "help.showTour";
export const TOUR_SAMPLE_COMMAND = "help.tour.openSample";
export const TOUR_NAME_COMMAND = NAME_TO_STRUCTURE_COMMAND_ID;
export const TOUR_INSPECTOR_COMMAND = "analyze.molecularProperties";

export const TOUR_TITLE = "Take the Tour";

/** Where to learn to write a plugin, linked from the plugins card. The native tour window opens only
 *  this exact address, in the system browser (`GUIDED_TOUR_GUIDE_URL` in `src-tauri/src/dialog_windows.rs`
 *  must stay equal to it; a test compares them). */
export const PLUGIN_AUTHORING_GUIDE_URL = "https://github.com/jgassens/ChemDraft/blob/main/docs/plugin-architecture/AUTHORING.md";

export type TourTryCommand = typeof TOUR_SAMPLE_COMMAND | typeof TOUR_NAME_COMMAND | typeof TOUR_INSPECTOR_COMMAND | typeof KEYBOARD_PREFERENCES_COMMAND_ID;

/** Every plugin command a tour step teaches. Each one comes from an official plugin that may not be
 *  installed: `plugin.opsinNameToStructure.convert` is Name to Structure (`org.chemdraft.opsin.nameToStructure`). */
export const TOUR_PLUGIN_COMMANDS = [TOUR_NAME_COMMAND] as const;
export type TourPluginCommand = typeof TOUR_PLUGIN_COMMANDS[number];

/**
 * The tour's plugin commands that the menus offer right now. This reads the menu items themselves
 * (`usePluginRuntime().pluginMenuItems`), so a step is shown exactly when its menu item is: the
 * official items exist only for a registered, enabled plugin command (`buildOfficialPluginMenuItems`),
 * and contributed items carry the registry's enabled state.
 */
export function availableTourPluginCommands(menuItems: readonly PluginAppMenuItem[]): TourPluginCommand[] {
  return TOUR_PLUGIN_COMMANDS.filter(id => menuItems.some(item => item.command.commandId === id && item.command.enabled));
}

export type TourAction =
  | { action: "cancel" | "finish" }
  | { action: "chooseShortcuts"; scheme: KeybindingScheme }
  | { action: "tryTourCommand"; command: TourTryCommand }
  /** Open the plugin authoring guide in the system browser. The native host handles this itself and
   *  never relays it to the document window. */
  | { action: "openGuide"; url: typeof PLUGIN_AUTHORING_GUIDE_URL };
