// Which platforms ship each Rust crate, worked out from the repo's own records with no cargo run:
// the edges in Cargo.lock, filtered by the target-specific dependency sections of each crate's
// Cargo.toml (`[target.'cfg(windows)'.dependencies]` and friends). Used only by
// scripts/generate-about-holders.mjs, which stores the result in holderData.json; the build reads
// that file, never a cargo registry. Pure functions over text, so one host tests every platform.
import { ABOUT_PLATFORMS, type AboutPlatform, type PlatformTag } from "./provenanceTypes";

interface TargetFacts {
  os: string;
  family: string;
  env: string;
  vendor: string;
}

// What each shipped build is compiled for. Architectures are handled below: every shipped
// build is 64-bit x86_64 or aarch64 (macOS ships both, Windows is x64).
const targetFacts: Record<AboutPlatform, TargetFacts> = {
  macos: { os: "macos", family: "unix", env: "", vendor: "apple" },
  windows: { os: "windows", family: "windows", env: "msvc", vendor: "pc" },
  linux: { os: "linux", family: "unix", env: "gnu", vendor: "unknown" }
};

const shippedArchitectures = new Set(["x86_64", "aarch64"]);

type CfgToken = string;

function cfgTokens(text: string): CfgToken[] {
  const tokens: CfgToken[] = [];
  const pattern = /\s*(?:("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*)|([(),=]))/gy;
  let position = 0;
  while (position < text.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (!match) {
      if (text.slice(position).trim() === "") break;
      throw new Error("Cannot read cfg expression: " + text);
    }
    tokens.push(match[1] ? JSON.parse(match[1]) as string : match[2] ?? match[3]!);
    // A string token is told apart from an identifier by the quote the regex consumed.
    if (match[1]) tokens[tokens.length - 1] = "\"" + tokens[tokens.length - 1];
    position = pattern.lastIndex;
  }
  return tokens;
}

/** Evaluates a `cfg(...)` predicate (without the `cfg(` wrapper's own parentheses) for one shipped platform. */
export function evaluateCfg(expression: string, platform: AboutPlatform): boolean {
  const tokens = cfgTokens(expression);
  let index = 0;
  const facts = targetFacts[platform];
  const next = () => tokens[index++];
  const peek = () => tokens[index];

  // A custom flag (getrandom_backend, tokio_unstable, docsrs, miri) is set only by RUSTFLAGS, which no
  // release build passes, so it is false. A target_* name this evaluator does not know could change
  // the answer, so it stops the generator rather than guessing.
  function unsetCfg(name: string): boolean {
    if (name.startsWith("target_")) throw new Error("Unsupported cfg predicate " + name + " in: " + expression);
    return false;
  }

  function predicate(): boolean {
    const name = next();
    if (name === undefined) throw new Error("Unexpected end of cfg expression: " + expression);
    if (name === "all" || name === "any" || name === "not") {
      if (next() !== "(") throw new Error("Expected ( after " + name + " in: " + expression);
      const values: boolean[] = [];
      while (peek() !== ")") {
        values.push(predicate());
        if (peek() === ",") next();
        else if (peek() !== ")") throw new Error("Expected , or ) in: " + expression);
      }
      next();
      if (name === "not") return !values[0];
      return name === "all" ? values.every(Boolean) : values.some(Boolean);
    }
    if (peek() === "=") {
      next();
      const raw = next();
      if (!raw?.startsWith("\"")) throw new Error("Expected a quoted value after " + name + " in: " + expression);
      const value = raw.slice(1);
      switch (name) {
        case "target_os": return value === facts.os;
        case "target_family": return value === facts.family;
        case "target_env": return value === facts.env;
        case "target_vendor": return value === facts.vendor;
        case "target_abi": return value === "";
        case "target_arch": return shippedArchitectures.has(value);
        case "target_pointer_width": return value === "64";
        case "target_endian": return value === "little";
        case "target_has_atomic": return true;
        // Only RUSTFLAGS turns a target feature on (atomics on wasm, crt-static); release builds pass none.
        case "target_feature": return false;
        default: return unsetCfg(name);
      }
    }
    switch (name) {
      case "unix": return facts.family === "unix";
      case "windows": return facts.family === "windows";
      case "target_thread_local": return true;
      default: return unsetCfg(name);
    }
  }

  const result = predicate();
  if (index !== tokens.length) throw new Error("Trailing text in cfg expression: " + expression);
  return result;
}

/** A `[target.<spec>.dependencies]` key: either `cfg(...)` or a target triple. */
export function targetMatches(spec: string, platform: AboutPlatform): boolean {
  const cfg = spec.trim().match(/^cfg\((.*)\)$/s);
  if (cfg) return evaluateCfg(cfg[1]!, platform);
  const triple = spec.trim();
  if (platform === "macos") return /-apple-darwin$/.test(triple);
  if (platform === "windows") return /-windows-/.test(triple);
  return /-linux-/.test(triple);
}

/** Splits a TOML dotted key such as `target.'cfg(unix)'.dependencies.zbus`, honoring quotes. */
export function splitTomlKey(key: string): string[] {
  const parts: string[] = [];
  const pattern = /\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*(?:\.|$)/gy;
  let position = 0;
  while (position < key.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(key);
    if (!match) throw new Error("Cannot read TOML key: " + key);
    parts.push(match[1] ?? (match[2] !== undefined ? JSON.parse("\"" + match[2] + "\"") as string : match[3]!));
    position = pattern.lastIndex;
  }
  return parts;
}

export type DependencyKind = "normal" | "build" | "dev";

export interface DependencyDeclaration {
  kind: DependencyKind;
  /** The raw `cfg(...)` or triple of a `[target.X.dependencies]` section; absent for plain sections. */
  target?: string;
}

/** Every dependency a Cargo.toml declares, by the real package name (a `package = "x"` rename is resolved). */
export function readDependencyDeclarations(manifest: string): Map<string, DependencyDeclaration[]> {
  const declarations = new Map<string, DependencyDeclaration[]>();
  const add = (name: string, declaration: DependencyDeclaration) => {
    declarations.set(name, [...(declarations.get(name) ?? []), declaration]);
  };
  const kinds: Record<string, DependencyKind> = { dependencies: "normal", "build-dependencies": "build", "dev-dependencies": "dev" };
  let list: DependencyDeclaration | undefined;
  let table: { name: string; declaration: DependencyDeclaration } | undefined;

  const finishTable = () => {
    if (table) add(table.name, table.declaration);
    table = undefined;
  };

  for (const raw of manifest.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^[\]].*)\]\s*(?:#.*)?$/);
    if (header) {
      finishTable();
      list = undefined;
      const parts = splitTomlKey(header[1]!);
      const target = parts[0] === "target" ? parts[1] : undefined;
      const rest = parts[0] === "target" ? parts.slice(2) : parts;
      const kind = rest[0] ? kinds[rest[0]] : undefined;
      if (!kind || (parts[0] === "target" && parts.length < 3)) continue;
      if (rest.length === 1) list = { kind, ...(target ? { target } : {}) };
      else if (rest.length === 2) table = { name: rest[1]!, declaration: { kind, ...(target ? { target } : {}) } };
      continue;
    }
    if (line.startsWith("[")) {
      finishTable();
      list = undefined;
      continue;
    }
    if (table) {
      const renamed = line.match(/^package\s*=\s*"([^"]+)"/);
      if (renamed) table.name = renamed[1]!;
      continue;
    }
    if (list) {
      const entry = line.match(/^("[^"]+"|[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_.-]+)?\s*=\s*(.*)$/);
      if (!entry) continue;
      const alias = entry[1]!.replace(/^"|"$/g, "");
      const renamed = entry[2]!.match(/\bpackage\s*=\s*"([^"]+)"/);
      add(renamed?.[1] ?? alias, list);
    }
  }
  finishTable();
  return declarations;
}

