import { createToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { dispatchPaletteTooltipDismiss } from "./paletteTooltipDismissal";

/** Toolbars the in-place customize gallery supports, with the registered command that opens it.
 *  The gallery (ToolbarCustomizeController + GalleryTray) is wired for the Main toolbar only:
 *  MainWindow's customize flag, layout-edit listener and grid-row count are all Main's. */
const CUSTOMIZE_COMMAND_BY_TOOLSET: Readonly<Record<string, string>> = {
  "core.main": "view.customizeMainToolbar"
};

export function toolsetCustomizeCommandId(toolsetId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CUSTOMIZE_COMMAND_BY_TOOLSET, toolsetId)
    ? CUSTOMIZE_COMMAND_BY_TOOLSET[toolsetId]
    : undefined;
}

/** What the native toolbar menu can return. Rust (`popup_toolbar_context_menu`) builds the items,
 *  their labels and their order itself, for the toolset its window was created for: "Customize
 *  Toolbar…" on the Main toolbar and "Hide Toolbar" on every toolbar. The palette sends only its
 *  toolset id, so no toolbar, a plugin's included, can put its own text in a native menu. */
export type ToolbarMenuChoice = "customize" | "hide";

/** The registered command a toolbar-menu choice runs. Customize reuses the existing customize
 *  command, and Hide reuses the toolbar's View > Toolbars toggle (the toolbar is visible, since it
 *  was just right-clicked, so the toggle hides it). Anything else, or Customize on a toolbar the
 *  gallery does not customize, runs nothing. */
export function toolbarMenuChoiceCommandId(toolsetId: string, choice: unknown): string | undefined {
  if (choice === "customize") return toolsetCustomizeCommandId(toolsetId);
  if (choice === "hide") return createToolsetToggleCommandId(toolsetId);
  return undefined;
}

/** Asks the document window to present this toolbar's native menu at the pointer, and resolves to
 *  the chosen item, or null when it is dismissed (or, on Windows, not opened because another
 *  application is in front, so the palette's right-click never pulls ChemDraft forward). */
export async function popupNativeToolbarMenu(toolsetId: string): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<unknown>("popup_toolbar_context_menu", { toolsetId });
}

/** A right-button press, or on macOS a Control-click, which the system treats as a right-click. */
export function isSecondaryPress(event: Pick<MouseEvent, "button" | "ctrlKey">, platform: ShortcutPlatform): boolean {
  return event.button === 2 || (platform === "macos" && event.button === 0 && event.ctrlKey);
}

export interface ToolsetContextMenuOptions {
  platform: ShortcutPlatform;
  /** The toolbar whose menu this press opens, read when it is requested; undefined shows none (for
   *  example while the toolbar is in customize mode). The press is still kept from its button
   *  either way. */
  toolsetId: () => string | undefined;
  /** Runs the chosen registered command (the palette's normal command route). */
  onInvoke: (commandId: string) => void;
  /** The native popup; defaults to the document window's toolbar-menu command. */
  popup?: (toolsetId: string) => Promise<unknown>;
}

/**
 * Right-click (and macOS Control-click) anywhere in a palette window opens the toolbar's native menu,
 * and never reaches the button, grip or gap under the pointer. The listeners sit on the window in
 * the capture phase, ahead of React's root listeners, so a secondary press, its release and the click
 * that follows never run a command, start a press state, change the tool or start a window drag.
 * Primary presses pass through untouched.
 */
export function installToolsetContextMenu(target: Window, options: ToolsetContextMenuOptions): () => void {
  const popup = options.popup ?? popupNativeToolbarMenu;
  // Set by a secondary press; its release and click are swallowed until the next press.
  let suppressing = false;
  // One menu per gesture: macOS Control-click requests on the press and may also get a contextmenu.
  let inFlight = false;

  const block = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // The hover tooltip hides on a document-level press, which the blocked press never reaches; hide
  // it here so it does not sit over the native menu.
  const hideTooltip = () => dispatchPaletteTooltipDismiss(target);
  const request = () => {
    if (inFlight) return;
    const toolsetId = options.toolsetId();
    if (!toolsetId) return;
    inFlight = true;
    void popup(toolsetId)
      .then(choice => {
        const commandId = toolbarMenuChoiceCommandId(toolsetId, choice);
        if (commandId) options.onInvoke(commandId);
      })
      .catch(() => undefined)
      .finally(() => { inFlight = false; });
  };
  const press = (event: MouseEvent) => {
    suppressing = isSecondaryPress(event, options.platform);
    if (!suppressing) return;
    block(event);
    hideTooltip();
    // WebKit's Control-click is a primary-button press; open the menu from the press itself rather
    // than depend on a contextmenu event following it. A right-button press waits for contextmenu,
    // which each system sends at its own moment (press on macOS and Linux, release on Windows).
    if (event.button === 0) request();
  };
  const release = (event: MouseEvent) => {
    if (suppressing || event.button === 2) block(event);
  };
  const click = (event: MouseEvent) => {
    if (!suppressing && event.button !== 2) return;
    block(event);
    suppressing = false;
  };
  const contextMenu = (event: MouseEvent) => {
    block(event);
    hideTooltip();
    request();
  };

  const listeners: [string, (event: MouseEvent) => void][] = [
    ["pointerdown", press],
    ["mousedown", press],
    ["pointerup", release],
    ["mouseup", release],
    ["click", click],
    ["auxclick", click],
    ["dblclick", click],
    ["contextmenu", contextMenu]
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener as EventListener, true);
  return () => {
    for (const [type, listener] of listeners) target.removeEventListener(type, listener as EventListener, true);
  };
}
