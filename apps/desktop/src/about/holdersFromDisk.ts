// Reads the copyright holders of installed packages from disk. Used only by
// scripts/generate-about-holders.mjs; the build reads the committed holderData.json instead.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { cargoAuthors, dedupe, licenseFileStatements, manifestPeople, type LibraryHolders, type LibraryRef } from "./holders";

const root = new URL("../../../../", import.meta.url);

function readOptional(path: string): string | undefined {
  try {
    if (!statSync(path).isFile() || statSync(path).size > 256 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function licenseFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter(file => /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i.test(file))
      .sort().map(file => join(directory, file));
  } catch {
    return [];
  }
}

let npmIndex: Map<string, string> | undefined;

function npmPackageDirectory(name: string, version: string): string | undefined {
  if (!npmIndex) {
    npmIndex = new Map();
    const store = new URL("node_modules/.pnpm/", root);
    let entries: string[] = [];
    try { entries = readdirSync(store); } catch { /* no install: every holder falls back to "see license" */ }
    for (const entry of entries) {
      const at = entry.indexOf("@", 1);
      if (at < 0) continue;
      const packageName = entry.slice(0, at).replace("+", "/");
      const packageVersion = entry.slice(at + 1).split(/[_(]/)[0]!;
      const directory = join(fileURLToPath(store), entry, "node_modules", packageName);
      if (!existsSync(directory)) continue;
      npmIndex.set(packageName + "@" + packageVersion, directory);
    }
  }
  return npmIndex.get(name + "@" + version);
}

let cargoIndex: Map<string, string> | undefined;

function cargoCrateDirectory(name: string, version: string): string | undefined {
  if (!cargoIndex) {
    cargoIndex = new Map();
    const registry = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "registry", "src");
    try {
      for (const index of readdirSync(registry)) {
        for (const crate of readdirSync(join(registry, index))) cargoIndex.set(crate, join(registry, index, crate));
      }
    } catch { /* no cargo registry on this host */ }
  }
  return cargoIndex.get(name + "-" + version);
}

/** Directories of crates from `cargo metadata` (name-version to directory), set by the generator. */
export function setCargoDirectories(directories: Map<string, string>): void {
  cargoIndex = directories;
}

/** The holders one exact version of a package names in its own records. */
export function installedHolders(kind: LibraryRef["kind"], name: string, version: string): LibraryHolders & { found: boolean } {
  const directory = kind === "npm" ? npmPackageDirectory(name, version) : cargoCrateDirectory(name, version);
  if (!directory) return { holders: [], from: "none", found: false };
  const statements = dedupe(licenseFiles(directory).flatMap(file => licenseFileStatements(readOptional(file) ?? "")));
  if (statements.length) return { holders: statements, from: "license file", found: true };
  const metadata = kind === "npm"
    ? manifestPeople(JSON.parse(readOptional(join(directory, "package.json")) ?? "{}"))
    : cargoAuthors(readOptional(join(directory, "Cargo.toml")) ?? "");
  return metadata.length ? { holders: metadata, from: "package metadata", found: true } : { holders: [], from: "none", found: true };
}
