// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis,
// licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modified for ChemDraft: self-contained English names, Node/JSON queries, existing RDKit and OPSIN,
// explicit portable word-list input, deterministic ordering/gzip, and importable filtering for tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENT = "ChemDraftNameDictionaryBuilder/1.0 (https://github.com/jgassens/ChemDraft; offline chemical name dictionary)";
const ENDPOINT = "https://query.wikidata.org/sparql";
export const WIKIS = ["en", "de", "fr", "ja", "es", "it", "ru", "zh", "pl", "nl"];
const KEY = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = values => [...new Set(values)].sort(compare);
export const nameKey = name => name.toLowerCase().replace(/[\s‐-―'’ʼ-]/g, "").replace(/[.•∙⋅]/g, "·");
const qid = uri => /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(uri)?.[1];
const byId = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const PREFIXES = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n`;

export const idsQuery = wiki => PREFIXES + `SELECT DISTINCT ?item WHERE {
  { ?item wdt:P233 ?s } UNION { ?item wdt:P2017 ?s }
  ?a schema:about ?item ; schema:isPartOf <https://${wiki}.wikipedia.org/> .
} ORDER BY ?item`;
export const detailsQuery = ids => PREFIXES + `SELECT ?item ?kind ?v WHERE {
  VALUES ?item { ${ids.map(id => `wd:${id}`).join(" ")} }
  { ?item rdfs:label ?v . FILTER(LANG(?v) = "en") BIND("l" AS ?kind) }
  UNION { ?item skos:altLabel ?v . FILTER(LANG(?v) = "en") BIND("a" AS ?kind) }
  UNION { { ?item rdfs:label ?v } UNION { ?item skos:altLabel ?v }
    FILTER(LANG(?v) = "de") BIND("g" AS ?kind) }
  UNION { ?item wdt:P233 ?v . BIND("c" AS ?kind) }
  UNION { ?item wdt:P2017 ?v . BIND("i" AS ?kind) }
  UNION { ?item wdt:P231 ?v . BIND("r" AS ?kind) }
  UNION { ?item wdt:P235 ?v . BIND("k" AS ?kind) }
} ORDER BY ?item ?kind ?v`;
export const brandsQuery = PREFIXES + `SELECT ?brand ?label ?ingredient WHERE {
  ?brand wdt:P3781 ?ingredient ; rdfs:label ?label . FILTER(LANG(?label) = "en")
} ORDER BY ?brand ?ingredient ?label`;

/** The fixture and the endpoint use the same SPARQL Results JSON bindings. */
export function collectItems(details, brandResults = { results: { bindings: [] } }) {
  const items = new Map();
  const fields = { l: "labels", a: "aliases", g: "german", c: "canonical", i: "isomeric", r: "cas", k: "keys" };
  for (const row of details.results.bindings) {
    const id = qid(row.item?.value ?? ""), field = fields[row.kind?.value], value = row.v?.value;
    if (!id || !field || !value) continue;
    const item = items.get(id) ?? { id, labels: [], aliases: [], german: [], canonical: [], isomeric: [], cas: [], keys: [] };
    items.set(id, item);
    item[field].push(value);
  }
  const brands = new Map();
  for (const row of brandResults.results.bindings) {
    const id = qid(row.brand?.value ?? ""), ingredient = qid(row.ingredient?.value ?? "");
    if (!id || !ingredient || !row.label?.value) continue;
    const brand = brands.get(id) ?? { labels: new Set(), ingredients: new Set() };
    brands.set(id, brand);
    brand.labels.add(row.label.value);
    brand.ingredients.add(ingredient);
  }
  for (const brand of brands.values()) {
    if (brand.ingredients.size !== 1) continue;
    const item = items.get([...brand.ingredients][0]);
    if (item) item.aliases.push(...brand.labels);
  }
  return [...items.values()].sort(byId);
}

const ELEMENTS = new Set(("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" "));
const GREEK = { α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", κ: "kappa", λ: "lambda", μ: "mu", ω: "omega" };
const UMLAUT = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };
function looksLikeSmiles(text) {
  const smiles = s => /^(?:Cl|Br|[BCNOPSFI]|[bcnops]|\[[^\][]{1,40}\]|%\d\d|[-=#$:/\\.()0-9*~>])+$/.test(s)
    && /[A-Za-z]/.test(s) && (!/[bcnops]/.test(s.replace(/\[[^\]]*\]/g, "")) || /\d/.test(s.replace(/\[[^\]]*\]/g, "")));
  const t = text.trim().replace(/\s+\|[^|]*\|$/, ""), first = t.split(/\s/)[0];
  return /^InChI=1S?\//.test(t) || smiles(t) || (first !== t && smiles(first) && /[\d()[\]=#/\\]/.test(first));
}
export function usableNames(raw) {
  // Reject protocol delimiters before collapsing whitespace.
  if (/[\t\r\n]/.test(raw)) return [];
  const s = raw.replace(/[®™]/g, "").replace(/−/g, "-").replace(/\s+/g, " ").trim();
  const formulaText = s.replace(/[·.]/g, "");
  const formula = /^(?:[A-Z][a-z]?\d*)+$/.test(formulaText)
    && [...formulaText.matchAll(/[A-Z][a-z]?/g)].every(([e]) => ELEMENTS.has(e));
  if (s.length < 3 || s.length > 80 || formula || looksLikeSmiles(s) || /^InChI=/i.test(s) || KEY.test(s)) return [];
  if (/^\d{2,7}-\d\d-\d$/.test(s) || /^\d{3}-\d{3}-\d$/.test(s) || /^\d[\d\s.,-]*$/.test(s)
    || (/^[A-Z0-9]{10}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s))) return [];
  if (/[<>{}|\\!]|https?:|[₀-₉⁰-⁹¹²³]/.test(s) || /^\d+[A-Z][a-z]?$/.test(s) || /^[A-Z][a-z]?\d*[+-]+$/.test(s)) return [];
  const spelt = s.replace(/[αβγδεκλμω]/g, g => GREEK[g]);
  return [...new Set([s, spelt, spelt.replace(/[äöüÄÖÜß]/g, u => UMLAUT[u])])];
}
export function casValid(s) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(s);
  return !!m && [...m[1] + m[2]].reverse().reduce((sum, d, i) => sum + Number(d) * (i + 1), 0) % 10 === Number(m[3]);
}
export function risky(name, words) {
  const lower = name.toLowerCase(), last = lower.split(" ").at(-1);
  return name.length <= 5 || (/^[A-Z0-9-]+$/.test(name) && name.length <= 8)
    || (/^[a-z ]+$/.test(lower) && (words.has(lower) || (last.endsWith("s")
      && (words.has(last.slice(0, -1)) || (last.endsWith("ies") && words.has(`${last.slice(0, -3)}y`))))));
}

export function parseRows(text) {
  return text.trimEnd().split("\n").filter(Boolean).map((line, i) => {
    const [smiles, names, cas, key, suggest = ""] = line.split("\t");
    if (!smiles || !KEY.test(key ?? "")) throw new Error(`Invalid baseline row ${i + 1}`);
    return { id: `Q${900000000000 + i}`, smiles, key, names: names ? names.split("|") : [],
      cas: cas ? cas.split("|") : [], suggest: suggest ? suggest.split("|") : [] };
  });
}

// Conservative: even a source label containing a stereo/epimer descriptor needs
// independent structure evidence. Include German sugar stems and Greek glyphs.
export const hasStereoDescriptor = name => /(?:[αβ]|alpha|beta|gluco|gluko|galacto|galakto|manno|allo|altro|gulo|ido|talo|\b[dl][-‐-―\s]|(?:^|[\s([,\d])[RS](?=$|[\s)\],-]))/i.test(name);
const samePubchemIdentity = (a, b) => KEY.test(a ?? "") && KEY.test(b ?? "") && a.slice(0, 25) === b.slice(0, 25);

/** A new exact name must have positive evidence; an available contradiction vetoes it. */
export async function nameAccuracy(name, entry, { keyOf, opsinSmiles, pubchem, pubchemAvailable = () => true }, ownLabel = false, evidence = {}) {
  const read = opsinSmiles(name), opsinKey = read && keyOf(read);
  Object.assign(evidence, { ownLabel, stereoDescriptor: hasStereoDescriptor(name), opsinKey });
  if (opsinKey && opsinKey !== entry.key) return "contradicted";
  // In offline mode, absence is known before requesting. Never turn an attempted
  // request's missing cache file into a PubChem 404. No request is made here if absent.
  evidence.pubchemAvailable = pubchemAvailable(name);
  const answer = evidence.pubchemAvailable ? await pubchem(name) : undefined;
  evidence.pubchemKey = answer?.key;
  if (answer && !samePubchemIdentity(answer.key, entry.key)) return "contradicted";
  if (ownLabel && !hasStereoDescriptor(name)) return "label";
  if (opsinKey === entry.key) return "opsin";
  if (answer && samePubchemIdentity(answer.key, entry.key)) return "pubchem";
  return "unverifiable";
}

/** No IO: engines, baseline and the cached PubChem referee are supplied by the caller. */
export async function buildRows(items, { keyOf, opsinSmiles, pubchem, baseline = [],
  pubchemAvailable = () => true, audit = {} }) {
  const entries = [];
  const prior = new Map(baseline.map(e => [e.key, e]));
  const priorNames = new Map(baseline.map(e => [e.key, new Set([...e.names, ...e.suggest].map(n => nameKey(n.replace(/^!/, ""))))]));
  const priorSmiles = new Map(baseline.map(e => [e.smiles, e]));
  audit.accuracy = { label: 0, opsin: 0, pubchem: 0, unverifiable: 0, contradicted: 0 };
  audit.nameDecisions = [];
  audit.structures = [];
  for (const item of [...items].sort(byId)) {
    const source = [...unique(item.isomeric), ...unique(item.canonical)].map(s => s.trim());
    const tried = source
      .filter(s => s && s.length <= 2000 && !/\s/.test(s)).map(s => ({ s, key: keyOf(s) })).filter(t => t.key);
    const wanted = item.keys.filter(k => KEY.test(k));
    let pick = wanted.length ? tried.find(t => wanted.includes(t.key))
      ?? tried.find(t => wanted.some(k => k.slice(0, 14) === t.key.slice(0, 14)))
      : new Set(tried.map(t => t.key.slice(0, 14))).size === 1 ? tried[0] : undefined;
    audit.structures.push({ id: item.id, source, wanted, tried, selected: pick?.key });
    // An engine substitution must not rewrite the historical representation or
    // erase salts, unusual valences, bridged boranes, complexes or stereo. Reuse
    // the exact legacy SMILES+key pair only when those exact source bytes recur.
    const legacy = source.map(s => priorSmiles.get(s)).find(e => e && (!wanted.length || wanted.includes(e.key)));
    if (legacy && pick?.key !== legacy.key) pick = { s: legacy.smiles, key: legacy.key };
    if (!pick) continue;
    const e = { id: item.id, smiles: prior.get(pick.key)?.smiles ?? pick.s, key: pick.key, names: [], cas: unique(item.cas.filter(casValid)), suggest: [],
      ownLabels: (!wanted.length || wanted.includes(pick.key)) ? [...item.labels, ...(item.germanLabels ?? [])].flatMap(usableNames) : [] };
    entries.push(e);
    // The cached German query combines labels and aliases. Do not guess which
    // German name was a label: without separate provenance it must pass OPSIN/PC.
    const english = unique([...item.labels, ...item.aliases].flatMap(usableNames));
    e.names.push(...english);
    const seen = new Set(english.map(nameKey));
    for (const name of unique(item.german.flatMap(usableNames))) {
      const k = nameKey(name);
      if (seen.has(k)) continue;
      seen.add(k);
      const read = opsinSmiles(name);
      if (read) e.suggest.push(name);
      else e.names.push(name);
    }
  }
  // Preserve historical rows, CAS and both name columns verbatim before applying
  // collision checks. Grandfathering is per full identity, never connectivity.
  for (const e of baseline) entries.push({ ...e, names: [...e.names], cas: [...e.cas], suggest: [...e.suggest] });
  const decisions = new Map();
  const labelsByKey = new Map();
  for (const e of entries) {
    const labels = labelsByKey.get(e.key) ?? new Set();
    for (const name of e.ownLabels ?? []) labels.add(name);
    labelsByKey.set(e.key, labels);
  }
  for (const e of entries) for (const field of ["names", "suggest"]) {
    const kept = [];
    for (const raw of e[field]) {
      const name = raw.replace(/^!/, "");
      if (priorNames.get(e.key)?.has(nameKey(name))) { kept.push(raw); continue; }
      const decisionKey = `${e.key}\t${name}`;
      let decision = decisions.get(decisionKey);
      if (!decision) {
        const evidence = {};
        decision = await nameAccuracy(name, e, { keyOf, opsinSmiles, pubchem, pubchemAvailable }, labelsByKey.get(e.key)?.has(name), evidence);
        decisions.set(decisionKey, decision);
        audit.accuracy[decision]++;
        audit.nameDecisions.push({ key: e.key, name, decision, ...evidence });
      }
      if (["label", "opsin", "pubchem"].includes(decision)) kept.push(raw);
    }
    e[field] = kept;
  }
  // Apply collision checks to BOTH exact-name columns. New collisions require
  // matching connectivity AND stereo. Existing unique ownership is preserved.
  for (const field of ["names", "cas"]) {
    const index = new Map();
    for (const e of entries) for (const name of field === "names" ? [...e.names, ...e.suggest] : e.cas) {
      const k = field === "names" ? nameKey(name.replace(/^!/, "")) : name;
      const set = index.get(k) ?? new Set(); set.add(e); index.set(k, set);
    }
    for (const [k, set] of [...index].sort(([a], [b]) => compare(a, b))) {
      const options = [...set].sort(byId);
      if (new Set(options.map(e => e.key)).size <= 1) continue;
      const name = field === "names" ? [...options[0].names, ...options[0].suggest].find(n => nameKey(n.replace(/^!/, "")) === k) : k;
      // Use the index key for removal, not a display spelling's case or punctuation.
      const historical = options.filter(e => field === "names" ? priorNames.get(e.key)?.has(k) : prior.get(e.key)?.cas.includes(k));
      const historicalKeys = new Set(historical.map(e => e.key));
      const answer = historicalKeys.size === 1 || !pubchemAvailable(name.replace(/^!/, "")) ? undefined : await pubchem(name.replace(/^!/, ""));
      const winner = historicalKeys.size === 1 ? historical[0]
        : answer && options.find(e => field === "names" ? samePubchemIdentity(e.key, answer.key) : e.key === answer.key);
      for (const e of options) if (e.key !== winner?.key) {
        if (field === "names") {
          e.names = e.names.filter(n => nameKey(n.replace(/^!/, "")) !== k);
          e.suggest = e.suggest.filter(n => nameKey(n) !== k);
        } else e.cas = e.cas.filter(c => c !== k);
      }
    }
  }
  const merged = new Map();
  for (const e of entries) {
    const same = merged.get(e.key);
    if (same) for (const field of ["names", "cas", "suggest"]) same[field].push(...e[field]);
    else merged.set(e.key, e);
  }
  return [...merged.values()].sort(byId).map(e => ({ ...e, names: unique(e.names), cas: unique(e.cas), suggest: unique(e.suggest) }));
}
export const serializeRows = rows => rows.map(e => [e.smiles, e.names.join("|"), e.cas.join("|"), e.key, e.suggest.join("|")].join("\t")).join("\n") + "\n";
// Node gzip has a zero mtime and no filename; pin the OS byte as well for cross-host reproducibility.
export function compressRows(rows) { const bytes = gzipSync(serializeRows(rows), { level: 9 }); bytes[9] = 255; return bytes; }

export function searchableNames(rows, fields = ["names", "suggest"]) {
  const index = new Map(), ambiguous = new Set();
  for (const e of rows) for (const field of fields) for (const name of e[field]) {
    const k = nameKey(name.replace(/^!/, ""));
    if (index.has(k) && index.get(k) !== e.key) ambiguous.add(k);
    else index.set(k, e.key);
  }
  for (const k of ambiguous) index.delete(k);
  return index;
}

export function snapshotCounts(rows, baseline) {
  const keys = new Set(rows.map(e => e.key)), oldKeys = new Set(baseline.map(e => e.key));
  const cas = new Set(rows.flatMap(e => e.cas)), oldCas = new Set(baseline.flatMap(e => e.cas));
  const names = searchableNames(rows), oldNames = searchableNames(baseline);
  const oldColumn2 = new Set(baseline.flatMap(e => e.names.map(n => nameKey(n.replace(/^!/, "")))));
  const oldColumn5 = new Set(baseline.flatMap(e => e.suggest.map(nameKey)));
  const oldAny = new Set(baseline.flatMap(e => [...e.names, ...e.suggest].map(n => nameKey(n.replace(/^!/, "")))));
  const newlySearchable = [...names.keys()].filter(k => !oldColumn2.has(k));
  const assignments = new Map(rows.map(e => [e.key, new Set(e.cas)]));
  return { compounds: rows.length, names: rows.reduce((n, e) => n + e.names.length, 0),
    cas: rows.reduce((n, e) => n + e.cas.length, 0), column5Names: rows.reduce((n, e) => n + e.suggest.length, 0),
    compoundsLost: [...oldKeys].filter(k => !keys.has(k)), compoundsGained: [...keys].filter(k => !oldKeys.has(k)).length,
    casLost: [...oldCas].filter(c => !cas.has(c)),
    casAssignmentsLost: baseline.flatMap(e => e.cas.filter(c => !assignments.get(e.key)?.has(c)).map(c => ({ key: e.key, cas: c }))),
    searchableNames: names.size, oldColumn2DistinctNames: oldColumn2.size,
    oldColumn2UnambiguousNames: searchableNames(baseline, ["names"]).size, oldBothColumnsSearchable: oldNames.size,
    newlySearchableVsOldColumn2: { total: newlySearchable.length,
      oldColumn5Only: newlySearchable.filter(k => oldColumn5.has(k)).length,
      absentFromOldFile: newlySearchable.filter(k => !oldAny.has(k)).length },
    newlySearchableVsOldBothColumns: [...names.keys()].filter(k => !oldNames.has(k)).length,
    searchableNamesLost: [...oldNames.keys()].filter(k => !names.has(k)).length };
}

const pause = ms => new Promise(done => setTimeout(done, ms));
export const cacheFile = (cache, category, key) => join(cache, `${category}-${createHash("sha256").update(key).digest("hex")}.json`);
export async function cachedJson(cache, category, request, offline = false) {
  const file = cacheFile(cache, category, request.key);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (offline) throw new Error(`Offline cache miss: ${category} ${JSON.stringify(request.key)} (${file})`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(request.url, { ...request.options, signal: AbortSignal.timeout(120_000) });
      if (response.status === 404 && category === "pubchem") { writeFileSync(file, "{}"); return {}; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (category === "wikidata" && !Array.isArray(json.results?.bindings)) throw new Error("invalid SPARQL Results JSON");
      writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (error) {
      if (attempt === 4) throw new Error(`${category} request failed: ${error.message}`);
      await pause(5000 * attempt);
    }
  }
}
export async function loadChemistry() {
  // Reuse the repository's committed engine; no package install or native build is needed.
  const glue = new URL("../packages/rdkit-adapter/vendor/RDKit_minimal.js", import.meta.url);
  const wasm = new URL("../packages/rdkit-adapter/vendor/RDKit_minimal.wasm", import.meta.url);
  const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(createRequire(import.meta.url), dirname(fileURLToPath(glue)));
  const rdkit = await factory({ wasmBinary: new Uint8Array(readFileSync(wasm)), locateFile: () => fileURLToPath(wasm) });
  const cache = new Map();
  const diagnose = smiles => {
    if (cache.has(smiles)) return cache.get(smiles);
    let mol, key, reason, inchi;
    try {
      mol = rdkit.get_mol(smiles);
      if (!mol) reason = "RDKit rejects SMILES during parsing/sanitization";
      else {
        inchi = mol.get_inchi();
        key = inchi && rdkit.get_inchikey_for_inchi(inchi) || undefined;
        if (!key) reason = "RDKit parses SMILES but InChI/InChIKey generation fails";
      }
    }
    catch (error) { reason = `RDKit ${mol ? "InChI generation" : "parsing/sanitization"} failed: ${error.message}`; }
    finally { mol?.delete(); }
    const result = { key, reason, inchi }; cache.set(smiles, result); return result;
  };
  const keyOf = smiles => diagnose(smiles).key;
  keyOf.diagnose = diagnose;
  return keyOf;
}
export async function readOpsin(names, java) {
  if (!names.length) return new Map();
  const jar = join(ROOT, "apps", "desktop", "src-tauri", "resources", "opsin", "opsin-cli-2.9.0.jar");
  return new Promise((done, reject) => {
    const child = spawn(java, ["-jar", jar, "-o", "smi", "-n"], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, JAVA_TOOL_OPTIONS: undefined, _JAVA_OPTIONS: undefined, JDK_JAVA_OPTIONS: undefined } });
    const out = [], err = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("OPSIN build filtering timed out")); }, 600_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", data => out.push(data)); child.stderr.on("data", data => err.push(data));
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`OPSIN build filtering failed (${code}): ${Buffer.concat(err).toString().slice(-2000)}`));
      const lines = Buffer.concat(out).toString("utf8").replace(/\r/g, "").split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length !== names.length) return reject(new Error("OPSIN build filtering returned the wrong number of lines"));
      done(new Map(names.map((name, i) => [name, lines[i].split("\t")[0] || undefined])));
    });
    child.stdin.end(names.join("\n") + "\n");
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") options.dryRun = true;
    else if (args[i] === "--offline") options.offline = true;
    else if (["--cache", "--words", "--java", "--out", "--baseline", "--report"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) options[args[i].slice(2)] = args[++i];
    else throw new Error("Usage: node scripts/build-name-dictionary.mjs --cache <directory> --words <English word-list> --out <candidate gzip> [--baseline <gzip>] [--report <json>] [--java <executable>] [--offline] [--dry-run]");
  }
  if (options.dryRun) {
    console.log(WIKIS.map(idsQuery).join("\n\n") + "\n\n# Details query repeats in batches of 1,000 selected QIDs:\n"
      + detailsQuery(["Q18216"]) + "\n\n" + brandsQuery);
    return;
  }
  if (!options.cache || !options.words) throw new Error("Provide --cache and --words (a UTF-8 English word-list, one word per line). No system-specific word-list is assumed.");
  if (!options.out) throw new Error("Provide --out to stage a candidate separately from the committed baseline.");
  const baselinePath = resolve(options.baseline ?? join(ROOT, "data", "names", "dictionary.tsv.gz"));
  const out = resolve(options.out);
  if (out === baselinePath || out === join(ROOT, "data", "names", "dictionary.tsv.gz")) throw new Error("Candidate output must not replace the committed dictionary or its baseline.");
  const baseline = parseRows(gunzipSync(readFileSync(baselinePath)).toString("utf8"));
  const cache = resolve(options.cache); mkdirSync(cache, { recursive: true });
  const wordsText = readFileSync(resolve(options.words), "utf8");
  console.error(`English word-list SHA-256: ${createHash("sha256").update(wordsText).digest("hex")}`);
  const sparql = query => cachedJson(cache, "wikidata", { key: query, url: ENDPOINT, options: {
    method: "POST", headers: { "User-Agent": AGENT, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query }).toString()
  } }, options.offline);
  const ids = new Set();
  for (const wiki of WIKIS) {
    // Fail rather than silently produce a smaller snapshot when a Wikipedia times out.
    const json = await sparql(idsQuery(wiki));
    for (const row of json.results.bindings) { const id = qid(row.item?.value ?? ""); if (id) ids.add(id); }
    console.error(`${wiki}: ${ids.size} compounds in all`);
  }
  const all = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), bindings = [];
  for (let offset = 0; offset < all.length; offset += 1000) {
    bindings.push(...(await sparql(detailsQuery(all.slice(offset, offset + 1000)))).results.bindings);
    console.error(`Wikidata details: ${Math.min(offset + 1000, all.length)}/${all.length}`);
  }
  const items = collectItems({ results: { bindings } }, await sparql(brandsQuery));
  const keyOf = await loadChemistry();
  const bundledJava = join(ROOT, "apps", "desktop", "src-tauri", "resources", "opsin", "jre", "bin", process.platform === "win32" ? "java.exe" : "java");
  console.error("Reading English and German candidate names with OPSIN...");
  const readings = await readOpsin(unique(items.flatMap(it => [...it.labels, ...it.aliases, ...it.german].flatMap(usableNames))), options.java ?? (existsSync(bundledJava) ? bundledJava : "java"));
  let lastAsk = 0;
  const pubchem = async text => {
    if (!existsSync(cacheFile(cache, "pubchem", text)) && !options.offline) {
      const wait = Math.max(0, lastAsk + 220 - Date.now()); if (wait) await pause(wait); lastAsk = Date.now();
    }
    const json = await cachedJson(cache, "pubchem", { key: text,
      url: "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/property/InChIKey,SMILES/JSON",
      options: { method: "POST", headers: { "User-Agent": AGENT, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: text }).toString() } }, options.offline);
    const first = json.PropertyTable?.Properties?.[0];
    return first?.InChIKey && first.SMILES ? { key: first.InChIKey, smiles: first.SMILES } : undefined;
  };
  const unavailable = new Set();
  const pubchemAvailable = name => {
    if (!options.offline || existsSync(cacheFile(cache, "pubchem", name))) return true;
    unavailable.add(name); return false;
  };
  const audit = {};
  const rows = await buildRows(items, { keyOf, opsinSmiles: name => readings.get(name), pubchem, pubchemAvailable, baseline, audit });
  const counts = snapshotCounts(rows, baseline);
  audit.legacyRestorations = baseline.filter(e => !audit.structures.some(it => it.selected === e.key)).map(e => {
    const sources = audit.structures.filter(it => it.wanted.includes(e.key) || it.source.includes(e.smiles));
    const diagnosis = keyOf.diagnose(e.smiles);
    const category = !sources.length ? "absentFromSelection" : diagnosis.reason ? (diagnosis.key ? "engineFailure" : diagnosis.reason.includes("InChI") ? "inchiFailure" : "parseFailure")
      : diagnosis.key !== e.key ? "differentEngineKey" : "sourceSelection";
    const reason = !sources.length ? "Absent from cached SMILES+Wikipedia selection; item deletion is not established"
      : diagnosis.reason ?? (diagnosis.key !== e.key ? `RDKit computes ${diagnosis.key} for the unchanged legacy SMILES`
        : sources.some(it => it.tried.some(t => t.key === e.key))
          ? `Source ordering/key preference chooses ${unique(sources.map(it => it.selected).filter(Boolean)).join(", ")} instead of the available legacy identity`
          : `Cached source candidates no longer compute the legacy key: ${unique(sources.flatMap(it => it.tried.map(t => t.key))).join(", ")}`);
    return { key: e.key, smiles: e.smiles, names: e.names, cas: e.cas, sourceIds: sources.map(it => it.id),
      category, reason,
      rdkit: diagnosis, cachedSources: sources, action: "preserved exact baseline row; no chemical rewrite" };
  });
  // Every old compound and CAS assignment must survive. A future deliberate removal
  // needs a reviewed, explicit exception rather than silently shortening the file.
  if (counts.compoundsLost.length || counts.casAssignmentsLost.length || counts.searchableNamesLost) throw new Error(`Baseline coverage regression: ${JSON.stringify(counts)}`);
  const bytes = compressRows(rows); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, bytes);
  const summary = { ...counts, accuracyGate: audit.accuracy, legacyRestorations: audit.legacyRestorations.length,
    uncachedPubchemEvidence: unavailable.size, gzipBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const report = resolve(options.report ?? `${out}.report.json`);
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ summary, ...audit, uncachedPubchemEvidence: unique([...unavailable]) }, null, 2) + "\n");
  console.error(`Offline evidence unavailable for ${unavailable.size} names; no requests made for those names. See ${report}`);
  console.error(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
