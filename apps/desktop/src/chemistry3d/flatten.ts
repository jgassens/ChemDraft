import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import type { MoleculeObject, ViewMatrix } from "@chemdraft/chem-core";
import { normalizeNativeMoleculeGeometry } from "@chemdraft/document-workflow-core";
import type { Plugin3DMethod, PluginFlatten3DRequest, PluginFlatten3DResult } from "@chemdraft/plugin-api";
import type { RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { flattenNativeMolecule3d, type StereoPerceiver } from "../documentWorkflow";
import { conformerCentroid } from "../interaction/spinOverlay";
import { projectPoint, quatFromAxisAngle, quatToViewMatrix } from "../interaction/rotation3d";
import { assertFlattenContacts, readGraph } from "./model";
import { assertComponentStereo, specifiedCenters, stereoGraph, unspecifiedStereoDoubleBonds } from "./stereo";

function canonical(rdkit: RdkitMinimalModule, input: string): string {
  const mol = rdkit.get_mol(input, JSON.stringify({ removeHs: true }));
  if (!mol) throw new Error("RDKit could not read back the flattened structure.");
  try {
    const smiles = mol.get_smiles?.();
    if (!smiles) throw new Error("RDKit canonical stereo SMILES is unavailable.");
    return smiles;
  } finally { mol.delete(); }
}

function rotation9(matrix: ViewMatrix): number[] { return [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]]; }
function matrix4(r: number[]): ViewMatrix { return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1]; }

/** auto is deterministic: identity, then 30/60/120 degrees about [1,2,3], [1,0,0], [0,1,0].
 * First view that passes every component's stereo read-back wins. No cleanup or re-embedding. */
export const AUTO_3D_VIEWS = [rotation9(quatToViewMatrix({ x: 0, y: 0, z: 0, w: 1 })),
  ...([[1, 2, 3], [1, 0, 0], [0, 1, 0]] as const).flatMap(axis => [30, 60, 120].map(degrees =>
    rotation9(quatToViewMatrix(quatFromAxisAngle(axis, degrees * Math.PI / 180)))))];

