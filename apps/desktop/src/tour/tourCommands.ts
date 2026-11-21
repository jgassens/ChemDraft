import { KEYBOARD_PREFERENCES_COMMAND_ID } from "../commands";
import { NAME_TO_STRUCTURE_COMMAND_ID } from "../plugins/officialPluginMenus";
import type { KeybindingScheme } from "../keybindingSettings";

export const SHOW_TOUR_COMMAND = "help.showTour";
export const TOUR_SAMPLE_COMMAND = "help.tour.openSample";
export const TOUR_NAME_COMMAND = NAME_TO_STRUCTURE_COMMAND_ID;
export const TOUR_INSPECTOR_COMMAND = "analyze.molecularProperties";

export const TOUR_TITLE = "Take the Tour";

export type TourTryCommand = typeof TOUR_SAMPLE_COMMAND | typeof TOUR_NAME_COMMAND | typeof TOUR_INSPECTOR_COMMAND | typeof KEYBOARD_PREFERENCES_COMMAND_ID;

export type TourAction =
  | { action: "cancel" | "finish" }
  | { action: "chooseShortcuts"; scheme: KeybindingScheme }
  | { action: "tryTourCommand"; command: TourTryCommand };
