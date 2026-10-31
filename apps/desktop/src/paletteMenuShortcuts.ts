import type { ShortcutRegistry } from "@chemdraft/shortcut-engine";

/** Native app menu routes, mirrored from lib.rs MENU_COMMAND_IDS by a parity test.
 * Close Window is absent: its native action closes the palette, not the document tab. */
export const NATIVE_MENU_COMMAND_IDS: ReadonlySet<string> = new Set([
  "template.insertDialog",
  "edit.undo",
  "edit.redo",
  "edit.selectAll",
  "clipboard.copyAs.smiles",
  "clipboard.copyAs.inchi",
  "clipboard.copyAs.inchiKey",
  "clipboard.copyAs.cdxml",
  "clipboard.copyAs.mol",
  "clipboard.copyAs.molV2000",
  "clipboard.copyAs.svg",
  "clipboard.copyAs.png",
  "document.new",
  "document.open",
  "document.save",
  "document.saveAs",
  "export.open",
  "page.setSize.letter",
  "page.setSize.legal",
  "page.setSize.a4",
  "page.setSize.a3",
  "page.setSize.a2",
  "page.setSize.a1",
  "page.setSize.a0",
  "page.setSize.a5",
  "page.setSizeCustom",
  "page.setOrientation.portrait",
  "page.setOrientation.landscape",
  "view.toggleRulers",
  "view.toggleCrosshairs",
  "view.customizeToolbars",
  "view.customizeMainToolbar",
  "layout.group",
  "layout.ungroup",
  "view.toggle3dDebugger",
  "view.togglePreferences",
  "structure.cleanup2d",
  "text.convertToAtomLabel",
  "analyze.molecularProperties",
  "chemistry.validateSelection",
  "structure.openInteractive3d",
  "plugins.manage",
  "help.reportBug",
]);

/** Resolve app actions through the palette's actual bindings, bypassing only the registry's
 * text-target filter. Editing, clipboard and drawing commands never use this route. */
export function paletteMenuShortcut(event: KeyboardEvent, registry: ShortcutRegistry): string | undefined {
  if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey || event.altKey)) return;
  const command = registry.resolve({
    key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
    altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat
  });
  return command && /^(document|export|view|app)\./.test(command) ? command : undefined;
}
