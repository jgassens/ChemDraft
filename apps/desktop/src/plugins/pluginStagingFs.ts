/**
 * The filesystem an installed plugin package is staged into (M36).
 *
 * Staging is the one part of install that is genuinely platform-bound, so it is stated here as a narrow
 * **port** and bound to Tauri's fs plugin in {@link createTauriPluginStagingFs}. Everything else in the
 * installer — unpacking, integrity, manifest validation, traversal refusal, install records — is then
 * plain logic over this interface, and therefore testable in vitest against an in-memory double rather
 * than requiring a running desktop app.
 *
 * Every path is **app-data-relative** and forward-slashed. The port deliberately cannot express an
 * absolute path: the staging root is the boundary the installer must never cross, and a port that cannot
 * name anything outside it removes an entire category of mistake at the type level.
 */

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile
} from "@tauri-apps/plugin-fs";

export interface PluginStagingFs {
  /** Write a file, creating parent directories as needed. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Read a UTF-8 file, or `undefined` when it does not exist. */
  readTextFile(path: string): Promise<string | undefined>;
  writeTextFile(path: string, text: string): Promise<void>;
  /** Atomically replace `newPath` with `oldPath` where the platform supports ordinary rename. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Recursively remove a directory. Succeeds when it is already absent. */
  removeDir(path: string): Promise<void>;
  /** Immediate child directory names. Empty when the directory does not exist. */
  readDirNames(path: string): Promise<readonly string[]>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Whether this build can stage packages at all (i.e. is running inside the Tauri webview). */
export function isTauriHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const baseDir = BaseDirectory.AppData;

/** Bind the staging port to the desktop's real app-data directory. */
export function createTauriPluginStagingFs(): PluginStagingFs {
  return {
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      const parent = parentOf(path);
      if (parent) {
        await mkdir(parent, { baseDir, recursive: true });
      }
      await writeFile(path, bytes, { baseDir });
    },
    async readTextFile(path: string): Promise<string | undefined> {
      // `exists`-then-read rather than catching: a read error we did not cause (permissions, a corrupt
      // volume) must stay loud instead of being flattened into "not installed".
      if (!(await exists(path, { baseDir }))) {
        return undefined;
      }
      return readTextFile(path, { baseDir });
    },
    async writeTextFile(path: string, text: string): Promise<void> {
      const parent = parentOf(path);
      if (parent) {
        await mkdir(parent, { baseDir, recursive: true });
      }
      await writeTextFile(path, text, { baseDir });
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await rename(oldPath, newPath, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
    },
    async removeDir(path: string): Promise<void> {
      if (!(await exists(path, { baseDir }))) {
        return;
      }
      await remove(path, { baseDir, recursive: true });
    },
    async readDirNames(path: string): Promise<readonly string[]> {
      if (!(await exists(path, { baseDir }))) {
        return [];
      }
      const entries = await readDir(path, { baseDir });
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
    },
    async mkdir(path: string): Promise<void> {
      await mkdir(path, { baseDir, recursive: true });
    },
    async exists(path: string): Promise<boolean> {
      return exists(path, { baseDir });
    }
  };
}

function parentOf(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index <= 0 ? undefined : path.slice(0, index);
}