export interface LockPackage {
  id: string;
  name: string;
  version: string;
  dependencies: string[];
}

/** The packages of a Cargo.lock with each dependency resolved to a `name@version` id. */
export function readCargoLock(lock: string): Map<string, LockPackage> {
  const raw: Array<{ name: string; version: string; dependencies: string[] }> = [];
  for (const block of lock.replace(/\r\n/g, "\n").split(/\n(?=\[\[package\]\])/)) {
    if (!block.startsWith("[[package]]")) continue;
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    const list = block.match(/^dependencies = \[\n([\s\S]*?)\n\]/m)?.[1] ?? "";
    raw.push({ name, version, dependencies: [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]!) });
  }
  const versionsOf = new Map<string, string[]>();
  for (const { name, version } of raw) versionsOf.set(name, [...(versionsOf.get(name) ?? []), version]);
  const packages = new Map<string, LockPackage>();
  for (const { name, version, dependencies } of raw) {
    const ids = dependencies.map(entry => {
      const [dependencyName, dependencyVersion] = entry.split(" ");
      const resolved = dependencyVersion ?? versionsOf.get(dependencyName!)?.[0];
      if (!resolved) throw new Error("Cargo.lock names a dependency it does not lock: " + entry);
      return dependencyName + "@" + resolved;
    });
    packages.set(name + "@" + version, { id: name + "@" + version, name, version, dependencies: ids });
  }
  return packages;
}

