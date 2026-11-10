import { createHash } from "node:crypto";
import { nativeSurvival } from "./survival";
import { moleculeToMolfileV3000, type ChemDraftDocument, type MoleculeObject } from "../../packages/chem-core/src/index";
import { expandNativeMoleculeLabelGroups, nativeMoleculeUnspellableLabels, nativeSingleHeavyElementLabelValence, nativeSingleBondGraphMetadata, nativeElementFromAtomLabel, nativeImplicitHydrogenCount } from "../../packages/document-workflow-core/src/index";
import { nativeBondOrderResolution } from "../../packages/layout-engine/src/index";
import { installNodeRdkitModuleLoader } from "../../packages/rdkit-adapter/src/node";
import { ensureRdkit, type RdkitMinimalModule, type RdkitJsMol } from "../../packages/rdkit-adapter/src/conformer";
import { compositionFromRdkitJson, type RdkitJson } from "../../packages/rdkit-adapter/src/composition";
import { bracketValue, sorted, type BracketSummary, type MoleculeSummary, type ReactionParticipantSummary, type Summary, type StageError, type Warning, warning } from "./model";
import { rdkitError, stageError } from "./errors";

let loaderInstalled = false;
async function harnessRdkit() {
  if (!loaderInstalled) { installNodeRdkitModuleLoader(); loaderInstalled = true; }
  return ensureRdkit();
}

/** One file's cache, shared by its original and round-trip documents. No live WASM handles. */
export class SummaryContext {
  readonly molecules = new Map<string, { summary?: MoleculeSummary; error?: StageError; warnings: Warning[] }>();
  private module?: Promise<RdkitMinimalModule>;
  constructor(private readonly load = harnessRdkit, private readonly restart = () => { loaderInstalled = false; }) {}
  rdkit(): Promise<RdkitMinimalModule> { return this.module ??= this.load(); }
  recover(error: unknown): void {
    if (!this.module || rdkitError(error).category !== "rdkit.wasm_oob") return;
    this.module = undefined;
    this.restart();
  }
}

/** Include all summary inputs, including geometry (stereo), but normalise local IDs.
 * A different atom order may miss the cache; it can never borrow the wrong indices. */
export function nativeGraphHash(molecule: MoleculeObject): string {
  const atomIds = new Map(molecule.atoms.map((atom, index) => [atom.id, index]));
  const bondIds = new Map(molecule.bonds.map((bond, index) => [bond.id, index]));
  const normalise = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map(item => normalise(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "id").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalise(v, k)]));
    if (typeof value === "string" && /atomIds?$/i.test(key)) return atomIds.get(value) ?? value;
    if (typeof value === "string" && /bondIds?$/i.test(key)) return bondIds.get(value) ?? value;
    return value;
  };
  // Stored structure strings are not authoritative, and drawing placement/style do not
  // enter the molecular summary. Atom and bond display fields remain part of the key.
  return createHash("sha256").update(JSON.stringify(normalise({ atoms: molecule.atoms, bonds: molecule.bonds, superatoms: molecule.superatoms, rGroups: molecule.rGroups }))).digest("hex");
}
interface LogCapture { get_buffer(): string; clear_buffer(): void; }
type LoggingModule = RdkitMinimalModule & { enable_logging(): void; set_log_capture(channel: string): LogCapture | null };
// MinimalLib permits one capture per channel per WASM instance. Wrappers can share
// that instance, so key by its binding rather than the wrapper's object identity.
const captures = new WeakMap<LoggingModule["set_log_capture"], { error: LogCapture; warning: LogCapture }>();

