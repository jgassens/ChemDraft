import type { OpenDialogOptions, OpenDialogReturn, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { detectShortcutPlatform, type ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { withOneFileDialog } from "./fileDialogGuard";
import { withNativeUtilitySuspension } from "./nativeUtilitySuspension";

type SaveDialogFilter = NonNullable<SaveDialogOptions["filters"]>[number];

/**
 * Move the first filter that matches `defaultPath`'s file name to the front; otherwise return
 * `filters` itself. A filter matches when one of its extensions ends the name (case-insensitive),
 * or it lists "*".
 */
export function filtersMatchingDefaultPathFirst(filters: SaveDialogFilter[], defaultPath: string): SaveDialogFilter[] {
  const name = (defaultPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  const index = filters.findIndex(filter => filter.extensions.some(extension =>
    extension === "*" || (extension !== "" && name.endsWith(`.${extension.toLowerCase()}`))));
  if (index <= 0) return filters;
  return [filters[index]!, ...filters.slice(0, index), ...filters.slice(index + 1)];
}

/**
 * Linux only. The GTK Save dialog showed a blank file-type list when the suggested file already
 * existed with an extension the first filter does not list (Save As of drawing.cdxml offers
 * ChemDraft first): GTK preselects the existing file, finds it hidden by the active filter, and
 * drops the filter, which leaves the list with no active entry. Offering the filter that matches
 * the suggested name first keeps that file visible, so the list shows its name. The filters, their
 * names and the chosen path are unchanged; only their order is. macOS and Windows get `options`
 * back as given.
 */
export function saveDialogOptionsForPlatform(
  options: SaveDialogOptions | undefined,
  platform: ShortcutPlatform
): SaveDialogOptions | undefined {
  if (platform !== "linux" || !options?.filters?.length || !options.defaultPath) return options;
  const filters = filtersMatchingDefaultPathFirst(options.filters, options.defaultPath);
  return filters === options.filters ? options : { ...options, filters };
}

let dialogModule: Promise<typeof import("@tauri-apps/plugin-dialog")> | undefined;

export function prewarmNativeFileDialogs(): Promise<typeof import("@tauri-apps/plugin-dialog")> {
  dialogModule ??= import("@tauri-apps/plugin-dialog").catch((error) => {
    dialogModule = undefined;
    throw error;
  });
  return dialogModule;
}

/** All document-window file panels use these wrappers, including plugin pickers and exports.
 * At most one is pending at a time; a refused request resolves null, as a cancel. */
export function open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  return withOneFileDialog(async () => {
    const dialogs = await prewarmNativeFileDialogs();
    return withNativeUtilitySuspension(() => dialogs.open(options));
  }, null as unknown as OpenDialogReturn<T>);
}

export function save(
  options?: SaveDialogOptions,
  focusExportSessionId?: string,
  platform: ShortcutPlatform = detectShortcutPlatform()
): Promise<string | null> {
  return withOneFileDialog(async () => {
    const dialogs = await prewarmNativeFileDialogs();
    const panelOptions = saveDialogOptionsForPlatform(options, platform);
    return withNativeUtilitySuspension(() => dialogs.save(panelOptions), focusExportSessionId);
  }, null);
}
