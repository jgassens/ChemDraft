// Offline, read-only audit. stdout contains counts only; engine diagnostics and
// OPSIN errors are never forwarded because they can contain dictionary entries.
// Run: node scripts/audit-name-dictionary-stereo.mjs [--java <executable>]
//      [--dictionary <gzip>] [--no-opsin]
// No-stereo counts include partially missing name-asserted stereo and uncheckable
// names whose bound structure has no relevant RDKit-assigned stereo at all.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { geometricStereoDescriptors, normalizeNameDashes, loadRDKit, parseRows, readOpsin } from "./build-name-dictionary.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const pair = (a, b) => [a, b].sort((x, y) => x - y).join(",");
const assigned = code => code && code !== "(?)";
const cleanName = name => name.replace(/^!/, "");
export const geometricNames = row => [...new Set([...row.names, ...row.suggest].map(cleanName))]
  .filter(name => geometricStereoDescriptors(name).length > 0);
// Do not relax a name that also specifies absolute tetrahedral stereochemistry.
const absoluteStereoDescriptor = /(?:[αβ]|alpha|beta|\b[dl][-\s]|(?:^|[\s([,\d-])[RS](?=$|[\s)\],-]))/i;

/** Own and release every engine object; no chemical data is logged. */
export function describeStructure(rdkit, smiles) {
  let mol, plain;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol) return undefined;
    const canonical = mol.get_smiles();
    // Strip only stereo syntax, retaining isotopes, charges, components and bond
    // orders. RDKit canonicalizes this comparison structure, never a replacement.
    plain = rdkit.get_mol(canonical.replace(/[@/\\]/g, ""));
    if (!plain) return undefined;
    const tags = JSON.parse(mol.get_stereo_tags());
    const atomStereo = new Map((tags.CIP_atoms ?? []).filter(([, code]) => assigned(code)));
    const bondStereo = new Map((tags.CIP_bonds ?? []).filter(([, , code]) => assigned(code))
      .map(([a, b, code]) => [pair(a, b), code]));
    return { canonical, constitution: plain.get_smiles(), atomStereo, bondStereo,
      graph: JSON.parse(mol.get_json()).molecules[0] };
  } catch { return undefined; }
  finally { plain?.delete(); mol?.delete(); }
}

/** Compare only stereo actually asserted by OPSIN; extra bound stereo is allowed. */
export function compareOpsin(rdkit, boundSmiles, expectedSmiles, { relativeOnly = false } = {}) {
  const bound = describeStructure(rdkit, boundSmiles), expected = describeStructure(rdkit, expectedSmiles);
  if (!bound || !expected || (!expected.atomStereo.size && !expected.bondStereo.size)) return "notCheckable";
  const configurations = [expected];
  if (relativeOnly && expected.atomStereo.size) {
    // A two-centre ring cis/trans assertion permits either enantiomer. Reversing
    // every tetrahedral SMILES tag constructs its full mirror, retaining E/Z,
    // constitution, isotopes and charges. Never flip individual centres to fit.
    // More complex relative systems need a richer contract; decline them here.
    const centres = [...expected.atomStereo.keys()];
    const rings = expected.graph.extensions?.find(e => e.name === "rdkitRepresentation")?.atomRings ?? [];
    if (centres.length !== 2 || !rings.some(ring => centres.every(atom => ring.includes(atom)))) return "notCheckable";
    const mirror = describeStructure(rdkit, expectedSmiles.replace(/@@?/g, tag => tag === "@" ? "@@" : "@"));
    if (!mirror || mirror.constitution !== expected.constitution) return "notCheckable";
    configurations.push(mirror);
  }
  if (bound.canonical === expected.canonical) return "correctIsomer";
  // A different constitution/charge/isotope is not evidence of an isomer error.
  if (bound.constitution !== expected.constitution) return "notCheckable";
  let target, query;
  try {
    target = rdkit.get_mol(boundSmiles); query = rdkit.get_mol(expectedSmiles);
    const matches = JSON.parse(target.get_substruct_matches(query,
      JSON.stringify({ useChirality: false, uniquify: false, maxMatches: 1001 })));
    let missingOnly = false;
    for (const { atoms } of matches) {
      for (const configuration of configurations) {
        let missing = false, wrong = false;
        const check = (wanted, actual) => { if (!actual) missing = true; else if (actual !== wanted) wrong = true; };
        for (const [atom, code] of configuration.atomStereo) check(code, bound.atomStereo.get(atoms[atom]));
        for (const [bond, code] of configuration.bondStereo) {
          const [a, b] = bond.split(",").map(Number);
          check(code, bound.bondStereo.get(pair(atoms[a], atoms[b])));
        }
        if (!wrong && !missing) return "correctIsomer";
        if (!wrong && missing) missingOnly = true;
      }
    }
    // An exhausted match budget cannot prove absence of a compatible mapping.
    if (!matches.length || matches.length >= 1001) return "notCheckable";
    return missingOnly ? "noStereo" : "wrongIsomer";
  } catch { return "notCheckable"; }
  finally { query?.delete(); target?.delete(); }
}