export function flattenPluginModel(request: PluginFlatten3DRequest, method: Plugin3DMethod, rdkit: RdkitMinimalModule): PluginFlatten3DResult {
  const { model } = request;
  assertFlattenContacts(model);
  // Refuse unsupported isotope storage before any depiction or view search.
  model.components.forEach((component, index) => {
    const labels = [...new Set(model.atoms.slice(component.atomStart, component.atomStart + component.atomCount)
      .flatMap(atom => atom.isotope ? [`${atom.isotope}${atom.element}`] : []))];
    if (labels.length) throw new Error(`Component ${index + 1} (${component.smiles}) carries isotope labels (${labels.join(", ")}), which ChemDraft drawings cannot store yet; flatten3d refuses rather than drop them.`);
  });
  // CTAB's 'either' flag does not survive native bond serialization. Refuse only bonds
  // RDKit perceives as potential E/Z, until native open-double-bond storage exists.
  model.components.forEach((component, index) => {
    const open = unspecifiedStereoDoubleBonds(rdkit, component.smiles);
    if (open.length) throw new Error(`Component ${index + 1} (${component.smiles}): double bond ${open[0]}${open.length > 1 ? ` (first of ${open.length})` : ""} has no E/Z in the input, and ChemDraft drawings cannot store an open double bond yet; specify / or \\ in the SMILES.`);
  });
  model.components.forEach((_, index) => assertComponentStereo(rdkit, model, index, "flatten3d input"));
  const perceiveStereo: StereoPerceiver = molfile => {
    const mol = rdkit.get_mol(molfile, JSON.stringify({ removeHs: false }));
    if (!mol) throw new Error("RDKit could not perceive flattened stereochemistry.");
    try {
      const graph = readGraph(mol).molecules[0];
      const cip = new Map((graph.extensions as { cipCodes?: [number, string][] }[] | undefined)?.flatMap(ext => ext.cipCodes ?? []) ?? []);
      return graph.atoms.map((_, i) => ({ isStereoCenter: cip.has(i),
        descriptor: cip.get(i) === "R" ? "R" : cip.get(i) === "S" ? "S" : "unspecified" }));
    } finally { mol.delete(); }
  };
  // Depict the signed INPUT graph, before add_hs: input-explicit H atoms survive, while
  // model-only Hs become implicit again. RDKit chooses heavy-atom wedges on this graph,
  // rather than deleting a wedged H and losing/inverting its centre. add_hs appends atoms,
  // so filtering the signed addedHydrogen flags gives exactly this input atom order.
  const references = model.components.map((component, componentIndex) => {
    const mol = rdkit.get_mol(component.smiles, JSON.stringify({ removeHs: false }));
    if (!mol) throw new Error("RDKit could not read the signed component SMILES.");
    try {
      if (!mol.set_new_coords || !mol.get_molblock) throw new Error("RDKit 2D stereo depiction is unavailable.");
      const expected = canonical(rdkit, component.smiles);
      const intent = stereoGraph(mol);
      const centers = specifiedCenters(intent);
      // Stereo-free references need no 2D depiction: the shared helper replaces
      // coordinates anyway. Stereo references need wedges/geometry, now on the
      // retained input graph rather than the much larger explicit-H model.
      if (/[@/\\]/.test(expected)) mol.set_new_coords(false);
      const graph = parseMolfileGraph(mol.get_molblock());
      const retained = model.atoms.slice(component.atomStart, component.atomStart + component.atomCount)
        .flatMap((atom, i) => atom.element === "H" && atom.addedHydrogen ? [] : [component.atomStart + i]);
      if (graph.atoms.length !== retained.length) throw new Error("RDKit changed the atom count while preparing flatten3d.");
      const native: MoleculeObject = {
        id: `mol_plugin3d_${globalThis.crypto.randomUUID()}`, type: "molecule", x: 0, y: 0, width: 0, height: 0,
        rotation: 0, style: {}, structure: "", structureFormat: "molfile-v2000", superatoms: [], rGroups: [],
        atoms: graph.atoms.map((atom, i) => {
          // The lightweight molfile graph reader does not retain every atom property.
          // Restore charge and radicals from the signed graph, in unchanged atom order.
          const source = model.atoms[retained[i]];
          return { ...atom, y: -atom.y, formalCharge: source.charge,
            ...(source.radical ? { markRadicals: source.radical } : {}) };
        }),
        bonds: graph.bonds.map(bond => ({ id: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId,
          order: bond.order, ...(bond.bondStyle ? { display: { bondStyle: bond.bondStyle } } : {}) }))
      };
      return { native, expected, centers,
        coords: retained.flatMap(i => model.coords.slice(i * 3, i * 3 + 3)) };
    } catch (error) {
      throw new Error(`Component ${componentIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { mol.delete(); }
  });
  const rotations = request.view === "auto" ? AUTO_3D_VIEWS : [request.view.rotation];
  let lastError: unknown;
  for (const rotation of rotations) {
    try {
      const view = matrix4(rotation);
      const objects: MoleculeObject[] = [];
      const depthByAtom: number[][] = [];
      const warnings: string[] = [];
      references.forEach(({ native, expected, coords, centers }, index) => {
        const center = conformerCentroid(coords);
        // Rotate component centres too, preserving the plugin's relative placement. 20 px/A is
        // fixed, independent of document state. The shared helper supplies ALL projection math.
        const rotatedCenter = projectPoint(view, center);
        const centerX = rotatedCenter[0] * 20;
        const centerY = -rotatedCenter[1] * 20;
        const outcome = flattenNativeMolecule3d(native, coords, view, {
          placement: { centerX, centerY, scale: 20 },
          stereoCenterAtomIds: new Set([...centers].map(i => native.atoms[i].id)),
          ...(native.atoms.length <= 999 && native.bonds.length <= 999 ? { perceiveStereo } : {})
        });
        if (!outcome.molecule || outcome.status !== "committed") {
          throw new Error(`Component ${index + 1}: flatten3d refused this view: ${outcome.refusalReasons.join("; ")}`);
        }
        const actual = canonical(rdkit, outcome.molecule.structure);
        if (actual !== expected) {
          throw new Error(`Component ${index + 1}: flatten3d would change canonical SMILES with stereochemistry (expected ${expected}, got ${actual}); choose another view or restore the input geometry.`);
        }
        // Use the same atom/label padding as SMILES paste at the plugin result boundary.
        // Only the frame changes; projection, stereo, depth and component offsets stay intact.
        objects.push(normalizeNativeMoleculeGeometry(outcome.molecule));
        depthByAtom.push(native.atoms.map((_, i) => projectPoint(view, [coords[i * 3] - center[0],
          coords[i * 3 + 1] - center[1], coords[i * 3 + 2] - center[2]])[2]));
        warnings.push(...outcome.warnings.map(warning => `Component ${index + 1}: ${warning.message}`));
        if (outcome.crossings?.length) warnings.push(`Component ${index + 1}: projected bond crossings are not included in the returned objects; page crossing overrides require a separate document patch.`);
      });
      return { objects, depthByAtom, warnings, method: { ...method, viewRotation: [...rotation],
        conventions: [...method.conventions, "Flattening uses the Spin 3D ScreenPlacement contract at 20 document px/Angstrom; no force field is run.",
          "auto: first stereo-preserving view from identity, then 30/60/120 degrees about [1,2,3], X, Y."] } };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
