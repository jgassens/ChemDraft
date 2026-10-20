import type { OpenDialogOptions, OpenDialogReturn, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { withNativeUtilitySuspension } from "./nativeUtilitySuspension";

let dialogModule: Promise<typeof import("@tauri-apps/plugin-dialog")> | undefined;

export function prewarmNativeFileDialogs(): Promise<typeof import("@tauri-apps/plugin-dialog")> {
  dialogModule ??= import("@tauri-apps/plugin-dialog").catch((error) => {
    dialogModule = undefined;
    throw error;
  });
  return dialogModule;
}

/** All document-window file panels use these wrappers, including plugin pickers and exports. */
export async function open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  const dialogs = await prewarmNativeFileDialogs();
  return withNativeUtilitySuspension(() => dialogs.open(options));
}

export async function save(options?: SaveDialogOptions, focusExportSessionId?: string): Promise<string | null> {
  const dialogs = await prewarmNativeFileDialogs();
  return withNativeUtilitySuspension(() => dialogs.save(options), focusExportSessionId);
}
