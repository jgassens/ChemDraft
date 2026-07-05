import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildAppMenuModel,
  flattenAppMenuCommands,
  formatMenuShortcut,
  nativeRoutedCommandIds,
  type AppMenuContext
} from "./appMenu";

const EMPTY_CONTEXT: AppMenuContext = {
  rulersVisible: true,
  crosshairsVisible: true,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasSelectedMolecule: false,
  toolbars: []
};

/**
 * Parse the authoritative routed-command list (`MENU_COMMAND_IDS`) out of the Rust source. Entries
 * are either string literals or `SCREAMING_CASE` constant references, which we resolve to their
 * `const IDENT: &str = "…"` values. This is what keeps the web menu and native menu in lock-step.
 */
function parseNativeMenuCommandIds(): string[] {
  const libPath = fileURLToPath(new URL("../src-tauri/src/lib.rs", import.meta.url));
  const source = readFileSync(libPath, "utf8");

  const block = source.match(/const MENU_COMMAND_IDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  if (!block) {
    throw new Error("Could not find MENU_COMMAND_IDS in lib.rs");
  }
  const body = block[1];

  const ids = new Set<string>();
  for (const match of body.matchAll(/"([^"]+)"/g)) {
    ids.add(match[1]);
  }
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)) {
    const constMatch = source.match(new RegExp(`const ${match[1]}:\\s*&str\\s*=\\s*"([^"]+)"`));
    if (!constMatch) {
      throw new Error(`Could not resolve MENU_COMMAND_IDS constant ${match[1]}`);
    }
    ids.add(constMatch[1]);
  }
  return [...ids];
}

describe("app menu model", () => {
  it("stays in sync with the native menu's routed command ids (lib.rs MENU_COMMAND_IDS)", () => {
    const nativeIds = parseNativeMenuCommandIds();
    const webIds = nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT));

    // Sanity: the parse actually found the native list (guards against a silent regex miss).
    expect(nativeIds.length).toBeGreaterThan(20);
    expect([...webIds].sort()).toEqual([...nativeIds].sort());
  });

  it("exposes the OS-predefined edit commands as web commands but excludes them from the native set", () => {
    const commands = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT));
    const predefined = commands.filter((command) => command.nativePredefined).map((command) => command.commandId);
    expect(predefined).toEqual(["edit.undo", "edit.redo", "clipboard.cut", "clipboard.copy", "clipboard.paste"]);

    const routed = nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT));
    expect(routed).not.toContain("edit.undo");
    expect(routed).not.toContain("clipboard.paste");
  });

  it("reflects toggle state on checkable items", () => {
    const model = buildAppMenuModel({ ...EMPTY_CONTEXT, rulersVisible: false, crosshairsVisible: true });
    const commands = flattenAppMenuCommands(model);
    expect(commands.find((command) => command.commandId === "view.toggleRulers")?.checked).toBe(false);
    expect(commands.find((command) => command.commandId === "view.toggleCrosshairs")?.checked).toBe(true);
  });

  it("disables selection-dependent items until there is a selection", () => {
    const empty = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT));
    expect(empty.find((command) => command.commandId === "clipboard.copy")?.enabled).toBe(false);
    expect(empty.find((command) => command.commandId === "chemistry.validateSelection")?.enabled).toBe(false);
    expect(empty.find((command) => command.commandId === "edit.undo")?.enabled).toBe(false);

    const active = flattenAppMenuCommands(
      buildAppMenuModel({ ...EMPTY_CONTEXT, hasSelection: true, hasSelectedMolecule: true, canUndo: true })
    );
    expect(active.find((command) => command.commandId === "clipboard.copy")?.enabled).toBe(true);
    expect(active.find((command) => command.commandId === "chemistry.validateSelection")?.enabled).toBe(true);
    expect(active.find((command) => command.commandId === "edit.undo")?.enabled).toBe(true);
  });

  it("mirrors the dynamic View ▸ Toolbars submenu from context", () => {
    const model = buildAppMenuModel({
      ...EMPTY_CONTEXT,
      toolbars: [
        { id: "tb1", commandId: "view.toolset.toggle.core.main", title: "Main Toolbar", checked: true },
        { id: "tb2", commandId: "view.toolset.toggle.core.art", title: "Art Toolbar", checked: false }
      ]
    });
    const view = model.find((section) => section.id === "view");
    const toolbars = view?.items.find((item) => item.kind === "submenu" && item.id === "view.toolbars");
    expect(toolbars?.kind).toBe("submenu");
    if (toolbars?.kind === "submenu") {
      expect(toolbars.items.map((item) => (item.kind === "command" ? item.commandId : item.kind))).toEqual([
        "view.toolset.toggle.core.main",
        "view.toolset.toggle.core.art"
      ]);
    }

    // Dynamic toggles must not leak into the native-parity set.
    expect(nativeRoutedCommandIds(model)).not.toContain("view.toolset.toggle.core.main");
  });

  it("formats accelerators as mac glyphs", () => {
    expect(formatMenuShortcut("Cmd+N")).toBe("⌘N");
    expect(formatMenuShortcut("Shift+Cmd+S")).toBe("⇧⌘S");
    expect(formatMenuShortcut("Cmd+,")).toBe("⌘,");
    expect(formatMenuShortcut(undefined)).toBeUndefined();
  });

  it("presents the expected top-level sections", () => {
    expect(buildAppMenuModel(EMPTY_CONTEXT).map((section) => section.label)).toEqual([
      "File",
      "Edit",
      "View",
      "Structure",
      "Analyze"
    ]);
  });
});
