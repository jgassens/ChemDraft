import { readFileSync, readdirSync } from "node:fs";
import { URL } from "node:url";
import { SEE_LICENSE, noticeStatements, resolveHolders, resolvePlatforms, type LibraryRef } from "./holders";
import type { AboutComponent, AboutProvenance } from "./provenanceTypes";

const root = new URL("../../../../", import.meta.url);
const inventoryPath = "docs/architecture/dependency-inventory.md";
const repository = "https://github.com/jgassens/ChemDraft";
const inventoryUrl = repository + "/blob/main/" + inventoryPath;
export const readAboutSource = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

interface InventoryRow {
  name: string;
  purpose: string;
  license: string;
  scope: string;
  notes: string;
}

function plain(value: string): string {
  return value.replace(/[\x60*]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function readInventoryRows(source: string): InventoryRow[] {
  let scan = false;
  return source.split("\n").flatMap(line => {
    if (line.startsWith("## ")) scan = line.startsWith("## Copyleft scan");
    if (!line.startsWith("| ")) return [];
    const [name, purpose, license, scope, notes] = line.trimEnd().slice(1, -1).split("|").map(cell => cell.trim());
    if (!name || /^(?:Package|Component|---)$/.test(name)) return [];
    if (!purpose || !license || !scope) throw new Error("Invalid dependency inventory row: " + name);
    return [{ name: plain(name), purpose: plain(scan ? scope : purpose), license: plain(license),
      scope: scan ? (name.includes("rollup-plugin-dts") ? "Development dependency" : "Runtime dependency") : scope,
      notes: notes ?? "" }];
  });
}

interface NoticeRow {
  heading: string;
  body: string;
}

export function readNoticeRows(source: string): NoticeRow[] {
  const headings = [...source.matchAll(/^(\S[^\n]+(?:\n[^\s\n][^\n]+)*)(?=\n {2}\S)/gm)];
  const rows = headings.map((match, index) => ({
    heading: match[1]!.replace(/\n/g, " "),
    body: source.slice(match.index + match[0].length, headings[index + 1]?.index)
  })).filter(({ heading }) => !/^(?:APPENDIX A\.|A\.\d+ )/.test(heading));
  const nested = [
    ...source.matchAll(/^ {2}([a-z][a-z-]+ \d+\.\d+\.\d+): (.+)$/gm),
    ...source.matchAll(/^ {4}(\S.+?\)) {2,}((?:Apache|BSD|MIT).+)$/gm),
    ...source.matchAll(/^ {2}(\S[^\n]+)\n {2}(https:\/\/\S+ -- .+)$/gm)
  ];
  // A table row's holder can wrap onto following lines, which are indented deeper than the row.
  const wrapped = (match: RegExpMatchArray) => {
    const lines = source.slice(match.index! + match[0].length).split("\n").slice(1);
    const extra: string[] = [];
    for (const line of lines) {
      if (!/^ {30,}\S/.test(line)) break;
      extra.push(line.trim());
    }
    return [match[2]!, ...extra].join(" ");
  };
  return rows.concat(nested.map(match => ({ heading: match[1]!, body: match[0].startsWith("    ") ? wrapped(match) : match[2]! })));
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

function addVersion(versions: Map<string, Set<string>>, name: string, version: string): void {
  const values = versions.get(name) ?? new Set<string>();
  values.add(version);
  versions.set(name, values);
}

function runtimePackages(): Map<string, Set<string>> {
  const directories = readdirSync(new URL("packages/", root), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => "packages/" + entry.name);
  const desktop = "apps/desktop";
  const manifests = new Map([desktop, ...directories].map(dir => {
    const manifest = JSON.parse(readAboutSource(dir + "/package.json")) as Manifest;
    return [manifest.name, { dir, manifest }];
  }));
  const lock = readAboutSource("pnpm-lock.yaml");
  const importers = lock.slice(lock.indexOf("importers:"), lock.indexOf("\npackages:"))
    .split(/\n(?= {2}\S)/);
  const visited = new Set<string>();
  const versions = new Map<string, Set<string>>();
  function visit(name: string): void {
    const pkg = manifests.get(name);
    if (!pkg || visited.has(name)) return;
    visited.add(name);
    const importer = importers.find(block => block.startsWith("  " + pkg.dir + ":"));
    const dependencies = importer?.split("\n    dependencies:\n")[1]?.split(/\n {4}\S/)[0] ?? "";
    const locked = new Map([...dependencies.matchAll(/^ {6}'?([^':\n]+)'?:\n {8}specifier: [^\n]+\n {8}version: ([^(\n]+)/gm)]
      .map(match => [match[1], match[2]!.trim()]));
    for (const [dependency, specifier] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (specifier.startsWith("workspace:")) visit(dependency);
      else {
        const version = locked.get(dependency) ?? (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(specifier) ? specifier : undefined);
        if (!version) throw new Error("Missing locked runtime dependency: " + pkg.dir + "/" + dependency);
        addVersion(versions, dependency, version);
      }
    }
  }
  visit("@chemdraft/desktop");
  return versions;
}

function documentedVersion(row: InventoryRow): string | undefined {
  return row.notes.match(/(?:^|[.;] )Version: (.+?)(?:;|$)/)?.[1]
    ?? row.name.match(/(?:^|[\s(])(\d+(?:[.-]\d+)+|\d{8})(?:[),\s]|$)/)?.[1]
    ?? row.notes.match(/(?:release [\x60]?|tag [\x60]?v?|Software )(\d+(?:\.\d+)+)/)?.[1]
    ?? row.notes.match(/tag [\x60]?(Release_[\d_]+)/)?.[1]
    ?? row.notes.match(/commit [\x60]?([a-f0-9]{40})/)?.[1];
}

function componentFromInventory(
  row: InventoryRow,
  npm: Map<string, Set<string>>,
  cargo: Map<string, Set<string>>
): { component: AboutComponent; libraries: LibraryRef[] } {
  // Rows that name multiple packages stay together, with each locked version identified.
  const libraries = row.name.split(/ [+\/] /).map(name => name.split(" ")[0]!)
    .filter(name => npm.has(name) || cargo.has(name));
  const locked = libraries.map(name => {
    const versions = [...(npm.get(name) ?? cargo.get(name) ?? [])];
    return libraries.length > 1 ? name + " " + versions.join(", ") : versions.join(", ");
  }).join(" / ");
  const name = libraries[0];
  const packageUrl = name ? (npm.has(name) ? "https://www.npmjs.com/package/" : "https://crates.io/crates/") + name : undefined;
  const source = row.notes.match(/(?:^|[.;] )Source: \x60?(https:\/\/[^\s\x60,;)]+)/)?.[1];
  const component: AboutComponent = {
    name: row.name,
    version: documentedVersion(row) ?? (locked || "Version unavailable in the source records"),
    license: row.license,
    holders: [SEE_LICENSE],
    purpose: row.purpose,
    sourceUrl: (source ?? packageUrl ?? row.notes.match(/https:\/\/[^\s\x60,;)]+/)?.[0] ?? inventoryUrl).replace(/\.$/, ""),
    licenseText: row.notes.match(/License text: \x60([^\x60]+)\x60/)?.[1]
  };
  return {
    component,
    libraries: libraries.map(library => ({
      kind: npm.has(library) ? "npm" : "cargo", name: library, versions: [...(npm.get(library) ?? cargo.get(library) ?? [])]
    }))
  };
}