/** Deliberately narrow fallback: unbranched, neutral, acyclic hydrocarbon alkenes.
 * Never infer cis=Z/trans=E for substituted, cyclic or coordination compounds.
 * Numeric name locants map to both possible directions of the RDKit carbon path.
 */
export function compareSimpleAlkene(name, bound) {
  if (!bound) return "notCheckable";
  const normalized = normalizeNameDashes(name);
  const prefix = /^(?:\(([^()]+)\)|\[([^\[\]]+)\]|(E|Z|cis|trans))\s*-\s*(.+)$/i.exec(normalized);
  if (!prefix) return "notCheckable";
  const descriptor = prefix[1] ?? prefix[2] ?? prefix[3], body = prefix[4];
  const stems = { prop: 3, but: 4, pent: 5, hex: 6, hept: 7, oct: 8, non: 9, dec: 10 };
  const modern = /^(prop|but|pent|hex|hept|oct|non|dec)a?-(\d+(?:,\d+)*)-(ene|diene|triene|tetraene)$/i.exec(body);
  const older = /^(\d+(?:,\d+)*)-(prop|but|pent|hex|hept|oct|non|dec)a?(ene|diene|triene|tetraene)$/i.exec(body);
  if (!modern && !older) return "notCheckable";
  const n = stems[(modern?.[1] ?? older[2]).toLowerCase()];
  const locants = (modern?.[2] ?? older[1]).split(",").map(Number);
  const suffix = (modern?.[3] ?? older[3]).toLowerCase();
  if (locants.length !== { ene: 1, diene: 2, triene: 3, tetraene: 4 }[suffix]
    || new Set(locants).size !== locants.length || locants.some(l => l < 1 || l >= n)) return "notCheckable";
  let wanted;
  if (/^(cis|trans)$/i.test(descriptor)) {
    if (locants.length !== 1) return "notCheckable";
    wanted = [[locants[0], /^cis$/i.test(descriptor) ? "Z" : "E"]];
  } else {
    const tokens = descriptor.split(/\s*,\s*/).map(t => /^(\d+)?([EZ])$/i.exec(t));
    if (tokens.some(t => !t || (!t[1] && locants.length !== 1))) return "notCheckable";
    wanted = tokens.map(t => [t[1] ? Number(t[1]) : locants[0], t[2].toUpperCase()]);
    if (new Set(wanted.map(([l]) => l)).size !== wanted.length || wanted.some(([l]) => !locants.includes(l))) return "notCheckable";
  }
  const { atoms, bonds } = bound.graph;
  if (atoms.length !== n || bonds.length !== n - 1 || atoms.some(a => (a.z ?? 6) !== 6
    || a.chg || a.isotope || a.nRad) || bonds.some(b => ![1, 2].includes(b.bo ?? 1))) return "notCheckable";
  const neighbors = atoms.map(() => []), orders = new Map();
  for (const b of bonds) {
    const [a, c] = b.atoms;
    neighbors[a].push(c); neighbors[c].push(a); orders.set(pair(a, c), b.bo ?? 1);
  }
  const ends = neighbors.flatMap((ns, i) => ns.length === 1 ? [i] : []);
  if (ends.length !== 2 || neighbors.some(ns => ns.length > 2)) return "notCheckable";
  let checked = false, missingOnly = false;
  for (const end of ends) {
    const path = [end];
    while (path.length < n) {
      const next = neighbors[path.at(-1)].find(a => a !== path.at(-2));
      if (next === undefined || path.includes(next)) break;
      path.push(next);
    }
    if (path.length !== n) continue;
    const actualLocants = path.slice(1).flatMap((a, i) => orders.get(pair(path[i], a)) === 2 ? [i + 1] : []);
    if (actualLocants.length !== locants.length || !actualLocants.every(l => locants.includes(l))) continue;
    // Terminal/cumulated bonds cannot be assigned ordinary alkene E/Z here.
    if (wanted.some(([l]) => l === 1 || l === n - 1 || locants.includes(l - 1) || locants.includes(l + 1))) return "notCheckable";
    checked = true;
    let missing = false, wrong = false;
    for (const [l, code] of wanted) {
      const actual = bound.bondStereo.get(pair(path[l - 1], path[l]));
      if (!actual) missing = true;
      else if (actual !== `(${code})`) wrong = true;
    }
    if (!wrong && !missing) return "correctIsomer";
    if (!wrong && missing) missingOnly = true;
  }
  return !checked ? "notCheckable" : missingOnly ? "noStereo" : "wrongIsomer";
}

