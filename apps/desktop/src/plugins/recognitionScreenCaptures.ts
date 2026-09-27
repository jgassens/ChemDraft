import { invoke } from "@tauri-apps/api/core";

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Screen captures behind recognitions (AGENTS.md §8: the source image stays available until the user
 * deletes it). The native screen-capture command saves every successful capture to a private app-data
 * folder (`recognition-sources/`, 0700; files 0600) at the moment it is taken, so nothing is copied
 * later — accepting a proposal keeps nothing more. Images the user chose from a file are never copied:
 * they are still on disk. The user reaches the folder from Add or Remove Plugins, whether or not a
 * recognition plugin is installed, and removes captures there.
 */

/** Opens the saved screen captures in the system file manager. */
export async function revealRecognitionScreenCaptures(invokeCommand: InvokeCommand = invoke): Promise<void> {
  await invokeCommand<void>("reveal_recognition_screen_captures");
}
