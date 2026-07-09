/**
 * Declarative model for the in-viewport application menu bar.
 *
 * On the Tauri desktop build the File/Edit/View/… menus live in the native OS menu
 * (`apps/desktop/src-tauri/src/lib.rs`, `create_app_menu_for_toolsets`). The browser build has no
 * native menu, so `MenuBar.tsx` renders this model inside the viewport and dispatches each item
 * through the SAME frontend command registry the native menu routes to (`invokeCommandRef`).
 *
 * This file is the single source of truth for the web menu's structure. It intentionally mirrors
 * the native menu's routed commands one-for-one; `appMenu.test.ts` reads `MENU_COMMAND_IDS` out of
 * `lib.rs` and fails if the two ever drift, so a command added to (or removed from) one side must
 * be reflected in the other.
 *
 * Deliberately omitted from the web bar (they are OS-level, not in-document actions): the macOS
 * application menu (About/Services/Hide/Quit), the Window menu (minimize/maximize), and File ▸
 * Close Window / Quit. The native Help menu is empty, so it is omitted too.
 */

/** A leaf item that invokes a registry command when clicked. */
export interface AppMenuCommand {
  kind: "command";
  /** Stable key/id for React + DOM. */
  id: string;
  /** Command id dispatched through the frontend command registry. */
  commandId: string;
  label: string;
  /** Pre-formatted keyboard hint (mac glyphs), e.g. "⇧⌘S". */
  shortcut?: string;
  enabled: boolean;
  /** When defined the item renders a checkmark slot reflecting current state. */
  checked?: boolean;
  /**
   * True when the native menu implements this via an OS `PredefinedMenuItem` (undo/redo/clipboard)
   * rather than a routed `MENU_COMMAND_IDS` entry. The web bar routes it to an explicit command id
   * instead, so the native-sync test excludes these from its `MENU_COMMAND_IDS` comparison.
   */
  nativePredefined?: boolean;
}

export interface AppMenuSubmenu {
  kind: "submenu";
  id: string;
  label: string;
  items: AppMenuItem[];
}

export interface AppMenuSeparator {
  kind: "separator";
  id: string;
}

export type AppMenuItem = AppMenuCommand | AppMenuSubmenu | AppMenuSeparator;

export interface AppMenuSection {
  id: string;
  label: string;
  items: AppMenuItem[];
}

/** A toolbar toggle entry for the View ▸ Toolbars submenu (mirrors the native dynamic submenu). */
export interface AppMenuToolbarToggle {
  id: string;
  commandId: string;
  title: string;
  checked: boolean;
}

export interface AppMenuContext {
  rulersVisible: boolean;
  crosshairsVisible: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasSelectedMolecule: boolean;
  /** Dynamic View ▸ Toolbars entries, e.g. from `getToolbarsMenuModel(visibleToolsetIds, registry)`. */
  toolbars: readonly AppMenuToolbarToggle[];
}

/** Prefix of the dynamic toolset-toggle command ids (see toolset-registry `createToolsetToggleCommandId`). */
export const TOOLSET_TOGGLE_COMMAND_PREFIX = "view.toolset.toggle.";

/**
 * Format a canonical accelerator ("Shift+Cmd+S") as mac glyphs ("⇧⌘S"). Authoring order should
 * follow the mac convention (⌃⌥⇧⌘ then key). Kept pure (no `navigator`) so the model is
 * deterministic under SSR/tests; the app is mac-first, matching the native `CmdOrCtrl` accelerators.
 */
export function formatMenuShortcut(accelerator: string | undefined): string | undefined {
  if (!accelerator) {
    return undefined;
  }
  return accelerator
    .replace(/Cmd|Command|Mod|Meta/gi, "⌘")
    .replace(/Shift/gi, "⇧")
    .replace(/Alt|Option/gi, "⌥")
    .replace(/Ctrl|Control/gi, "⌃")
    .replace(/\s*\+\s*/g, "");
}

function command(
  commandId: string,
  label: string,
  options: {
    accelerator?: string;
    enabled?: boolean;
    checked?: boolean;
    nativePredefined?: boolean;
    id?: string;
  } = {}
): AppMenuCommand {
  return {
    kind: "command",
    id: options.id ?? commandId,
    commandId,
    label,
    shortcut: formatMenuShortcut(options.accelerator),
    enabled: options.enabled ?? true,
    checked: options.checked,
    nativePredefined: options.nativePredefined
  };
}

let separatorSeq = 0;
function separator(): AppMenuSeparator {
  separatorSeq += 1;
  return { kind: "separator", id: `sep-${separatorSeq}` };
}

// Paper-size items mirror `create_page_setup_menu` in lib.rs (order matches MinimalPageSizePresetIds).
const PAPER_SIZE_ITEMS: readonly { presetId: string; label: string }[] = [
  { presetId: "letter", label: "US Letter" },
  { presetId: "legal", label: "US Legal" },
  { presetId: "a4", label: "A4" },
  { presetId: "a3", label: "A3" },
  { presetId: "a2", label: "A2" },
  { presetId: "a1", label: "A1" },
  { presetId: "a0", label: "A0" },
  { presetId: "a5", label: "A5" }
];

