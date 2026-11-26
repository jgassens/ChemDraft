import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { nativePrompt } from "./nativePrompt";
import {
  resolveAppendedExtensionSavePath,
  resolveRepeatedExtensionSaveTarget,
  writeGrantedRepeatedExtensionTarget,
  type RepeatedExtensionSaveContext,
  type RepeatedExtensionSaveTarget,
  type RepeatedExtensionSaveWrite
} from "./repeatedSaveExtension";

export interface NativeSavePanelOptions {
  /** The document's own current file: saving onto exactly this path needs no Replace question. */
  ownPath?: string;
  /** Defaults to the running platform; a panel path is collapsed only on macOS. */
  platform?: ShortcutPlatform;
}

function nativeSavePanelContext(options: NativeSavePanelOptions = {}): RepeatedExtensionSaveContext {
  const { ownPath, platform = detectDesktopShortcutPlatform() } = options;
  return {
    ownPath,
    platform,
    // Rejects outside the fs plugin's scope; the resolver then keeps the panel's granted path.
    exists: async (path) => (await import("@tauri-apps/plugin-fs")).exists(path),
    confirmReplace: async (path) => await nativePrompt({
      title: "Replace existing file?",
      message: `“${path.split(platform === "windows" ? /[\\/]/ : /\//).filter(Boolean).at(-1) ?? path}” already exists. Do you want to replace it?`,
      kind: "warning",
      owner: "document",
      choices: [
        { id: "replace", label: "Replace", destructive: true },
        { id: "cancel", label: "Cancel", cancel: true }
      ]
    }, async () => "cancel", undefined, undefined, platform) === "replace"
  };
}

/**
 * Undo the macOS save panel's repeated extension (typing `x.chemdraft` while the extension is
 * hidden returns `x.chemdraft.chemdraft`). The panel's Replace question covered the doubled name,
 * so an existing file at the collapsed path is confirmed here; declining resolves undefined. On
 * Windows and Linux the panel's path is returned exactly as the user typed it.
 */
export function resolveNativeSavePanelTarget(
  selected: string,
  extensions: readonly string[],
  options?: NativeSavePanelOptions
): Promise<RepeatedExtensionSaveTarget | undefined> {
  return resolveRepeatedExtensionSaveTarget(selected, extensions, nativeSavePanelContext(options));
}

/** `resolveNativeSavePanelTarget` for a caller that writes right away. */
export async function resolveNativeSavePanelPath(
  selected: string,
  extensions: readonly string[],
  options?: NativeSavePanelOptions
): Promise<string | undefined> {
  return (await resolveNativeSavePanelTarget(selected, extensions, options))?.path;
}

/** `resolveAppendedExtensionSavePath` with the native Replace question; undefined cancels. */
export function resolveNativeAppendedExtensionPath(
  selected: string,
  appended: string,
  options?: NativeSavePanelOptions
): Promise<string | undefined> {
  return resolveAppendedExtensionSavePath(selected, appended, nativeSavePanelContext(options));
}

/**
 * Write `path` for a deferred save whose grant is cached in `grants` under `key`; see
 * `writeGrantedRepeatedExtensionTarget`. False means the user declined to replace a file.
 */
export function writeNativeSavePanelGrant<K, G extends RepeatedExtensionSaveTarget>(
  grants: Map<K, G>,
  key: K,
  path: string,
  write: RepeatedExtensionSaveWrite,
  options?: NativeSavePanelOptions
): Promise<boolean> {
  return writeGrantedRepeatedExtensionTarget(grants, key, path, nativeSavePanelContext(options), write);
}
