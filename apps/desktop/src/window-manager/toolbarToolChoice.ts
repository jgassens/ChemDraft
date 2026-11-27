import { isDrawingToolCommand } from "../drawingTools";

/**
 * Which toolbar control a tool was chosen through. Toolbars use it so exactly one control shows the
 * active tool: the one the user pressed, never every control that happens to carry the same command.
 *
 * `itemId` names a toolbar item whose face or standalone button was pressed; `flyoutId` names the
 * dropdown whose menu the tool was chosen from (a native flyout knows only its flyout id, which is
 * the item's `submenu.id`). `toolsetId` is the toolbar the control lives in.
 */
export interface ToolbarToolChoice {
  toolsetId: string;
  commandId: string;
  itemId?: string;
  flyoutId?: string;
}

/**
 * What a palette window or a native flyout may say about a choice made through it. It rides with the
 * command itself (`route_toolset_command`) and names no toolbar: Rust credits it to the toolbar the
 * sending window was built for (a palette's recorded toolset id, or a popover's label-verified flyout
 * opening, whose flyout id replaces any here). A window can therefore only ever speak for itself.
 */
export interface ToolbarToolChoiceClaim {
  itemId?: string;
  flyoutId?: string;
}

/**
 * The DOM event a toolbar choice arrives as. Rust dispatches it into the other toolbar windows by
 * evaluating it there, after deriving the toolset from the sender; a webview cannot dispatch a DOM
 * event into another webview, and nothing listens for choices on the Tauri event bus, which every
 * toolset window (plugin toolbars included) may emit on.
 */
export const TOOLBAR_TOOL_CHOICE_EVENT = "chemdraft:toolbar-tool-choice";

/**
 * Only a drawing tool is something a toolbar control shows as chosen. An action (align, arrange,
 * flip, group, order) never becomes the active tool, so it never moves any toolbar's highlight.
 */
export function isToolbarToolChoiceCommand(commandId: string): boolean {
  return isDrawingToolCommand(commandId);
}

/** The claim a native flyout sends with a command: none for an action, an empty one for a tool. */
export function flyoutToolChoiceClaim(commandId: string): ToolbarToolChoiceClaim | undefined {
  return isToolbarToolChoiceCommand(commandId) ? {} : undefined;
}

function isToolbarToolChoice(value: unknown): value is ToolbarToolChoice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ToolbarToolChoice>;
  return typeof candidate.toolsetId === "string" && typeof candidate.commandId === "string"
    && (candidate.itemId === undefined || typeof candidate.itemId === "string")
    && (candidate.flyoutId === undefined || typeof candidate.flyoutId === "string");
}

/**
 * Tell the other toolbars in this window, synchronously, which control a tool was chosen through.
 * Toolbars in other windows learn of it only through Rust, from the claim sent with the command.
 */
export function announceToolbarToolChoiceInWindow(choice: ToolbarToolChoice): void {
  if (typeof window === "undefined" || !isToolbarToolChoiceCommand(choice.commandId)) return;
  window.dispatchEvent(new CustomEvent(TOOLBAR_TOOL_CHOICE_EVENT, { detail: choice }));
}

/**
 * Listen for toolbar tool choices: this window's own, and those Rust delivers from other windows.
 * Malformed payloads and actions are dropped. Returns the cleanup.
 */
export function listenForToolbarToolChoices(handler: (choice: ToolbarToolChoice) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isToolbarToolChoice(detail) && isToolbarToolChoiceCommand(detail.commandId)) handler(detail);
  };
  window.addEventListener(TOOLBAR_TOOL_CHOICE_EVENT, listener);
  return () => window.removeEventListener(TOOLBAR_TOOL_CHOICE_EVENT, listener);
}