/** Only a closed vocabulary and a validated element symbol can reach public reports. */
export function rdkitReason(message: string): string {
  if (/valence/i.test(message)) {
    const element = message.match(/atom\s*#?\s*\d+\s+([A-Z][a-z]?)(?=[,\s])/i)?.[1];
    return element && /^[A-Z][a-z]?$/.test(element) ? `valence:${element}` : "valence";
  }
  if (/kekuli[sz]/i.test(message)) return "kekulize";
  if (/aromatic/i.test(message)) return "aromaticity";
  if (/ring.?info|ring information|sssr/i.test(message)) return "ring-info";
  if (/pars(?:e|ing)|syntax|unclosed ring/i.test(message)) return "parse";
  return "other";
}

function parse(rdkit: RdkitMinimalModule, structure: string, options: Record<string, unknown>): { mol: RdkitJsMol | null; message: string } {
  const logging = rdkit as LoggingModule;
  let capture = captures.get(logging.set_log_capture);
  if (!capture) {
    logging.enable_logging();
    // Keep warnings private too: JSON serialization of unsanitized/query bonds can log
    // diagnostics even after parsing succeeds.
    const error = logging.set_log_capture("rdApp.error"), warning = logging.set_log_capture("rdApp.warning");
    if (!error || !warning) throw new Error("Chemistry summary failed: RDKit lacks available log capture.");
    capture = { error, warning };
    captures.set(logging.set_log_capture, capture);
  }
  capture.error.clear_buffer();
  capture.warning.clear_buffer();
  let mol: RdkitJsMol | null = null;
  try { mol = rdkit.get_mol(structure, JSON.stringify(options)); return { mol, message: capture.error.get_buffer() }; }
  catch (error) {
    const decoded = rdkitError(error, rdkit);
    try {
      const diagnostic = capture.error.get_buffer();
      if (diagnostic && !decoded.message.includes(diagnostic)) decoded.message += `\n${diagnostic}`;
    } catch { /* Do not touch a poisoned module again to recover its log. */ }
    try { mol?.delete(); } finally { throw decoded; }
  }
}

export async function describeStructure(structure: string, fallbackReason?: string, context = new SummaryContext()): Promise<MoleculeSummary> {
  const rdkit = await context.rdkit();
  try { return await describeWithRdkit(rdkit, structure, fallbackReason); }
  catch (error) {
    const decoded = rdkitError(error, rdkit);
    context.recover(decoded);
    if (decoded.category === "rdkit.wasm_oob") {
      // Retry just this input in a fresh instance. Do not run CIP, descriptors,
      // InChI or secondary feature-canonicalisation calls on the recovery path.
      for (const sanitize of [true, false]) {
        const fresh = await context.rdkit();
        try {
          return { ...describeWithRdkit(fresh, structure, fallbackReason, sanitize), recovery: sanitize ? "fresh-molfile" : "fresh-molfile-unsanitized" };
        } catch (retryError) {
          const retryDecoded = rdkitError(retryError, fresh);
          context.recover(retryDecoded);
          if (!sanitize) throw retryDecoded;
        }
      }
    }
    // Preserve ordinary harness rejection/capability diagnostics; decode actual RDKit throws.
    throw error instanceof Error && !(error instanceof WebAssembly.RuntimeError) && error.message.startsWith("Chemistry summary failed:") ? error : decoded;
  }
}

function describeWithRdkit(rdkit: RdkitMinimalModule, structure: string, fallbackReason?: string, recoverySanitize?: boolean): MoleculeSummary {
  const minimal = recoverySanitize !== undefined;
  const attempted = parse(rdkit, structure, { removeHs: false, ...(minimal ? { sanitize: recoverySanitize, kekulize: recoverySanitize } : {}) });
  const strictAccepted = !!attempted.mol && recoverySanitize !== false;
  const strict = strictAccepted && !fallbackReason;
  const reason = !strictAccepted ? rdkitReason(attempted.message) : fallbackReason;
  // MinimalLib supports skipping kekulization while retaining the other sanitization steps.
  // Other failures have no selective binding in this build: preserve the unsanitized graph.
  let mol = attempted.mol;
  if (minimal && !mol) throw new Error("Chemistry summary failed: RDKit rejected the molecule on recovery.");
  if (mol && fallbackReason && !minimal) { mol.delete(); mol = null; }
  if (!mol && reason === "kekulize") mol = parse(rdkit, structure, { removeHs: false, kekulize: false }).mol;
  if (!mol) mol = parse(rdkit, structure, { removeHs: false, sanitize: false, kekulize: false }).mol;
  if (!mol) throw Object.assign(new Error(`Chemistry summary failed: RDKit rejected the molecule. ${attempted.message}`), { rdkitReason: reason });
  let failed = false;
  try {
    if (!mol.get_json || !mol.get_smiles) throw new Error("Chemistry summary failed: RDKit lacks JSON or SMILES.");
    const json = JSON.parse(mol.get_json()) as RdkitJson;
    const composition = compositionFromRdkitJson(json);
    const defaults = json.defaults?.atom ?? {};
    const atoms = json.molecules[0].atoms.map(atom => ({ z: 6, isotope: 0, nRad: 0, chg: 0, impHs: 0, ...defaults, ...atom }));
    const hasStereo = json.molecules[0].atoms.some(a => a.stereo && a.stereo !== "unspecified") || json.molecules[0].bonds.some(b => b.stereo && b.stereo !== "unspecified" && b.stereo !== "either");
    const stereoMol = mol as typeof mol & { get_stereo_tags?: () => string };
    if (!minimal && !stereoMol.get_stereo_tags) throw new Error("Chemistry summary failed: RDKit lacks stereo tags.");
    // One pass per distinct graph, including RDKit's unassigned potential centres.
    // Feature-only canonicalisation below disables further stereo assignment.
    const tags = (minimal ? { CIP_atoms: atoms.flatMap((a, i) => a.stereo && a.stereo !== "unspecified" ? [[i, a.stereo]] : []) } : JSON.parse(stereoMol.get_stereo_tags!())) as { CIP_atoms?: [number, string][]; CIP_bonds?: [number, number, string][] };
    const smiles = mol.get_smiles();
    const stripStereo = (value: string) => value.replace(/@(?:TH|AL|SP|TB|OH)\d*|@+|[\\/]/g, "");
    const canonical = (input: string, feature: string) => {
      // Raw feature graphs are conservative comparison keys on this explicitly
      // labelled recovery path; do not risk the original failing extra calls.
      if (minimal) return input;
      const handle = rdkit.get_mol(input, JSON.stringify({ sanitize: false, removeHs: false, assignStereo: false }));
      let failed = false;
      try {
        if (!handle?.get_smiles) throw new Error(`Chemistry summary failed: RDKit could not canonicalise ${feature}.`);
        return handle.get_smiles();
      } catch (error) { failed = true; throw error; }
      finally { try { handle?.delete(); } catch (error) { if (!failed) throw error; } }
    };
    const withoutStereo = hasStereo ? canonical(stripStereo(smiles), "stereo-free identity") : smiles;
    // RDKit JSON is an engine-native input format. This key deliberately removes features;
    // it is only for classifying differences, never a replacement for the drawn interpretation.
    const bare: RdkitJson = {
      ...json,
      defaults: { ...json.defaults, atom: { ...defaults, z: 6, chg: 0, isotope: 0, nRad: 0, impHs: 0, stereo: "unspecified" } },
      molecules: json.molecules.map(m => ({
        atoms: m.atoms.map(a => ({ z: a.z ?? defaults.z ?? 6, chg: 0, isotope: 0, nRad: 0, impHs: 0, stereo: "unspecified" })),
        bonds: m.bonds.map(b => ({ atoms: b.atoms, bo: b.bo ?? json.defaults?.bond?.bo ?? 1 }))
      }))
    };
    const connectivity = canonical(JSON.stringify(bare), "the feature-stripped graph");
    const featureKeys = { charge: "", isotope: "", radical: "", stereo: "" };
    for (const [feature, property] of [["charge", "chg"], ["isotope", "isotope"], ["radical", "nRad"]] as const) {
      const keyed = structuredClone(bare);
      if (!atoms.some(atom => atom[property])) { featureKeys[feature] = connectivity; continue; }
      keyed.molecules[0].atoms.forEach((a, index) => { a[property] = atoms[index][property]; });
      featureKeys[feature] = canonical(JSON.stringify(keyed), `the ${feature} key`);
    }
    const stereoGraph = structuredClone(bare);
    stereoGraph.molecules[0].atoms.forEach((a, index) => { a.stereo = json.molecules[0].atoms[index].stereo ?? defaults.stereo ?? "unspecified"; a.impHs = atoms[index].impHs; });
    stereoGraph.molecules[0].bonds = json.molecules[0].bonds;
    featureKeys.stereo = hasStereo ? canonical(JSON.stringify(stereoGraph), "the stereo key") : connectivity;
    let species: MoleculeSummary["species"];
    if (!minimal && strict) {
      const inchiMol = mol as typeof mol & { get_inchi?: (options?: string) => string };
      const inchiModule = rdkit as typeof rdkit & { get_inchikey_for_inchi?: (inchi: string) => string };
      let inchiKey: string | undefined, fixedHInchi: string | undefined;
      try {
        const inchi = inchiMol.get_inchi?.();
        const key = inchi?.startsWith("InChI=1S/") ? inchiModule.get_inchikey_for_inchi?.(inchi) : undefined;
        if (key && /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(key)) inchiKey = key;
      } catch (error) { if (rdkitError(error, rdkit).category === "rdkit.wasm_oob") throw error; }
      try {
        // Verified against the actual Node MinimalLib: options are supported, but
        // ResonanceMolSupplier is not bound. FixedH returns nonstandard InChI=1/;
        // an ignored option returning 1S must never masquerade as FixedH evidence.
        const fixed = inchiMol.get_inchi?.("/FixedH");
        if (fixed?.startsWith("InChI=1/")) fixedHInchi = fixed;
      } catch (error) { if (rdkitError(error, rdkit).category === "rdkit.wasm_oob") throw error; }
      const explicitHSmiles = (mol.get_smiles as (options?: string) => string)(JSON.stringify({ allHsExplicit: true }));
      species = {
        version: 2, ...(inchiKey ? { inchiKey } : {}), ...(fixedHInchi ? { fixedHInchi } : {}), explicitHSmiles,
        graph: {
          atoms: atoms.map(a => ({ z: a.z, isotope: a.isotope, radical: a.nRad, h: a.impHs, charge: a.chg })),
          bonds: json.molecules[0].bonds.map(b => ({ atoms: b.atoms, order: b.bo ?? json.defaults?.bond?.bo ?? 1 }))
        }
      };
    }
    return {
      ...(species ? { species } : {}),
      strict, ...(reason ? { sanitization: { reason, ...(!strictAccepted ? { rdkitReason: reason, message: attempted.message } : {}) } } : {}),
      dummyAtoms: [], atomCount: atoms.length,
      featureAtoms: atoms.map((a, i) => ({ z: a.z, h: a.impHs, degree: json.molecules[0].bonds.filter(b => b.atoms.includes(i)).length, charge: a.chg, isotope: a.isotope, radical: a.nRad })),
      ...(!species ? { featureBonds: json.molecules[0].bonds.map(b => ({ atoms: b.atoms, order: b.bo ?? json.defaults?.bond?.bo ?? 1 })) } : {}),
      smiles, withoutStereo, connectivity, featureKeys, formula: composition.formula,
      hydrogenCount: composition.elements.filter(e => e.symbol === "H").reduce((n, e) => n + e.count, 0),
      charge: composition.formalCharge,
      isotopes: atoms.flatMap((a, atom) => a.isotope ? [{ atom, mass: a.isotope }] : []),
      radicals: atoms.flatMap((a, atom) => a.nRad ? [{ atom, electrons: a.nRad }] : []),
      tetrahedral: (tags.CIP_atoms ?? []).map(([atom, cip]) => ({ atom, cip })),
      doubleBonds: json.molecules[0].bonds.flatMap((b) => (b.bo ?? json.defaults?.bond?.bo ?? 1) === 2 ? [{
        atoms: b.atoms,
        stereo: b.stereo === "either" ? "either" : (tags.CIP_bonds ?? []).find(([a, c]) => b.atoms.includes(a) && b.atoms.includes(c))?.[2]?.replace(/[()]/g, "") ?? "unspecified"
      }] : []),
      displays: { wedge: 0, hash: 0, either: 0, wavy: 0 },
      heavyAtoms: atoms.filter(a => a.z > 1).length, bonds: composition.bondCount,
      abbreviations: [], rGroups: []
    };
  } catch (error) { failed = true; throw error; }
  finally {
    // A poisoned WASM destructor can throw too. Keep the original OOB reason, while
    // still attempting to release the handle exactly once. Logs reset before parsing.
    try { mol.delete(); } catch (error) { if (!failed) throw error; }
  }
}

async function describeMolecule(drawn: MoleculeObject, warnings: Warning[], context: SummaryContext, truthDummies = false): Promise<MoleculeSummary> {
  const { molecule, placeholderAtoms, expansions } = expandNativeMoleculeLabelGroups(drawn);
  const highRadicals = molecule.atoms.some(a => (a.markRadicals ?? 0) > 2);
  const dummyById = new Map<string, { kind: "abbreviation" | "r-group" | "generic"; label: string }>();
  for (const atom of molecule.atoms) {
    if (atom.element === "D" || atom.element === "T") continue;
    if (!placeholderAtoms.has(atom.id) && (nativeElementFromAtomLabel(atom.element) || nativeSingleHeavyElementLabelValence(atom.element))) continue;
    const kind = /^R\d*$/.test(atom.element) || drawn.rGroups.some(r => r.label === atom.element) ? "r-group"
      : ["*", "A", "Q", "X", "M", "Du", "L"].includes(atom.element) ? "generic" : "abbreviation";
    dummyById.set(atom.id, { kind, label: atom.element });
    placeholderAtoms.set(atom.id, `harness ${kind} placeholder`);
  }
  const fallbackReason = dummyById.values().next().value?.kind
    ?? (molecule.bonds.some(b => b.order === "unknown") ? "query-bond"
      : molecule.bonds.some(b => b.order === "single" && b.display?.bondStyle === "dashed") ? "dative" : highRadicals ? "other" : undefined);
  // MDL radical codes stop at two electrons. For larger counts use RDKit's own JSON
  // transport below, with the native count and the shared native H convention.
  const transportMolecule = highRadicals ? { ...molecule, atoms: molecule.atoms.map(a => (a.markRadicals ?? 0) > 2 ? { ...a, markRadicals: 0 } : a) } : molecule;
  const written = moleculeToMolfileV3000(transportMolecule, {
    fromDocFrame: true, unknownBondOrders: "any", placeholderAtoms,
    spellLabel: nativeSingleHeavyElementLabelValence,
    kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
  });
  // Summary-transport warnings are recorded, but cannot excuse an interchange loss.
  warnings.push(...written.warnings.map(message => ({ ...warning({ code: "summary.molfile_warning", message }), features: [] })));
  // Deterministic atom maps label dummy vertices by kind and label, including their position
  // in the graph. A sorted label tally alone would miss two labels swapping attachment sites.
  const dummyKeys = sorted([...new Set([...dummyById.values()].map(d => JSON.stringify(d)))]);
  const dummyMaps = new Map<string, number>();
  const usedMaps = new Set<number>();
  for (const key of dummyKeys) {
    // RDKit atom maps are positive signed integers. Hash the label itself so neither
    // atom order nor other labels in the molecule can change its canonical identity.
    const atomMap = (createHash("sha256").update(key).digest().readUInt32BE(0) & 0x7fffffff) || 1;
    if (usedMaps.has(atomMap)) throw new Error("Chemistry summary failed: dummy label atom-map collision.");
    usedMaps.add(atomMap);
    dummyMaps.set(key, atomMap);
  }
  let inAtoms = false;
  let transport = written.contents.split("\n").map(line => {
    if (line === "M  V30 BEGIN ATOM") inAtoms = true;
    else if (line === "M  V30 END ATOM") inAtoms = false;
    else if (inAtoms) {
      const fields = line.trim().split(/\s+/);
      const dummy = dummyById.get(molecule.atoms[Number(fields[2]) - 1]?.id);
      if (dummy) {
        // RDKit interprets MDL '*' plus CHG as a query constraint, losing actual
        // charge. MDL R is a real dummy atom and preserves charge/isotope/radical.
        fields[3] = "R";
        // V3000: M V30 index symbol x y z atom-map [attributes]. Keep CHG=,
        // MASS= and all other attributes intact; a map is neither charge nor isotope.
        fields[7] = String(truthDummies && dummy.label === "*" ? 0 : dummyMaps.get(JSON.stringify(dummy))!);
        return `M  V30 ${fields.slice(2).join(" ")}`;
      }
    }
    return line;
  }).join("\n");
  if (highRadicals) {
    const rdkit = await context.rdkit();
    const parsed = parse(rdkit, transport, { sanitize: false, removeHs: false }).mol;
    let failed = false;
    try {
      if (!parsed?.get_json) throw new Error("Chemistry summary failed: RDKit rejected the molecule's radical transport.");
      const graph = JSON.parse(parsed.get_json()) as RdkitJson;
      // MinimalLib's JSON reader rejects some molblock-derived name/conformer
      // metadata; identity needs only the atom/bond graph and representation extension.
      graph.molecules = graph.molecules.map(m => ({ atoms: m.atoms, bonds: m.bonds, extensions: m.extensions }));
      const usage = nativeBondOrderResolution(molecule.atoms, molecule.bonds).bondOrderUsage;
      molecule.atoms.forEach((atom, index) => {
        if ((atom.markRadicals ?? 0) <= 2) return;
        graph.molecules[0].atoms[index].nRad = atom.markRadicals;
        const element = nativeElementFromAtomLabel(atom.element);
        graph.molecules[0].atoms[index].impHs = atom.labelLiteral || dummyById.has(atom.id) || !element ? 0
          : Math.max(0, nativeImplicitHydrogenCount(element, usage.get(atom.id) ?? 0, atom.formalCharge, atom.markRadicals ?? 0));
      });
      transport = JSON.stringify(graph);
    } catch (error) {
      failed = true;
      throw error instanceof Error && error.message.startsWith("Chemistry summary failed:") ? error : rdkitError(error, rdkit);
    } finally { try { parsed?.delete(); } catch (error) { if (!failed) throw rdkitError(error, rdkit); } }
  }
  const summary = await describeStructure(transport, fallbackReason, context);
  summary.dummyAtoms = dummyKeys.map(key => ({ ...JSON.parse(key), count: [...dummyById.values()].filter(d => JSON.stringify(d) === key).length }));
  if (!summary.strict) {
    // The shared native formula counts the drawing's graph and skeletal H convention.
    // Unknown groups contribute a labelled dummy, never an invented expansion.
    const native = nativeSingleBondGraphMetadata(molecule.atoms.map(a => dummyById.has(a.id) ? { ...a, element: "*" } : a), molecule.bonds);
    summary.formula = (native.formula ?? "") + (dummyById.size ? `*${dummyById.size === 1 ? "" : dummyById.size}` : "");
    summary.hydrogenCount = [...summary.formula.matchAll(/(\[\d+[A-Z][a-z]?\]|[A-Z][a-z]?|\*)(\d*)/g)]
      .filter(m => /^(?:H|D|T|\[\d+H\])$/.test(m[1])).reduce((n, m) => n + Number(m[2] || 1), 0);
    summary.charge = molecule.atoms.reduce((n, a) => n + a.formalCharge, 0);
    summary.isotopes = molecule.atoms.flatMap((a, atom) => a.isotope || a.element === "D" || a.element === "T" ? [{ atom, mass: a.isotope ?? (a.element === "D" ? 2 : 3) }] : []);
    summary.radicals = molecule.atoms.flatMap((a, atom) => a.markRadicals ? [{ atom, electrons: a.markRadicals }] : []);
    summary.atomCount = molecule.atoms.length;
    summary.heavyAtoms = molecule.atoms.filter(a => !["H", "D", "T"].includes(a.element) && !dummyById.has(a.id)).length;
    summary.bonds = molecule.bonds.length;
  }
  summary.objectId = drawn.id;
  summary.displays = {
    wedge: drawn.bonds.filter(b => b.display?.bondStyle === "wedge").length,
    hash: drawn.bonds.filter(b => b.display?.bondStyle === "hashed").length,
    either: drawn.bonds.filter(b => b.stereo === "either").length,
    wavy: drawn.bonds.filter(b => (b.order ?? "single") === "single" && b.display?.bondStyle === "wavy").length
  };
  summary.abbreviations = [];
  for (const s of drawn.superatoms) summary.abbreviations.push({ label: s.label, expandedFragment: s.expandedStructure ? (await describeStructure(s.expandedStructure, undefined, context)).smiles : undefined });
  for (const expansion of expansions) {
    if (summary.abbreviations.some(a => a.label === expansion.label)) continue;
    const ids = new Set(expansion.atomIds);
    const fragment = { ...molecule, atoms: molecule.atoms.filter(a => ids.has(a.id)), bonds: molecule.bonds.filter(b => ids.has(b.fromAtomId) && ids.has(b.toAtomId)) };
    const block = moleculeToMolfileV3000(fragment, { fromDocFrame: true, spellLabel: nativeSingleHeavyElementLabelValence, kekuleBondOrders: nativeBondOrderResolution(fragment.atoms, fragment.bonds).kekuleOrders });
    summary.abbreviations.push({ label: expansion.label, expandedFragment: (await describeStructure(block.contents, undefined, context)).smiles });
  }
  summary.rGroups = drawn.rGroups.map(r => ({ label: r.label, semantics: r.querySemantics }));
  for (const label of nativeMoleculeUnspellableLabels(drawn)) {
    if (/^R\d*$/.test(label)) {
      if (!summary.rGroups.some(r => r.label === label)) summary.rGroups.push({ label, semantics: "unknown" });
    } else if (label !== "*" && !summary.abbreviations.some(a => a.label === label)) summary.abbreviations.push({ label });
  }
  return summary;
}

// This projection is stored separately and never used by round-trip comparisons.
export async function describeTruthSru(document: ChemDraftDocument, baseline: Summary, context = new SummaryContext()): Promise<{ molecules: MoleculeSummary[]; notes: string[] } | undefined> {
  const replacements = new Map<string, Set<string>>();
  const notes = new Set<string>();
  let found = false;
  for (const page of document.pages) {
    const groups = new Map<string, Extract<typeof page.objects[number], { type: "bracket" }>[]>();
    for (const b of page.objects) if (b.type === "bracket") {
      if (!b.pairId) {
        if (b.bracketUsage === "sru" || b.repeatUnit === true) { found = true; notes.add("sru.missing_crossing_data"); }
        continue;
      }
      const group = groups.get(b.pairId) ?? []; group.push(b); groups.set(b.pairId, group);
    }
    for (const group of groups.values()) {
      if (!group.some(b => b.bracketUsage === "sru" || b.repeatUnit === true)) continue;
      found = true;
      const refs = group.flatMap(b => b.crossingBondIds ?? []);
      const pending = new Map<string, Set<string>>();
      let incomplete = group.length !== 2 || refs.length === 0;
      for (const ref of refs) {
        const mol = page.objects.find(o => o.type === "molecule" && o.id === ref.objectId);
        const bond = mol?.type === "molecule" ? mol.bonds.find(b => b.id === ref.bondId) : undefined;
        if (!mol || mol.type !== "molecule" || !bond) { incomplete = true; continue; }
        const sourceRecords = group.flatMap(b => {
          const records = b.compatibility?.unknown?.cdxmlBracketCrossings;
          return Array.isArray(records) ? records : [];
        }) as { ref?: { objectId?: string; bondId?: string }; innerAtomId?: string }[];
        const sourceInner = sourceRecords.filter(r => r.ref?.objectId === ref.objectId && r.ref?.bondId === ref.bondId && r.innerAtomId).map(r => r.innerAtomId!);
        const members = group.flatMap(b => {
          const records = b.compatibility?.unknown?.cdxmlBracketMembers;
          return Array.isArray(records) ? records : [];
        }) as { objectId?: string; atomId?: string }[];
        const memberIds = new Set([...members.filter(r => r.objectId === mol.id && r.atomId).map(r => r.atomId!), ...group.flatMap(b => b.containedObjectIds)]);
        const endpoints = [bond.fromAtomId, bond.toAtomId];
        const candidates = sourceInner.length ? [...new Set(sourceInner)] : endpoints.filter(id => memberIds.has(id));
        if (candidates.length !== 1 || !endpoints.includes(candidates[0])) { incomplete = true; continue; }
        const outer = endpoints.find(id => id !== candidates[0]);
        if (!outer || !mol.atoms.some(a => a.id === outer)) { incomplete = true; continue; }
        const set = pending.get(mol.id) ?? new Set<string>(); set.add(outer); pending.set(mol.id, set);
      }
      if (incomplete) { notes.add("sru.missing_crossing_data"); continue; }
      for (const [id, atoms] of pending) {
        const set = replacements.get(id) ?? new Set<string>(); atoms.forEach(atom => set.add(atom)); replacements.set(id, set);
      }
    }
  }
  if (!found) return undefined;
  const molecules = [...baseline.molecules];
  for (const page of document.pages) for (const object of page.objects) if (object.type === "molecule" && replacements.has(object.id)) {
    const atoms = replacements.get(object.id)!;
    const mapped = { ...object, atoms: object.atoms.map(a => atoms.has(a.id) ? { ...a, element: "*", formalCharge: 0, isotope: undefined, markRadicals: 0, labelLiteral: undefined } : a) };
    const index = molecules.findIndex(m => m.objectId === object.id);
    if (index >= 0) {
      try { molecules[index] = await describeMolecule(mapped, [], context, true); }
      catch { notes.add("sru.projection_failed"); }
    }
  }
  return { molecules, notes: [...notes] };
}

function arrowKind(object: ChemDraftDocument["pages"][number]["objects"][number]): string | undefined {
  if (object.type === "reaction-arrow" || object.type === "mechanism-arrow") return object.arrowKind;
  if (object.type !== "graphic") return undefined;
  const kinds: Record<string, string> = { reactionArrow: "forward", reactionArrowBold: "forward", reactionArrowDashed: "forward", equilibriumArrow: "equilibrium", retroArrow: "retrosynthesis", resonanceArrow: "resonance", fishhookArrow: "half-headed", fishhookCurved: "half-headed", curvedArrow: "full-headed" };
  return kinds[object.data.artToolId ?? ""] ?? (object.data.markerEnd || object.data.markerStart ? "graphic-arrow" : undefined);
}

export async function describeDocument(document: ChemDraftDocument, warnings: Warning[], context = new SummaryContext()): Promise<Summary> {
  const molecules: MoleculeSummary[] = [];
  const summaryErrors: NonNullable<Summary["summaryErrors"]> = [];
  const objects = document.pages.flatMap(page => page.objects);
  const brackets: BracketSummary[] = [];
  let unpairedBrackets = 0;
  for (const page of document.pages) {
    type OptionalBracket = { id: string; pairId?: unknown; bracketKind?: unknown; bracketUsage?: unknown; repeatCount?: unknown; label?: unknown; repeatUnit?: unknown; containedObjectIds?: unknown; crossingBondIds?: unknown };
    const groups = new Map<string, OptionalBracket[]>();
    for (const object of page.objects) if (object.type === "bracket") {
      const b = object as OptionalBracket;
      if (typeof b.pairId !== "string" || !b.pairId) { unpairedBrackets++; continue; }
      const group = groups.get(b.pairId) ?? []; group.push(b); groups.set(b.pairId, group);
    }
    for (const group of groups.values()) {
      if (group.length !== 2) { unpairedBrackets += group.length; continue; }
      const stringField = (key: "bracketKind" | "label") => sorted(group.flatMap(b => typeof b[key] === "string" ? [b[key] as string] : []))[0] ?? null;
      const usage = sorted(group.map(b => typeof b.bracketUsage === "string" ? b.bracketUsage : null));
      const counts = sorted(group.map(b => typeof b.repeatCount === "string" || (typeof b.repeatCount === "number" && Number.isFinite(b.repeatCount)) ? b.repeatCount : null));
      const units = sorted(group.map(b => typeof b.repeatUnit === "boolean" ? b.repeatUnit : null));
      const members = new Set(group.flatMap(b => Array.isArray(b.containedObjectIds) ? b.containedObjectIds.filter((id: unknown): id is string => typeof id === "string") : []));
      const crossingBonds = new Set(group.flatMap(b => Array.isArray(b.crossingBondIds) ? b.crossingBondIds.flatMap((entry: unknown) => {
        if (typeof entry === "string") return [JSON.stringify([entry])];
        if (entry && typeof entry === "object" && "objectId" in entry && "bondId" in entry && typeof entry.objectId === "string" && typeof entry.bondId === "string") return [JSON.stringify([entry.objectId, entry.bondId])];
        return [];
      }) : []));
      brackets.push({ bracketKind: stringField("bracketKind"), bracketUsage: usage, repeatCount: counts, label: stringField("label"), repeatUnit: units, memberCount: members.size, crossingBondCount: crossingBonds.size, objectIds: group.map(b => b.id).sort() });
    }
  }
  brackets.sort((a, b) => {
    const left = JSON.stringify(bracketValue(a)), right = JSON.stringify(bracketValue(b));
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const [pageIndex, page] of document.pages.entries()) for (const object of page.objects) if (object.type === "molecule") {
    try {
      const hash = nativeGraphHash(object);
      let cached = context.molecules.get(hash);
      if (!cached) {
        const moleculeWarnings: Warning[] = [];
        try { cached = { summary: await describeMolecule(object, moleculeWarnings, context), warnings: moleculeWarnings }; }
        catch (error) {
          const decoded = error instanceof WebAssembly.RuntimeError ? rdkitError(error) : error;
          cached = { error: stageError("summary", decoded), warnings: moleculeWarnings };
          context.recover(decoded);
        }
        context.molecules.set(hash, cached);
      }
      if (cached.error) summaryErrors.push({ objectId: object.id, summaryError: structuredClone(cached.error) });
      else {
        const atoms = object.atoms;
        const byId = new Map(atoms.map(atom => [atom.id, atom]));
        const lengths = object.bonds.flatMap(bond => {
          const a = byId.get(bond.fromAtomId), b = byId.get(bond.toAtomId);
          const length = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
          return length > 0 && Number.isFinite(length) ? [length] : [];
        }).sort((a, b) => a - b);
        const pairing = atoms.length ? {
          page: pageIndex, centroid: [atoms.reduce((sum, a) => sum + a.x, 0) / atoms.length, atoms.reduce((sum, a) => sum + a.y, 0) / atoms.length] as [number, number],
          bondLength: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 30,
          elements: atoms.map(a => a.element), labels: atoms.filter(a => a.element !== "C" || a.labelVisible || a.labelLiteral).map(a => a.element), bonds: object.bonds.length
        } : undefined;
        molecules.push({ ...structuredClone(cached.summary!), objectId: object.id, originalId: object.compatibility?.originalId, pairing });
      }
      warnings.push(...cached.warnings.map(w => ({ ...w, ...(w.objectId ? { objectId: object.id } : {}) })));
    } catch (error) {
      summaryErrors.push({ objectId: object.id, summaryError: stageError("summary", error) });
      context.recover(error);
    }
  }
  const identities = new Map(molecules.map(m => [m.objectId, m.smiles]));
  const objectsById = new Map(objects.map(object => [object.id, object]));
  const participant = (objectId: string): ReactionParticipantSummary => {
    const smiles = identities.get(objectId);
    if (smiles !== undefined) return smiles;
    const object = objectsById.get(objectId);
    if (!object) throw new Error("Chemistry summary failed: reaction component target is missing.");
    if (object.type === "text") return { kind: "text", text: object.text };
    if (object.type === "superatom" || object.type === "r-group-label") return { kind: object.type, label: object.label };
    // Failed molecule summaries keep their original summaryErrors above. Retain their roles
    // without adding a second error or granting an incomplete chemistry summary a PASS.
    return { kind: "unidentified", objectType: object.type };
  };
  const arrowKinds = sorted(objects.flatMap(o => arrowKind(o) ? [arrowKind(o)!] : []));
  const colours = new Set<string>();
  const findColours = (value: unknown, key = "") => {
    if (typeof value === "string" && /color|colour/i.test(key)) colours.add(value.toLowerCase());
    else if (Array.isArray(value)) value.forEach(v => findColours(v));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) findColours(v, k);
  };
  for (const object of objects) { findColours(object.style); if (object.type === "text") findColours(object.spans); }
  const texts = objects.filter(o => o.type === "text");
  const textStyles = texts.map(t => {
    const styles = [t.style, ...t.spans.map(s => ({ ...t.style, ...s.style }))];
    return {
      bold: styles.some(s => Number(s.fontWeight ?? 400) >= 600 || s.fontWeight === "bold"),
      italic: styles.some(s => s.fontStyle === "italic"),
      subscript: t.spans.some(s => s.script === "subscript"),
      superscript: t.spans.some(s => s.script === "superscript"),
      fontChanges: new Set(styles.map(s => s.fontFamily ?? "default")).size > 1,
      // Capture run boundaries and font changes without retaining text content.
      runs: t.spans.map(s => ({ length: s.text.length, script: s.script, style: s.style })),
      style: t.style
    };
  });
  return {
    molecules,
    survival: nativeSurvival(document),
    summaryErrors,
    brackets,
    unpairedBrackets,
    reactions: objects.filter(o => o.type === "reaction").flatMap(r => {
      try {
        const role = (name: "reactant" | "product" | "agent") => sorted(r.components.filter(c => c.role === name).map(c => participant(c.objectId)));
        const conditions = sorted(r.conditionsTextObjectIds.map(id => {
          const text = objects.find(o => o.id === id && o.type === "text");
          if (!text || text.type !== "text") throw new Error("Chemistry summary failed: reaction condition text is missing.");
          return text.text;
        }));
        return [{ objectId: r.id, reactants: role("reactant"), products: role("product"), agents: role("agent"), conditions,
          arrowKinds // The native reaction model has no arrow references: these are document arrow kinds.
        }];
      } catch (error) {
        summaryErrors.push({ objectId: r.id, summaryError: stageError("summary", error) });
        return [];
      }
    }),
    standaloneAbbreviations: objects.filter(o => o.type === "superatom").map(o => ({ label: o.label, expandedFragment: o.metadata.expandedStructure })),
    standaloneRGroups: objects.filter(o => o.type === "r-group-label").map(o => ({ label: o.label, semantics: o.display.querySemantics })),
    drawing: {
      pages: document.pages.length,
      arrows: arrowKinds,
      brackets: sorted(objects.filter(o => o.type === "bracket").map(o => ({ kind: o.bracketKind, repeatUnitLabel: o.label }))),
      "text-styling": { objects: texts.length, styled: textStyles.filter(s => s.bold || s.italic || s.subscript || s.superscript || s.fontChanges).length, bold: textStyles.filter(s => s.bold).length, italic: textStyles.filter(s => s.italic).length, subscript: textStyles.filter(s => s.subscript).length, superscript: textStyles.filter(s => s.superscript).length, fontChanges: textStyles.filter(s => s.fontChanges).length, signatures: sorted(textStyles) },
      colours: sorted([...colours]),
      "other-graphics": sorted(objects.filter(o => !["molecule", "reaction", "reaction-arrow", "mechanism-arrow", "text", "bracket", "superatom", "r-group-label"].includes(o.type) && !arrowKind(o)).map(o => o.type === "graphic" ? `graphic.${o.graphicKind}` : o.type))
    }
  };
}