export interface PlatformReach {
  /** `name@version` to the platforms whose build contains the crate. A crate on none is absent. */
  platforms: Map<string, Set<AboutPlatform>>;
  /** Lock edges whose Cargo.toml was missing or did not declare them; kept, never silently dropped. */
  unfiltered: string[];
}

/**
 * Walks Cargo.lock from the root crate once per platform, following an edge only when the parent's
 * Cargo.toml declares it as a normal dependency that is active for that platform. Dev and
 * build-only dependencies are not shipped. A parent whose Cargo.toml cannot be read keeps all of
 * its edges (so a crate is shown rather than wrongly hidden) and is reported in `unfiltered`.
 */
export function reachByPlatform(
  lock: Map<string, LockPackage>,
  rootId: string,
  manifestOf: (pkg: LockPackage) => string | undefined
): PlatformReach {
  const declarations = new Map<string, Map<string, DependencyDeclaration[]> | undefined>();
  const declarationsOf = (pkg: LockPackage) => {
    if (!declarations.has(pkg.id)) {
      const manifest = manifestOf(pkg);
      declarations.set(pkg.id, manifest === undefined ? undefined : readDependencyDeclarations(manifest));
    }
    return declarations.get(pkg.id);
  };
  const unfiltered = new Set<string>();
  const platforms = new Map<string, Set<AboutPlatform>>();
  if (!lock.has(rootId)) throw new Error("Cargo.lock has no package " + rootId);
  for (const platform of ABOUT_PLATFORMS) {
    const seen = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const pkg = lock.get(queue.shift()!)!;
      const declared = declarationsOf(pkg);
      if (!declared) unfiltered.add(pkg.id + " (no Cargo.toml)");
      for (const dependencyId of pkg.dependencies) {
        const dependency = lock.get(dependencyId);
        if (!dependency || seen.has(dependencyId)) continue;
        const found = declared?.get(dependency.name);
        if (declared && !found) unfiltered.add(pkg.id + " -> " + dependency.name);
        const active = !declared || !found || found.some(declaration =>
          declaration.kind === "normal" && (!declaration.target || targetMatches(declaration.target, platform)));
        if (!active) continue;
        seen.add(dependencyId);
        queue.push(dependencyId);
      }
    }
    for (const id of seen) platforms.set(id, (platforms.get(id) ?? new Set()).add(platform));
  }
  return { platforms, unfiltered: [...unfiltered].sort() };
}

/** "all" when every shipped platform has the crate, otherwise the sorted list of platforms. */
export function platformTag(platforms: ReadonlySet<AboutPlatform> | undefined): PlatformTag {
  const list = ABOUT_PLATFORMS.filter(platform => platforms?.has(platform));
  return list.length === ABOUT_PLATFORMS.length ? "all" : list;
}
