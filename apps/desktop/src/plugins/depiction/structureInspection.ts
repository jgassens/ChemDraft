import { moleculeBracketWarningMessages, type MoleculeObject } from "@chemdraft/chem-core";
import { chemicalIdentitySource } from "@chemdraft/document-workflow-core";
import { nativeEnhancedStereoAtomIndicators, nativeMoleculeRings, transformPointForObject } from "@chemdraft/layout-engine";
import { PluginRequestLimits, type PluginRequestArguments } from "@chemdraft/plugin-api";
import { RequestWriteError, type RequestDepictionBinding, type RequestDepictionProviders } from "@chemdraft/plugin-host";
import { inspectStructureOffThread } from "../../depiction2d/identityClient";
import type { StructureInspectionDetails, StructureInspector } from "../../depiction2d/identityProtocol";
import { IdentityVerificationTimeoutError, IdentityWorkerUnavailableError } from "../../depiction2d/identityWorkerClient";
import type { StructureInspection } from "../requestWrites/structureIdentity";

type InspectionSource = Extract<PluginRequestArguments<"chemistry", "inspectStructure">, { kind: "serialized" }>["source"];
type Topology = NonNullable<Extract<StructureInspection, { valid: true }>["topology"]>;

function pinnedMolecule(binding: RequestDepictionBinding, pageId: string, objectId: string) {
  const page = binding.document.pages.find(candidate => candidate.id === pageId);
  const objects = page?.objects.filter(object => object.id === objectId);
  const object = objects?.length === 1 ? objects[0] : undefined;
  if (!page || !object || object.type !== "molecule") {
    throw new RequestWriteError("invalid", `Molecule "${objectId}" was not found uniquely on page "${pageId}".`);
  }
  if (!object.atoms.length) throw new RequestWriteError("unsupported", "The molecule has no editable native graph.");
  checkGraphSize(object);
  return { object, page };
}

function checkGraphSize(object: MoleculeObject) {
  if (object.atoms.length > PluginRequestLimits.atomsPerMolecule || object.bonds.length > PluginRequestLimits.bondsPerMolecule) {
    throw new RequestWriteError("limit", "The molecule exceeds the inspection graph limits.");
  }
}

function hasEnhancedStereo(object: MoleculeObject): boolean {
  if (nativeEnhancedStereoAtomIndicators(object).length) return true;
  // Imported graphs can retain the collection only in the stored source. The native writer
  // rebuilds the CTAB from editable atoms and bonds, which cannot describe group membership.
  if (object.structureFormat === "molfile-v3000") return /^M  V30\s+MDLV30\/STE(?:ABS|REL|RAC)/m.test(object.structure);
  if (object.structureFormat === "smiles") {
    const extension = object.structure.split("|", 2)[1];
    return extension !== undefined && /(?:^|,)(?:[&o]\d+|a):\d/.test(extension);
  }
  return false;
}

function nativeSource(object: MoleculeObject, warnings: string[]) {
  try {
    const { molfile, molecule } = chemicalIdentitySource(object, warnings, "v3000");
    checkGraphSize(molecule);
    if (molfile.length > 256 * 1024) throw new RequestWriteError("limit", "The molecule exceeds the molfile size limit.");
    return { molecule, source: { format: "molfile-v3000", structure: molfile } as const };
  } catch (error) {
    if (error instanceof RequestWriteError) throw error;
    throw new RequestWriteError("chemistry", (error as Error).message);
  }
}

/** RDKit retains CTAB order with removeHs disabled. Match bonds by endpoints, since the
 * order and direction of RDKit's bond records need not be the same as the drawing's. */
