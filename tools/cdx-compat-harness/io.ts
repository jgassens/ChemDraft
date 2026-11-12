import { constants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { chmod, copyFile, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Result } from "./model";
import { noSymlink, writableOutput, validateDestination } from "./safety";
import { trackDirectory } from "./lifecycle";

export async function* lines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) if (line.trim()) yield line; }
  finally { reader.close(); input.destroy(); }
}
export async function* results(out: string, preferRescored = false): AsyncGenerator<Result> {
  const rescored = join(out, "private", "results.rescored.jsonl");
  const path = preferRescored && await noSymlink(rescored) ? rescored : join(out, "private", "results.jsonl");
  for await (const line of lines(path)) yield JSON.parse(line) as Result;
}
export async function withCopy<T>(original: string, action: (copy: string, id: string, size: number, directory: string) => Promise<T>, tempRoot?: string): Promise<T> {
  const parent = tempRoot ?? await realpath(tmpdir());
  await noSymlink(parent);
  const directory = await mkdtemp(join(parent, "cdx-harness-"));
  const untrack = trackDirectory(directory);
  const copy = join(directory, "input");
  try {
    // Preflight already collected source identities for the run's output root.
    // Do not retain a new registry entry for every short-lived copy directory.
    await validateDestination(original, directory, false);
    // copyFile closes the original before any parsing, hashing or child execution starts.
    await noSymlink(copy);
    await copyFile(original, copy, constants.COPYFILE_EXCL);
    await chmod(copy, 0o444);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(copy)) { hash.update(chunk); size += chunk.length; }
    return await action(copy, hash.digest("hex").slice(0, 12), size, directory);
  } finally {
    // Windows needs a writable copy for reliable removal. The original is never chmod'ed.
    await chmod(copy, 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    untrack();
  }
}
/** Appends always end in a newline. Discard an interrupted final append before resuming. */
export async function repairTail(out: string): Promise<void> {
  const path = join(out, "private", "results.jsonl");
  let file;
  try { await writableOutput(path); file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    let position = (await file.stat()).size;
    if (!position) return;
    const buffer = Buffer.alloc(65536);
    while (position) {
      const size = Math.min(position, buffer.length);
      position -= size;
      await file.read(buffer, 0, size, position);
      const newline = buffer.subarray(0, size).lastIndexOf(10);
      if (newline >= 0) { await file.truncate(position + newline + 1); return; }
    }
    await file.truncate(0);
  } finally { await file.close(); }
}
export async function readBounded(file: string, max = 64 * 1024 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > max) throw new Error("Input exceeds the file-size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "operation_failed";
}
