import { compareNativeVersions, NativeDocumentFormatVersion, NativeDocumentReaderVersion, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { ChemDraftOpenResult } from "@chemdraft/cdx-compat";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { nativePrompt, type NativePromptOptions } from "./nativePrompt";

/** Called once after a document is installed, never once per fallback warning. The resolved
 * document matters: choosing edited visible CDXML must not announce the unused embedded file. */
export async function notifyNativeDocumentCompatibility(
  opened: ChemDraftOpenResult,
  document: ChemDraftDocument,
  platform: ShortcutPlatform = detectDesktopShortcutPlatform(),
  // Startup may defer presentation until the native floating toolsets have been created.
  present: (notice: NativePromptOptions) => Promise<unknown> = notice =>
    nativePrompt(notice, undefined, undefined, undefined, platform)
): Promise<void> {
  const minimum = document.minAppVersion;
  for (const warning of opened.warnings) {
    if (warning.code.startsWith("NATIVE_")) console.warn("Native document compatibility", warning);
  }
  const newer = (minimum !== undefined && compareNativeVersions(minimum, NativeDocumentReaderVersion) > 0)
    || (document.formatVersion !== undefined && compareNativeVersions(document.formatVersion, NativeDocumentFormatVersion) > 0);
  if (!newer) return;
  const version = minimum ?? document.formatVersion;
  await present({
    title: "Newer ChemDraft file",
    message: `This file was made with a newer ChemDraft (${version}). Some features may not show. Update to keep them.`,
    kind: "warning",
    owner: "document",
    choices: [{ id: "ok", label: "OK", cancel: true }]
  });
}