function mapChemicalRings(topology: Topology, serialized: MoleculeObject, drawn: MoleculeObject, warnings: string[]) {
  const pair = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const indices = new Map(serialized.atoms.map((atom, index) => [atom.id, index]));
  const bonds = new Map(serialized.bonds.map(bond =>
    [pair(indices.get(bond.fromAtomId)!, indices.get(bond.toAtomId)!), bond.id]));
  const mismatch = () => new RequestWriteError("chemistry", "RDKit ring membership could not be mapped to the native graph.");
  const parsedPairs = new Set(topology.bonds.map(([a, b]) => pair(a, b)));
  if (topology.atomCount !== indices.size || topology.atomCount !== serialized.atoms.length ||
      bonds.size !== serialized.bonds.length || new Set(bonds.values()).size !== bonds.size ||
      topology.bonds.length !== bonds.size ||
      parsedPairs.size !== bonds.size || [...parsedPairs].some(key => !bonds.has(key))) throw mismatch();
  if (topology.rings.length > PluginRequestLimits.heavyAtoms) throw new RequestWriteError("limit", "Too many chemical rings.");

  const nativeAtoms = new Set(drawn.atoms.map(atom => atom.id));
  const nativeBonds = new Set(drawn.bonds.map(bond => bond.id));
  let unmapped = 0;
  const rings = topology.rings.flatMap(ring => {
    const atomIds = ring.map(index => {
      const atom = serialized.atoms[index];
      if (!atom) throw mismatch();
      return atom.id;
    });
    const bondIds = ring.map((index, i) => {
      const bondId = bonds.get(pair(index, ring[(i + 1) % ring.length]!));
      if (!bondId) throw mismatch();
      return bondId;
    });
    if (atomIds.some(id => !nativeAtoms.has(id)) || bondIds.some(id => !nativeBonds.has(id))) {
      unmapped++;
      return [];
    }
    return [{ atomIds, bondIds }];
  });
  if (unmapped) warnings.push(`${unmapped} chemical ring(s) in expanded labels have no complete native atom/bond mapping.`);
  return rings;
}

/** MinimalLib auto-detects JSON and CTAB as well as SMILES. Check the envelope before
 * handing the bounded payload to its parser, which validates the molecular grammar. */