// NOTICE is a prose file. Match alternate names to inventory rows and keep the legal
// wording in NOTICE. An unfamiliar heading must acquire a record or an explicit disposition.
const noticeAliases: ReadonlyArray<readonly [RegExp, string]> = [
  [/^TanStack Hotkeys/, "@tanstack/react-hotkeys"],
  [/^Octet Draw /, "Octet Draw"],
  [/^Adobe Core 14 font metrics/, "Adobe Core 14 AFM metrics (Helvetica and Symbol, 1997)"],
  [/^Patrick Hand Regular/, "Patrick Hand Regular 1.003"],
  [/^Noto Sans/, "Noto Sans 2.015"],
  [/^DejaVu Sans/, "DejaVu Sans 2.35"],
  [/^RDKit MinimalLib/, "RDKit MinimalLib WASM (vendored)"],
  [/^IsoSpec /, "IsoSpec WASM (vendored)"],
  [/^OPSIN /, "OPSIN (vendored JAR + bundled JRE)"],
  [/^JNA /, "JNA 5.10.0 (inside the OPSIN jar)"],
  [/^jna-inchi /, "jna-inchi 1.3.1 (inside the OPSIN jar)"],
  [/^InChI 1\.07\.2/, "InChI 1.07.2 (inside the jna-inchi natives)"],
  [/^InChI \(statically linked/, "InChI (inside the RDKit MinimalLib WASM)"],
  [/^FreeType 2\.13\.3 /, "FreeType 2.13.3 (inside the RDKit MinimalLib WASM)"],
  [/^zlib 1\.3\.2 /, "zlib 1.3.2 (inside the RDKit MinimalLib WASM)"],
  [/^Telex Regular /, "Telex Regular (font embedded in the RDKit MinimalLib WASM)"],
  [/^Bundled Java runtime/, "OpenJDK runtime (jlink)"],
  [/^Avogadro libraries/, "avogadrolibs (Avogadro Core + Calc)"],
  [/^Eigen 3\.4\.0/, "Eigen 3.4.0"],
  [/^Wikidata chemical names/, "Wikidata chemical dictionary (2026-10-27)"],
  [/^MSV msv-core and xsdlib/, "MSV msv-core and xsdlib (2022.7)"]
];

function inventoryExclusion(row: InventoryRow): string | undefined {
  if (/development|build dependency/i.test(row.scope) && !/runtime/i.test(row.scope) && row.name !== "Eigen 3.4.0") return "Development or build tooling";
  if (/not bundled|not core|user-installed|host-managed|optional runtime|optional installer|optional model/i.test(row.scope)) return "Distributed separately";
  return undefined;
}

export function buildAboutProvenance(): AboutProvenance & {
  inventoryCoverage: Map<string, string>;
  noticeCoverage: Map<string, string>;
  npmCoverage: Map<string, string>;
  libraries: LibraryRef[];
} {
  const inventory = readInventoryRows(readAboutSource(inventoryPath));
  const notice = readAboutSource("NOTICE");
  const npm = runtimePackages();
  const npmNames = [...npm.keys()];
  const cargo = new Map<string, Set<string>>();
  const cargoLock = readAboutSource("apps/desktop/src-tauri/Cargo.lock");
  for (const match of cargoLock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)) {
    addVersion(cargo, match[1]!, match[2]!);
  }
  const nativeDependencies = cargoLock.match(/\nname = "chemdraft"\nversion = "[^"]+"\ndependencies = \[\n([\s\S]+?)\n\]/)?.[1];
  if (!nativeDependencies) throw new Error("Missing ChemDraft desktop dependency list in Cargo.lock");
  const nativeNames = new Set([...nativeDependencies.matchAll(/"([^" ]+)(?: ([^"]+))?"/g)].map(match => {
    const [, name, version] = match;
    if (version) cargo.set(name!, new Set([version]));
    return name!;
  }));
  for (const match of readAboutSource("pnpm-lock.yaml").split("\nsnapshots:")[0]!.matchAll(/^ {2}'?([^'\s]+)@(\d[^':\s]*)'?:$/gm)) {
    // Resolve documented transitive packages too, without confusing them with direct
    // dependencies or picking a second importer's version for a direct dependency.
    if (!npmNames.includes(match[1]!) && !nativeNames.has(match[1]!)) addVersion(npm, match[1]!, match[2]!);
  }
  const inventoryCoverage = new Map<string, string>();
  const components = new Map<string, AboutComponent>();
  const libraryRefs = new Map<string, LibraryRef[]>();
  const noticeHolders = new Map<string, string[]>();
  const npmCoverage = new Map<string, string>();
  for (const row of inventory) {
    const exclusion = inventoryExclusion(row);
    if (exclusion) {
      inventoryCoverage.set(row.name, exclusion);
      continue;
    }
    const { component, libraries } = componentFromInventory(row, npm, cargo);
    components.set(row.name, component);
    libraryRefs.set(component.name, libraries);
    inventoryCoverage.set(row.name, component.name);
    for (const dependency of npmNames) {
      if (row.name.split(/ [+\/] /).some(part => part === dependency || part.startsWith(dependency + " "))) {
        npmCoverage.set(dependency, component.name);
      }
    }
  }
  const missing = npmNames.filter(name => !npmCoverage.has(name));
  if (missing.length) throw new Error("Add purpose and licensing to the dependency inventory for: " + missing.join(", "));

  for (const name of nativeNames) {
    const row = inventory.find(row => row.name.split(/ [+\/] /).some(part => part === name || part.startsWith(name + " ")));
    if (!row) throw new Error("Add purpose and licensing to the dependency inventory for native dependency: " + name);
  }

  const noticeCoverage = new Map<string, string>();
  for (const { heading, body } of readNoticeRows(notice)) {
    if (/^(?:Network transport and diagnostics|Naming engine\b)/.test(heading)) {
      noticeCoverage.set(heading, "Group heading");
      continue;
    }
    if (heading.includes("Intel Mac naming engine") ||
      /^(?:MolScribe|uv$|PyTorch|Orthonym |RDKit 2026\.3\.5|JPype1|lxml|NumPy|Pillow|packaging|CPython|centres)\b/.test(heading)) {
      noticeCoverage.set(heading, "Downloaded separately");
      continue;
    }
    if (heading.startsWith("IUPAC Dissociation-Constants")) {
      noticeCoverage.set(heading, "Unused by the shipped model");
      continue;
    }
    const trainingSet = body.match(/^(https:\/\/\S+) -- (.+)$/);
    if (trainingSet) {
      const license = trainingSet[2]!.split(",")[0]!;
      components.set(heading, {
        name: heading,
        version: "Snapshot used to train the shipped pKa model",
        license: heading.startsWith("Dwar-iBond") ? "No published data license; redistributed with attribution by owner decision" : license,
        holders: [SEE_LICENSE],
        purpose: "Training data for the shipped pKa model. See NOTICE for provenance and attribution.",
        sourceUrl: trainingSet[1]!
      });
      noticeCoverage.set(heading, heading);
      continue;
    }
    const key = noticeAliases.find(([pattern]) => pattern.test(heading))?.[1]
      ?? heading.replace(/ \((?:woodstox-core |stax2-api )?(\d[^)]*)\)$/, " ($1)");
    const component = components.get(key) ?? [...components.values()].find(component => component.name.startsWith(key + " "));
    if (!component) throw new Error("Missing About attribution for NOTICE entry: " + heading);
    noticeCoverage.set(heading, component.name);
    // The heading and the entry's first paragraph carry its curated copyright statement.
    const statements = noticeStatements(heading + " " + body.trimStart().split(/\n\s*\n/)[0]!);
    if (statements.length) noticeHolders.set(component.name, [...(noticeHolders.get(component.name) ?? []), ...statements]);
    const licensePath = body.match(/Full licen[cs]e text: ([\w./-]+)/)?.[1];
    if (licensePath) component.licenseText ??= licensePath;
    const source = body.match(/(?:^|\n) {2}Source: (https:\/\/[^\s,;)]+)/)?.[1];
    if (source) component.sourceUrl = source.replace(/\.$/, "");
  }
  for (const component of components.values()) {
    component.holders = resolveHolders(noticeHolders.get(component.name) ?? [], libraryRefs.get(component.name) ?? []);
    component.platforms = resolvePlatforms(libraryRefs.get(component.name) ?? []);
  }
  const licensePaths = new Set(["LICENSE", ...[...components.values()].flatMap(c => c.licenseText ? [c.licenseText] : [])]);
  const licenseTexts = Object.fromEntries([...licensePaths].map(path => [path, readAboutSource(path)]));
  return {
    components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
    licenseTexts, inventoryCoverage, noticeCoverage, npmCoverage,
    libraries: [...libraryRefs.values()].flat()
  };
}