function buildPageSetupSubmenu(): AppMenuSubmenu {
  const paperSizeItems: AppMenuItem[] = [
    ...PAPER_SIZE_ITEMS.slice(0, 2).map((entry) => command(`page.setSize.${entry.presetId}`, entry.label)),
    separator(),
    ...PAPER_SIZE_ITEMS.slice(2).map((entry) => command(`page.setSize.${entry.presetId}`, entry.label)),
    separator(),
    command("page.setSizeCustom", "Custom Size…")
  ];

  return {
    kind: "submenu",
    id: "file.pageSetup",
    label: "Page Setup",
    items: [
      { kind: "submenu", id: "file.pageSetup.paperSize", label: "Paper Size", items: paperSizeItems },
      {
        kind: "submenu",
        id: "file.pageSetup.orientation",
        label: "Orientation",
        items: [
          command("page.setOrientation.portrait", "Portrait"),
          command("page.setOrientation.landscape", "Landscape")
        ]
      }
    ]
  };
}

/**
 * Build the full web menu model for the current app state. Pure and side-effect free so it can be
 * memoised in the component and asserted directly in tests.
 */
export function buildAppMenuModel(context: AppMenuContext): AppMenuSection[] {
  separatorSeq = 0;

  const toolbarsSubmenu: AppMenuSubmenu = {
    kind: "submenu",
    id: "view.toolbars",
    label: "Toolbars",
    items: context.toolbars.map((toggle) =>
      command(toggle.commandId, toggle.title, { checked: toggle.checked, id: toggle.id })
    )
  };

  return [
    {
      id: "file",
      label: "File",
      items: [
        command("document.new", "New", { accelerator: "Cmd+N" }),
        command("document.open", "Open…", { accelerator: "Cmd+O" }),
        command("document.save", "Save", { accelerator: "Cmd+S" }),
        command("document.saveAs", "Save As…", { accelerator: "Shift+Cmd+S" }),
        separator(),
        buildPageSetupSubmenu(),
        separator(),
        command("export.open", "Export…", { accelerator: "Shift+Cmd+E" })
      ]
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        command("edit.undo", "Undo", { accelerator: "Cmd+Z", enabled: context.canUndo, nativePredefined: true }),
        command("edit.redo", "Redo", { accelerator: "Shift+Cmd+Z", enabled: context.canRedo, nativePredefined: true }),
        separator(),
        command("clipboard.cut", "Cut", { accelerator: "Cmd+X", enabled: context.hasSelection, nativePredefined: true }),
        command("clipboard.copy", "Copy", { accelerator: "Cmd+C", enabled: context.hasSelection, nativePredefined: true }),
        command("clipboard.paste", "Paste", { accelerator: "Cmd+V", nativePredefined: true }),
        separator(),
        command("layout.group", "Group", { accelerator: "Cmd+G" }),
        command("layout.ungroup", "Ungroup", { accelerator: "Shift+Cmd+G" })
      ]
    },
    {
      id: "view",
      label: "View",
      items: [
        command("view.togglePreferences", "Preferences…", { accelerator: "Cmd+," }),
        separator(),
        command("view.toggleRulers", "Show Rulers", { accelerator: "Cmd+R", checked: context.rulersVisible }),
        command("view.toggleCrosshairs", "Show Crosshairs", {
          accelerator: "Shift+Cmd+R",
          checked: context.crosshairsVisible
        }),
        separator(),
        command("view.toggle3dDebugger", "3D Debugger"),
        separator(),
        toolbarsSubmenu,
        command("view.customizeToolbars", "Customize Toolbars…"),
        command("view.customizeMainToolbar", "Customize Main Toolbar…")
      ]
    },
    {
      id: "structure",
      label: "Structure",
      items: [
        command("structure.cleanup2d", "Clean up Structure 2D", { accelerator: "Shift+Cmd+K" }),
        separator(),
        command("structure.openInteractive3d", "Interactive 3D Workspace…")
      ]
    },
    {
      id: "analyze",
      label: "Analyze",
      items: [command("chemistry.validateSelection", "Validate Selected Structure", { enabled: context.hasSelectedMolecule })]
    }
  ];
}

/** Depth-first list of every command item in a menu model (skips submenus' own headers + separators). */
export function flattenAppMenuCommands(sections: readonly AppMenuSection[]): AppMenuCommand[] {
  const out: AppMenuCommand[] = [];
  const walk = (items: readonly AppMenuItem[]): void => {
    for (const item of items) {
      if (item.kind === "command") {
        out.push(item);
      } else if (item.kind === "submenu") {
        walk(item.items);
      }
    }
  };
  sections.forEach((section) => walk(section.items));
  return out;
}

/**
 * The command ids the web menu expects the native menu to route (`MENU_COMMAND_IDS` in lib.rs):
 * every command item except the OS-predefined ones and the dynamic toolset toggles. `appMenu.test.ts`
 * asserts this set equals the one parsed from `lib.rs`, catching drift in either direction.
 */
export function nativeRoutedCommandIds(sections: readonly AppMenuSection[]): string[] {
  return flattenAppMenuCommands(sections)
    .filter((item) => !item.nativePredefined && !item.commandId.startsWith(TOOLSET_TOGGLE_COMMAND_PREFIX))
    .map((item) => item.commandId);
}