export function validateInspectionSource({ format, structure }: InspectionSource): void {
  const invalid = () => new RequestWriteError("invalid", "The structure does not match its declared format.");
  if (format === "smiles") {
    // One SMILES token, optionally followed by a CXSMILES extension. A trailing name is not chemistry.
    if (!/^[A-Za-z0-9@+\-[\]()=#$%./\\:*~<>]+(?:[ \t]+\|[^\r\n|]*\|)?$/.test(structure) ||
        /[\r\n]/.test(structure) || structure.startsWith("InChI=")) throw invalid();
    return;
  }
  const lines = structure.split(/\r?\n/);
  const header = lines[3] ?? "";
  const version = format === "molfile-v2000" ? "V2000" : "V3000";
  const end = lines.findIndex(line => /^M  END\s*$/.test(line));
  if (!header.trimEnd().endsWith(version) || end < 4 || lines.slice(end + 1).some(line => line.trim())) throw invalid();
  // V2000 has two three-column count fields. V3000 moves the unbounded counts into its CTAB.
  const fixedCount = /^ *\d{1,3}$/;
  let atoms: number, bonds: number;
  if (version === "V2000") {
    const a = header.slice(0, 3), b = header.slice(3, 6);
    if (!fixedCount.test(a) || !fixedCount.test(b) || lines.some(line => line.startsWith("M  V30 "))) throw invalid();
    atoms = Number(a);
    bonds = Number(b);
  } else {
    const counts = lines.filter(line => /^M  V30\s+COUNTS\b/.test(line));
    const fields = counts[0]?.match(/^M  V30\s+COUNTS\s+(\d+)\s+(\d+)(?:\s|$)/);
    if (counts.length !== 1 || !fields || !lines.some(line => /^M  V30 BEGIN CTAB\s*$/.test(line))) throw invalid();
    atoms = Number(fields[1]);
    bonds = Number(fields[2]);
  }
  if (atoms > PluginRequestLimits.atomsPerMolecule || bonds > PluginRequestLimits.bondsPerMolecule) {
    throw new RequestWriteError("limit", "Declared CTAB counts exceed the inspection graph limits.");
  }
}

export async function inspectBoundedStructure(source: InspectionSource, signal: AbortSignal,
  details: StructureInspectionDetails, inspect: StructureInspector = inspectStructureOffThread) {
  signal.throwIfAborted();
  const format = source.format === "smiles" ? "smiles" : "molfile";
  validateInspectionSource(source);
  try {
    const result = await inspect(format, source.structure, undefined, signal, details);
    signal.throwIfAborted();
    if (!result.valid) throw new RequestWriteError(result.code ?? "chemistry", result.reason);
    if (result.heavyAtoms > PluginRequestLimits.heavyAtoms) {
      throw new RequestWriteError("limit", `Structure exceeds the ${PluginRequestLimits.heavyAtoms} heavy atom limit.`);
    }
    return result;
  } catch (error) {
    if (error instanceof IdentityWorkerUnavailableError) {
      throw new RequestWriteError("unavailable", `RDKit is unavailable. ${error.message}`);
    }
    if (error instanceof IdentityVerificationTimeoutError) {
      throw new RequestWriteError("limit", "RDKit did not complete inspection within the computation budget.");
    }
    throw error;
  }
}

export function createStructureInspection(inspect: StructureInspector = inspectStructureOffThread):
  Pick<RequestDepictionProviders, "inspectStructure" | "rings"> {
  return {
    async inspectStructure(input, signal, binding) {
      const warnings: string[] = [];
      let source: InspectionSource;
      if (input.kind === "serialized") {
        source = input.source;
      } else {
        if (!binding) throw new RequestWriteError("cancelled", "The molecule inspection requires a live request.");
        const { object, page } = pinnedMolecule(binding, input.pageId, input.objectId);
        const brackets = moleculeBracketWarningMessages(object, { ...binding.document, pages: [page] },
          { atomPosition: transformPointForObject });
        if (brackets.length) throw new RequestWriteError("unsupported", brackets.join(" "));
        if (hasEnhancedStereo(object)) {
          throw new RequestWriteError("unsupported", "Inspection cannot preserve this drawing's enhanced stereochemistry groups.");
        }
        source = nativeSource(object, warnings).source;
      }
      const result = await inspectBoundedStructure(source, signal, "stereochemistry", inspect);
      if (!result.stereochemistry) throw new RequestWriteError("unavailable", "RDKit stereochemistry details are unavailable.");
      return { ok: true, value: { source, canonicalIsomericSmiles: result.canonicalSmiles, formula: result.formula,
        heavyAtoms: result.heavyAtoms, stereochemistry: result.stereochemistry, warnings: [...warnings, ...result.warnings] } };
    },
    async rings(input, binding) {
      const { object } = pinnedMolecule(binding, input.pageId, input.objectId);
      if (new Set(object.atoms.map(atom => atom.id)).size !== object.atoms.length ||
          new Set(object.bonds.map(bond => bond.id)).size !== object.bonds.length) {
        throw new RequestWriteError("chemistry", "Ring membership requires unique native atom and bond IDs.");
      }
      const revision = binding.revision(object);
      const representation = input.representation ?? "both";
      const drawable = () => nativeMoleculeRings(object).map(({ ringKey, atomIds, bondIds }) =>
        ({ key: ringKey, atomIds: [...atomIds], bondIds: [...bondIds] }));
      const warnings: string[] = [];
      if (representation === "drawable") return { ok: true, value: { representation, revision, rings: drawable(), warnings } };
      const { molecule, source } = nativeSource(object, warnings);
      const result = await inspectBoundedStructure(source, binding.signal, "topology", inspect);
      if (!result.topology) throw new RequestWriteError("unavailable", "RDKit ring membership is unavailable.");
      const chemicalRings = mapChemicalRings(result.topology, molecule, object, warnings);
      const common = { revision, warnings: [...warnings, ...result.warnings] };
      return { ok: true, value: representation === "chemical" ? { ...common, representation, rings: chemicalRings }
        : { ...common, representation, chemicalRings, drawableRings: drawable() } };
    }
  };
}
