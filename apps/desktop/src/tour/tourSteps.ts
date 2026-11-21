import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { createQuickActions, numericAtomDrawingHotkeys, KEYBOARD_PREFERENCES_COMMAND_ID, PREFERENCES_COMMAND_ID, viewActions } from "../commands";
import { chemDrawHoveredTargetHotkeyCommand } from "../keybindingScheme";
import { KEYBINDING_SCHEME_LABELS, type KeybindingScheme } from "../keybindingSettings";
import { createMainWindowShortcutCommands, detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { formatShortcutLabel, getToolsetCommandSpecs } from "../toolsets";
import { TOUR_INSPECTOR_COMMAND, TOUR_NAME_COMMAND, TOUR_SAMPLE_COMMAND, type TourTryCommand } from "./tourCommands";

const shortcutExamples = [
  ["tool.bond", "Single Bond"],
  ["tool.chain", "Chain"],
  ["view.toggleRulers", "Rulers"],
  ["edit.undo", "Undo"],
  ["document.save", "Save"]
] as const;

export function tourShortcutChoices(platform: ShortcutPlatform = detectDesktopShortcutPlatform()) {
  const state = {
    quickActions: createQuickActions(createEmptyDocument(), undefined),
    layerActions: [],
    toolCommandSpecs: getToolsetCommandSpecs()
  };
  return (Object.keys(KEYBINDING_SCHEME_LABELS) as KeybindingScheme[]).map(scheme => {
    const commands = createMainWindowShortcutCommands(state, scheme);
    return {
      scheme,
      label: KEYBINDING_SCHEME_LABELS[scheme],
      examples: shortcutExamples.flatMap(([id, label]) => {
        const spec = commands.find(command => command.id === id);
        const key = formatShortcutLabel(spec?.shortcut || spec?.defaultShortcut, platform);
        return key ? [{ label, key }] : [];
      })
    };
  });
}

interface TourStep {
  title: string;
  text: string;
  shortcuts?: true;
  tryCommand?: TourTryCommand;
}

export function tourSteps(
  scheme: KeybindingScheme,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform()
): readonly TourStep[] {
  const bondKey = Object.keys(numericAtomDrawingHotkeys).find(key => (
    scheme === "chemdraw" ? chemDrawHoveredTargetHotkeyCommand("atom", key) : numericAtomDrawingHotkeys[key]
  ) === "atom.addSingleBondToHoveredAtom");
  const preferences = formatShortcutLabel(viewActions.find(command => command.id === PREFERENCES_COMMAND_ID)?.shortcut, platform);
  return [
    {
      title: "Welcome to ChemDraft",
      text: "ChemDraft is a free, open-source chemical drawing app for Mac and Windows. Open Help > Take the Tour to revisit these steps."
    },
    {
      title: "Choose your shortcuts",
      text: "If you’ve used other drawing programs, try Classic desktop-compatible shortcuts. ChemDraft opens CDX and CDXML files. You can change any assignable shortcut in Preferences > Keyboard.",
      shortcuts: true,
      tryCommand: KEYBOARD_PREFERENCES_COMMAND_ID
    },
    {
      title: "Draw a structure",
      text: `Click and drag with the bond tool, or pick a ring from Ring Templates on the toolbar. Hover over an atom and type a label or press ${bondKey} to add a single bond.`,
      tryCommand: TOUR_SAMPLE_COMMAND
    },
    {
      title: "Names and structure search",
      text: "The Name to Structure plugin draws from a chemical name through the Structure menu. Use Tools to search PubChem or Reaxys by the selected structure.",
      tryCommand: TOUR_NAME_COMMAND
    },
    {
      title: "Analysis and 3D",
      text: "Open the Molecular Inspector to see properties for the selected molecule. Use Spin 3D to explore its shape.",
      tryCommand: TOUR_INSPECTOR_COMMAND
    },
    {
      title: "Save, export, and copy",
      text: "Save your drawing as a ChemDraft file or export to SVG, PDF, PNG, CDXML, CDX, MOL, or SDF. Copy structures into Office documents."
    },
    {
      title: "Make it yours",
      text: `Open Preferences in the ${platform === "macos" ? "ChemDraft" : "File"} menu (${preferences}). Use View > Customize Main Toolbar to arrange your tools, and the Plugins menu to add features.`
    }
  ];
}
