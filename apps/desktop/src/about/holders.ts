// Copyright holders for the About window's open-source list. Every holder string comes from a
// record the package itself ships (its license file or package metadata) or from the
// repository's own NOTICE. Nothing is typed in by hand, and when no record names a holder the
// list says "see license" instead of guessing.
//
// The package records are read by `node scripts/generate-about-holders.mjs` (scripts/generate-about-holders.mjs, via
// holdersFromDisk.ts) into the committed holderData.json. The build reads only that file, so every
// platform shows the same holders whatever its install or cargo registry looks like.
import holderData from "./holderData.json";

export const SEE_LICENSE = "see license";

const maxStatement = 200;
const maxContributors = 5;

export function dedupe(values: string[]): string[] {
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


export function personName(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : (value as { name?: unknown } | null)?.name;
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return name || undefined;
}

export const AND_OTHERS = "and others";

// Metadata lists are cut to maxContributors; when they are, the list says so.
function limitPeople(names: string[]): string[] {
  const unique = dedupe(names);
  return unique.length > maxContributors ? [...unique.slice(0, maxContributors), AND_OTHERS] : unique;
}

// The package.json author and contributors, used only when the package has no copyright line.
export function manifestPeople(manifest: { author?: unknown; contributors?: unknown }): string[] {
  const author = personName(manifest.author);
  const contributors = Array.isArray(manifest.contributors)
    ? manifest.contributors.map(personName).filter((name): name is string => Boolean(name)) : [];
  return limitPeople([...(author ? [author] : []), ...contributors]);
}

export function cargoAuthors(manifest: string): string[] {
  const list = manifest.match(/^authors\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (!list) return [];
  return limitPeople([...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => personName(match[1]!)).filter((name): name is string => Boolean(name)));
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

export type HolderTable = Readonly<Record<string, LibraryHolders>>;

/** The committed table holds one entry per exact package version: "npm:react@19.2.0". */
export function holderKey(kind: LibraryRef["kind"], name: string, version: string): string {
  return kind + ":" + name + "@" + version;
}

export const committedHolders: HolderTable = (holderData as { entries: HolderTable }).entries;

// Only the exact locked version counts: another version of a package can name other holders.
export function resolveHolders(noticeHolders: string[], libraries: LibraryRef[], table: HolderTable = committedHolders): string[] {
  if (noticeHolders.length) return dedupe(noticeHolders);
  const fromLibraries = dedupe(libraries.flatMap(library => library.versions.flatMap(version =>
    table[holderKey(library.kind, library.name, version)]?.holders ?? [])));
  const named = fromLibraries.filter(holder => holder !== SEE_LICENSE);
  return named.length ? named : [SEE_LICENSE];
}
