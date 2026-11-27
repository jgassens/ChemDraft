import { createToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { CanvasMenuItem } from "./canvasContextMenuModel";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import { dispatchPaletteTooltipDismiss } from "./paletteTooltipDismissal";

export const CUSTOMIZE_TOOLBAR_MENU_LABEL = "Customize Toolbar…";
export const HIDE_TOOLBAR_MENU_LABEL = "Hide Toolbar";

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

/** The right-click menu of a floating toolbar. Every item is a registered command: Customize reuses
 *  the existing customize command, and Hide reuses the toolbar's View > Toolbars toggle (the toolbar
 *  is visible, since it was just right-clicked, so the toggle hides it). */
export function toolsetContextMenuItems(toolsetId: string): CanvasMenuItem[] {
  const items: CanvasMenuItem[] = [];
  const customize = toolsetCustomizeCommandId(toolsetId);
  if (customize) {
    items.push({ kind: "command", commandId: customize, label: CUSTOMIZE_TOOLBAR_MENU_LABEL, enabled: true });
    items.push({ kind: "separator" });
  }
  items.push({
    kind: "command", commandId: createToolsetToggleCommandId(toolsetId), label: HIDE_TOOLBAR_MENU_LABEL, enabled: true
  });
  return items;
}

/** A right-button press, or on macOS a Control-click, which the system treats as a right-click. */
export function isSecondaryPress(event: Pick<MouseEvent, "button" | "ctrlKey">, platform: ShortcutPlatform): boolean {
  return event.button === 2 || (platform === "macos" && event.button === 0 && event.ctrlKey);
}

type PopupResult = { select(onInvoke: (commandId: string) => void): boolean } | null | undefined;

export interface ToolsetContextMenuOptions {
  platform: ShortcutPlatform;
  /** The menu for this press, read when it is requested; undefined shows none (for example while
   *  the toolbar is in customize mode). The press is still kept from its button either way. */
  items: () => readonly CanvasMenuItem[] | undefined;
  /** Runs the chosen registered command (the palette's normal command route). */
  onInvoke: (commandId: string) => void;
  /** The native popup; defaults to the document window's popup command shared with the canvas. */
  popup?: (items: readonly CanvasMenuItem[], position: { x: number; y: number }) => Promise<PopupResult>;
}

/**
 * Right-click (and macOS Control-click) anywhere in a palette window opens the toolbar's native menu,
 * and never reaches the button, grip or gap under the pointer. The listeners sit on the window in
 * the capture phase, ahead of React's root listeners, so a secondary press, its release and the click
 * that follows never run a command, start a press state, change the tool or start a window drag.
 * Primary presses pass through untouched.
 */
export function installToolsetContextMenu(target: Window, options: ToolsetContextMenuOptions): () => void {
  const popup = options.popup ?? popupNativeCanvasMenu;
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
  const request = (event: MouseEvent) => {
    if (inFlight) return;
    const items = options.items();
    if (!items?.length) return;
    inFlight = true;
    void popup(items, { x: event.clientX, y: event.clientY })
      .then(result => { result?.select(options.onInvoke); })
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
    if (event.button === 0) request(event);
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
    request(event);
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
