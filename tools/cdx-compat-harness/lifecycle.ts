import type { ChildProcess } from "node:child_process";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const children = new Set<ChildProcess>();
const directories = new Set<string>();
let installed = false;
let stopping = false;

function removeDirectory(directory: string) {
  // Copies are read-only. Windows requires writable files before deleting them.
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removeDirectory(path);
    else chmodSync(path, 0o600);
  }
  rmSync(directory, { recursive: true, force: true });
}

function cleanup() {
  for (const child of children) child.kill("SIGKILL");
  for (const directory of directories) {
    try { removeDirectory(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.exitCode = 1; }
  }
}

async function stop(signal: "SIGTERM" | "SIGINT") {
  if (stopping) return;
  stopping = true;
  // Reap children before removing their open files, including on Windows.
  await Promise.all([...children].map(child => new Promise<void>(done => {
    child.once("close", done);
    child.kill("SIGKILL");
  })));
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
const terminate = () => { void stop("SIGTERM"); };
const interrupt = () => { void stop("SIGINT"); };
function install() {
  if (stopping) throw new Error("Compatibility harness is stopping.");
  if (installed) return;
  installed = true;
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  process.on("exit", cleanup);
}
function idle() {
  if (stopping || children.size || directories.size) return;
  process.off("SIGTERM", terminate);
  process.off("SIGINT", interrupt);
  process.off("exit", cleanup);
  installed = false;
}
export function trackChild(child: ChildProcess): void {
  if (stopping) { child.kill("SIGKILL"); return; }
  install();
  children.add(child);
  child.once("close", () => { children.delete(child); idle(); });
}
export function trackDirectory(directory: string): () => void {
  if (stopping) { removeDirectory(directory); throw new Error("Compatibility harness is stopping."); }
  install();
  directories.add(directory);
  return () => { directories.delete(directory); idle(); };
}
