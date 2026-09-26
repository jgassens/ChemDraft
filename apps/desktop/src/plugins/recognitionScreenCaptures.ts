import { invoke } from "@tauri-apps/api/core";
import type { PluginProvidedImage } from "@chemdraft/plugin-api";

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Screen captures behind accepted recognitions (AGENTS.md §8: the source image stays available until
 * the user deletes it). A screen capture exists nowhere else once its proposal is accepted — the
 * native temporary file is gone and the document keeps only the structure — so the host saves it to a
 * private app-data folder (`recognition-sources/`, 0700; files 0600). Images the user chose from a
 * file are never copied: they are still on disk. The user reaches the folder from the recognition
 * engine's row in Add or Remove Plugins, and removes captures there.
 */
export async function retainRecognitionScreenCapture(
  image: PluginProvidedImage,
  invokeCommand: InvokeCommand = invoke
): Promise<string> {
  if (image.source !== "screenRegion" || image.mediaType !== "image/png") {
    throw new Error("Only a PNG screen capture is kept; an image file the user chose is already on disk.");
  }
  return invokeCommand<string>("retain_recognition_screen_capture", { bytesBase64: bytesToBase64(image.bytes) });
}

/** Opens the kept screen captures in the system file manager. */
export async function revealRecognitionScreenCaptures(invokeCommand: InvokeCommand = invoke): Promise<void> {
  await invokeCommand<void>("reveal_recognition_screen_captures");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
