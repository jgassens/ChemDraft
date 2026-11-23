import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { createQuickActions, numericAtomDrawingHotkeys, KEYBOARD_PREFERENCES_COMMAND_ID, PREFERENCES_COMMAND_ID, viewActions } from "../commands";
import { chemDrawHoveredTargetHotkeyCommand, createHoverShortcutTables } from "../keybindingScheme";
import { KEYBINDING_SCHEME_LABELS, type KeybindingScheme, type KeybindingSettings } from "../keybindingSettings";
import { createMainWindowShortcutCommands, detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { PLUGINS_MENU_LABELS, preferencesMenuPlacement } from "../appMenu";
import { formatShortcutLabel, getToolsetCommandSpecs } from "../toolsets";
import { PLUGIN_AUTHORING_GUIDE_URL, TOUR_INSPECTOR_COMMAND, TOUR_NAME_COMMAND, TOUR_SAMPLE_COMMAND, type TourPluginCommand, type TourTryCommand } from "./tourCommands";

export { PLUGIN_AUTHORING_GUIDE_URL } from "./tourCommands";

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

const SINGLE_BOND_HOVER_COMMAND = "atom.addSingleBondToHoveredAtom";

function defaultTourBondKey(scheme: KeybindingScheme): string | undefined {
  return Object.keys(numericAtomDrawingHotkeys).find(key => (
    scheme === "chemdraw" ? chemDrawHoveredTargetHotkeyCommand("atom", key) : numericAtomDrawingHotkeys[key]
  ) === SINGLE_BOND_HOVER_COMMAND);
}

/** Per scheme, the hover key the canvas uses for Add Single Bond to Hovered Atom, or null when the
 *  user cleared it in Preferences > Keyboard. Every scheme is listed, so choosing another scheme in
 *  the tour shows that scheme's key. */
export type TourBondKeys = Partial<Record<KeybindingScheme, string | null>>;

export function tourBondKeys(overrides?: KeybindingSettings["overrides"]): TourBondKeys {
  return Object.fromEntries((Object.keys(KEYBINDING_SCHEME_LABELS) as KeybindingScheme[]).map(scheme => {
    // The same table the canvas reads (createHoverShortcutTables), so the tour never names a dead key.
    const keys = [...createHoverShortcutTables(scheme, overrides?.[scheme]).atom]
      .filter(([, id]) => id === SINGLE_BOND_HOVER_COMMAND).map(([key]) => key);
    const preferred = defaultTourBondKey(scheme);
    return [scheme, preferred && keys.includes(preferred) ? preferred : keys[0] ?? null] as const;
  }));
}

interface TourStep {
  title: string;
  text: string;
  shortcuts?: true;
  tryCommand?: TourTryCommand;
  /** The web address of a link shown under the step's text. It opens in the system browser. */
  url?: typeof PLUGIN_AUTHORING_GUIDE_URL;
  /** The card that explains plugins. It comes before every step that shows a plugin feature. */
  introducesPlugins?: true;
  /** The plugin this step shows, whether as its Try it or in its text (installed or offered as optional). */
  plugin?: TourPluginCommand;
}

/**
 * The tour's steps. `plugins` lists the plugin commands the menus offer (`availableTourPluginCommands`);
 * a step that demonstrates a plugin appears only when its command is listed, and otherwise is reworded
 * to name the plugin as optional, with no Try it. Callers take the list once, when the tour opens.
 * The plugins card comes before every step that shows a plugin (`plugin`, or a plugin Try it), so the
 * tour explains plugins before it demonstrates one.
 */
export function tourSteps(
  scheme: KeybindingScheme,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  plugins: readonly TourPluginCommand[] = [],
  /** The effective hover key (`tourBondKeys`): null names no key; undefined uses the scheme default. */
  singleBondKey?: string | null
): readonly TourStep[] {
  const bondKey = singleBondKey === undefined ? defaultTourBondKey(scheme) : singleBondKey;
  const preferencesShortcut = formatShortcutLabel(viewActions.find(command => command.id === PREFERENCES_COMMAND_ID)?.shortcut, platform);
  const preferences = preferencesMenuPlacement(platform);
  const menu = PLUGINS_MENU_LABELS;
  return [
    {
      title: "Welcome to ChemDraft",
      text: "ChemDraft is a free, open-source chemical drawing app for Mac, Windows and Linux. Open Help > Take the Tour to revisit these steps."
    },
    {
      title: "Choose your shortcuts",
      text: "If you’ve used other drawing programs, try Classic desktop-compatible shortcuts. Your choice applies right away. ChemDraft opens CDX and CDXML files. You can change any assignable shortcut in Preferences > Keyboard.",
      shortcuts: true,
      tryCommand: KEYBOARD_PREFERENCES_COMMAND_ID
    },
    {
      title: "Draw a structure",
      text: `Click and drag with the bond tool, or pick a ring from Ring Templates on the toolbar. Hover over an atom and type a label${bondKey ? ` or press ${bondKey} to add a single bond` : ""}.`,
      tryCommand: TOUR_SAMPLE_COMMAND
    },
    {
      title: "Keep an eye on the status bar",
      text: "The status bar in the lower-left corner of the drawing window keeps you posted as you work. It shows tips for the tool you’re using and for keys that change what a drag does, and it tells you what you’ve selected."
    },
    {
      title: "Add features with plugins",
      text: `ChemDraft does more through plugins. Official plugins add NMR prediction, structure recognition from images, and chemical naming. To get them, choose ${menu.menu} > ${menu.manager} and install one from the catalog of official plugins. Beyond the official ones, you can vibe code your own: choose ${menu.menu} > ${menu.vibeCode} for step-by-step help. The plugin authoring guide is at:`,
      url: PLUGIN_AUTHORING_GUIDE_URL,
      introducesPlugins: true
    },
    plugins.includes(TOUR_NAME_COMMAND) ? {
      title: "Names and structure search",
      text: "The Name to Structure plugin draws from a chemical name through the Structure menu. Use Tools to search PubChem or Reaxys by the selected structure.",
      tryCommand: TOUR_NAME_COMMAND,
      plugin: TOUR_NAME_COMMAND
    } : {
      title: "Structure search",
      text: `Use Tools to search PubChem or Reaxys by the selected structure. Optional plugin: add Name to Structure from ${menu.menu} > ${menu.manager} to draw a structure from a chemical name.`,
      plugin: TOUR_NAME_COMMAND
    },
    {
      title: "Analysis and 3D",
      text: "Open the Molecular Inspector to see properties for the selected molecule. Use Spin 3D to explore its shape.",
      tryCommand: TOUR_INSPECTOR_COMMAND
    },
    {
      title: "Save, export, and copy",
      text: "Save your drawing as a ChemDraft file or export to SVG, PDF, PNG, CDXML, CDX, or SDF. Copy structures into Office documents. To copy a molfile, use Edit > Copy As > MOL Text."
    },
    {
      title: "Make it yours",
      text: `Choose ${preferences.menu} > ${preferences.label} (${preferencesShortcut}) to open Preferences. Use View > Customize Main Toolbar to arrange your tools, and the Plugins menu to add features.`
    }
  ];
}
