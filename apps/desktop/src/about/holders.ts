// Copyright holders for the About window's open-source list. Every holder string is read
// at build time from a record the package itself ships (its license file or package
// metadata) or from the repository's own NOTICE. Nothing is typed in by hand, and when no
// record names a holder the list says "see license" instead of guessing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

export const SEE_LICENSE = "see license";

const root = new URL("../../../../", import.meta.url);
const maxStatement = 200;
const maxContributors = 5;

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Text a statement is allowed to begin with. Prose such as "Copyright notices, source
// repositories..." and license boilerplate such as "Copyright [yyyy] [name of owner]" are not holders.
function acceptable(statement: string, holder: string): boolean {
  if (!/[A-Za-z]/.test(holder)) return false;
  if (/^(?:notices?|holders?|owners?|statements?|laws?|and|or|in|is|the|of|to|on|for)\b/.test(holder)) return false;
  if (/[<>[\]{}]|yyyy|name of copyright|copyright holders?$/i.test(statement)) return false;
  return statement.length <= maxStatement;
}

function tidy(statement: string): string {
  let text = statement
    .replace(/<[^>]*>/g, "")
    .replace(/\s\(https?:[^)]*\)/g, "")
    .replace(/\s\([^)]*@[^)]*\)/g, "")
    .replace(/\s+All [Rr]ights [Rr]eserved\.?$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,:\s]+$/, "")
    .replace(/\.$/, "");
  if (/\b(?:Inc|Ltd|Corp|Co)$/.test(text)) text += ".";
  return text;
}

// Pull "Copyright ..." statements out of one curated paragraph of NOTICE. A bare "(c)" counts
// there because NOTICE writes some holders that way ("(c) FasterXML").
const noticePattern = new RegExp(
  "(?:Copyright(?:\\s*\\(c\\)|\\s*©)?|©|\\(c\\))\\s+([^;]+?)(?=(?<=\\w{2})\\.(?:\\s|$|;)|;|\\s-\\s|\\s\\((?!c\\))" +
  "|\\s(?:All [Rr]ights\\b|Source:|License:|Licence:|Permission\\b)|\\s(?=Copyright\\b|©|\\(c\\))|$)", "g");

export function noticeStatements(text: string): string[] {
  const collapsed = text.replace(/\s+/g, " ");
  const found: string[] = [];
  for (const match of collapsed.matchAll(noticePattern)) {
    const statement = tidy(match[0]);
    if (acceptable(statement, match[1]!)) found.push(statement);
  }
  return dedupe(found);
}

// License files: only lines that begin with "Copyright" or the copyright sign. Each line is one
// statement, so a license's own prose and numbered conditions such as "(c) You must retain" never count.
export function licenseFileStatements(text: string): string[] {
  const found: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/^[\s*#/>;-]+/, "").trim();
    if (!/^(?:Copyright|©)\s/.test(line)) continue;
    const statement = tidy(line.replace(/;.*$/, ""));
    const holder = statement.replace(/^(?:Copyright\s*(?:\(c\)|©)?|©)\s*/, "");
    if (holder && acceptable(statement, holder)) found.push(statement);
  }
  return dedupe(found);
}

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

function personName(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : (value as { name?: unknown } | null)?.name;
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return name || undefined;
}

// The package.json author and contributors, used only when the package has no copyright line.
function manifestPeople(manifest: { author?: unknown; contributors?: unknown }): string[] {
  const author = personName(manifest.author);
  const contributors = Array.isArray(manifest.contributors)
    ? manifest.contributors.map(personName).filter((name): name is string => Boolean(name)) : [];
  return dedupe([...(author ? [author] : []), ...contributors].slice(0, maxContributors));
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
      if (!npmIndex.has(packageName)) npmIndex.set(packageName, directory);
    }
  }
  return npmIndex.get(name + "@" + version) ?? npmIndex.get(name);
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

function cargoAuthors(manifest: string): string[] {
  const list = manifest.match(/^authors\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (!list) return [];
  return dedupe([...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => personName(match[1]!)).filter((name): name is string => Boolean(name))
    .slice(0, maxContributors));
}

export interface LibraryRef {
  kind: "npm" | "cargo";
  name: string;
  versions: string[];
}

export interface LibraryHolders {
  holders: string[];
  /** Where the holders came from, for tests and debugging: a license file, package metadata, or nothing found. */
  from: "license file" | "package metadata" | "none";
}

export function libraryHolders(library: LibraryRef): LibraryHolders {
  for (const version of library.versions) {
    const directory = library.kind === "npm" ? npmPackageDirectory(library.name, version) : cargoCrateDirectory(library.name, version);
    if (!directory) continue;
    const statements = dedupe(licenseFiles(directory).flatMap(file => licenseFileStatements(readOptional(file) ?? "")));
    if (statements.length) return { holders: statements, from: "license file" };
    const metadata = library.kind === "npm"
      ? manifestPeople(JSON.parse(readOptional(join(directory, "package.json")) ?? "{}"))
      : cargoAuthors(readOptional(join(directory, "Cargo.toml")) ?? "");
    if (metadata.length) return { holders: metadata, from: "package metadata" };
  }
  return { holders: [], from: "none" };
}

export function resolveHolders(noticeHolders: string[], libraries: LibraryRef[]): string[] {
  if (noticeHolders.length) return dedupe(noticeHolders);
  const fromLibraries = dedupe(libraries.flatMap(library => libraryHolders(library).holders));
  return fromLibraries.length ? fromLibraries : [SEE_LICENSE];
}