export function auditRows(rows, rdkit, readings = new Map()) {
  const counts = { totalRows: rows.length, rowsWithGeometricNames: 0,
    correctIsomer: 0, wrongIsomer: 0, noStereo: 0, notCheckable: 0,
    geometricNames: 0, opsinParsedNames: 0, rdkitFallbackNames: 0,
    // The TSV has neither own-label provenance nor accuracy-gate decisions.
    // Without the original build report this count is unknown, not zero.
    labelToOtherRows: null };
  for (const row of rows) {
    const names = geometricNames(row);
    if (!names.length) continue;
    counts.rowsWithGeometricNames++;
    const bound = describeStructure(rdkit, row.smiles), results = [];
    for (const name of names) {
      counts.geometricNames++;
      const expected = readings.get(name);
      let result = "notCheckable";
      const descriptors = geometricStereoDescriptors(name);
      const ezCount = descriptors.filter(code => code === "E" || code === "Z").length;
      const relativeOnly = descriptors.some(code => code === "CIS" || code === "TRANS")
        && !absoluteStereoDescriptor.test(normalizeNameDashes(name));
      if (expected) {
        counts.opsinParsedNames++;
        const described = describeStructure(rdkit, expected);
        // Do not confirm an E/Z name using only its independently parsed R/S
        // centres if OPSIN did not represent all explicit E/Z descriptors.
        if (described && described.bondStereo.size >= ezCount) {
          result = compareOpsin(rdkit, row.smiles, expected, { relativeOnly });
        }
      }
      if (result === "notCheckable") {
        result = compareSimpleAlkene(name, bound);
        if (result !== "notCheckable") counts.rdkitFallbackNames++;
      }
      if (result === "notCheckable" && bound) {
        if (ezCount ? !bound.bondStereo.size : !bound.atomStereo.size && !bound.bondStereo.size) result = "noStereo";
      }
      results.push(result);
    }
    // Counts partition compound rows, not aliases. One contradicted alias makes
    // a row wrong; missing stereo wins over unchecked aliases. Correct means
    // every geometric name on the row was checked and agreed.
    counts[results.includes("wrongIsomer") ? "wrongIsomer" : results.includes("noStereo") ? "noStereo"
      : results.includes("notCheckable") ? "notCheckable" : "correctIsomer"]++;
  }
  return counts;
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-opsin") options.noOpsin = true;
    else if (["--dictionary", "--java"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) options[args[i].slice(2)] = args[++i];
    else throw new Error("Invalid audit arguments");
  }
  const rows = parseRows(gunzipSync(readFileSync(resolve(options.dictionary ?? join(ROOT, "data", "names", "dictionary.tsv.gz")))).toString("utf8"));
  const names = [...new Set(rows.flatMap(geometricNames))];
  let readings = new Map(), opsinAvailable = 0, opsinAttempts = 0;
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const candidates = options.java ? [options.java] : [
    join(ROOT, "apps", "desktop", "src-tauri", "resources", "opsin", "jre", "bin", executable),
    ...(process.env.JAVA_HOME ? [join(process.env.JAVA_HOME, "bin", executable)] : []),
    ...(process.platform === "darwin" ? [join("/opt", "homebrew", "opt", "openjdk", "bin", executable),
      join("/usr", "local", "opt", "openjdk", "bin", executable)] : []), executable
  ];
  if (!options.noOpsin) for (const java of [...new Set(candidates)]) {
    if (dirname(java) !== "." && !existsSync(java)) continue;
    opsinAttempts++;
    try {
      readings = await readOpsin(names, java); opsinAvailable = 1; break;
    } catch { /* Keep OPSIN diagnostics private and fall back without a network request. */ }
  }
  const rdkit = await loadRDKit({ print: () => {}, printErr: () => {} });
  const counts = auditRows(rows, rdkit, readings);
  console.log(JSON.stringify({ ...counts, opsinAvailable, opsinAttempts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(JSON.stringify({ auditFailures: 1 })); process.exitCode = 1; });
}
