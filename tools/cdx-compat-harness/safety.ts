import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const inside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export async function noSymlink(path: string) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("Output must not contain symlinks.");
    return entry;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Resolve missing destinations through their nearest existing ancestor, before mkdir. */
export async function destinationRealpath(path: string): Promise<string> {
  if (await noSymlink(path)) return realpath(path);
  return join(await destinationRealpath(dirname(resolve(path))), basename(path));
}

const originals = new Map<string, Set<string>>();
const identity = (entry: { dev: number; ino: number }) => `${entry.dev}:${entry.ino}`;
export async function writableOutput(path: string) {
  const entry = await noSymlink(path);
  if (entry && !entry.isDirectory()) {
    if (entry.nlink > 1) throw new Error("Output must not contain hardlinked files.");
    for (const [out, ids] of originals) {
      if (inside(out, resolve(path)) && ids.has(identity(entry))) throw new Error("Output must not share an original's inode.");
    }
  }
  return entry;
}

export async function validateDestination(original: string, out: string, rememberOriginal = true) {
  if (!isAbsolute(original) || /[\r\n\t]/.test(original)) throw new Error("List entries must be absolute paths without tabs or newlines.");
  const parent = await realpath(dirname(original));
  const destination = await destinationRealpath(resolve(out));
  if (inside(parent, destination)) throw new Error("Output must be outside every original's directory.");
  let source: string;
  try { source = await realpath(original); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (inside(destination, source)) throw new Error("Output must not contain an original.");
  if (rememberOriginal) {
    const key = resolve(out);
    const ids = originals.get(key) ?? new Set<string>();
    ids.add(identity(await stat(original)));
    originals.set(key, ids);
  }
}

/** Preflight the whole existing tree before any output is changed. */
export async function checkOutputTree(path: string): Promise<void> {
  const entry = await writableOutput(path);
  if (entry?.isDirectory()) for (const name of await readdir(path)) await checkOutputTree(join(path, name));
}

export async function prepareOutput(out: string): Promise<void> {
  await checkOutputTree(out);
  // The private index is also the complete source list for report/export commands.
  const index = join(out, "private", "index.tsv");
  if (await noSymlink(index)) {
    const { lines } = await import("./io");
    for await (const row of lines(index)) {
      const original = row.split("\t")[1];
      if (!original) throw new Error("Output must have a valid private index.");
      await validateDestination(original, out);
    }
  }
  await checkOutputTree(out);
  await mkdir(join(out, "private"), { recursive: true, mode: 0o700 });
  await realpath(out);
  await realpath(join(out, "private"));
}

async function write(path: string, data: string | Uint8Array, append: boolean, mode = 0o600, exclusive = false): Promise<void> {
  const exists = await writableOutput(path);
  // Exclusive creation for new files; lstat plus O_NOFOLLOW for existing final components.
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) |
    (exists && !exclusive ? (append ? constants.O_APPEND : constants.O_TRUNC) : constants.O_CREAT | constants.O_EXCL);
  let file;
  try { file = await open(path, flags, mode); }
  catch (error) {
    // Two concurrent appends may both observe a missing log. Recheck before reopening.
    if (!append || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await writableOutput(path);
    file = await open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  }
  try { await file.writeFile(data); } finally { await file.close(); }
}
export const writeOutput = (path: string, data: string | Uint8Array, options?: { mode?: number; flag?: "wx" }) => write(path, data, false, options?.mode, options?.flag === "wx");
export const appendOutput = (path: string, data: string, options?: { mode?: number }) => write(path, data, true, options?.mode);
