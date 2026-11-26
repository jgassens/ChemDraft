import { elementSymbols, type MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type {
  assertConstrainedLayoutIdentity,
  perceiveDoubleBondStereoFromMolfile,
  perceiveStereoCentersFromMolfile,
  perceiveUnrepresentableStereo
} from "@chemdraft/ocl-adapter";

/**
 * Read-only CIP readout for the canvas context menu ("Stereocentre: R", "Double bond: E").
 *
 * The descriptor always comes from the same OpenChemLib perceivers the app and the CLI
 * `stereo` command use (`@chemdraft/ocl-adapter`), run on the same `stereoPerceptionMolfile`
 * the flatten and layout read-back guards use. Nothing here assigns CIP priorities. A label is
 * produced only when the engine reports a defined R/S or E/Z; anything else (not stereogenic,
 * unspecified, an "either" double bond, a drawing the molfile writer refuses, an engine
 * failure) yields no label, so the menu never shows a guess.
 *
 * A molecule with any atom the writer cannot spell as an element (a label or abbreviation such as
 * "Ph", "CH3" or "OMe", a collapsed superatom, an R-group, a "*") gets no row at all. The writer
 * stands an R-group placeholder in for each such atom; a placeholder ranks apart from every element
 * but not by the group's true CIP priority, so a centre or double bond anywhere in that molecule
 * could read the wrong R/S or E/Z (AGENTS.md §8: decline rather than guess).
 */
export interface StereoEngine {
  perceiveStereoCentersFromMolfile: typeof perceiveStereoCentersFromMolfile;
  perceiveDoubleBondStereoFromMolfile: typeof perceiveDoubleBondStereoFromMolfile;
  /**
   * Axial stereo (atropisomer axes), read by the commit chemistry guard only; the readout never
   * uses it. The default importer (`@chemdraft/ocl-adapter`) always provides both. An engine
   * without them cannot check a molecule that may carry an axis, and the guard refuses such a
   * commit as unchecked rather than passing it.
   */
  perceiveUnrepresentableStereo?: typeof perceiveUnrepresentableStereo;
  /** OpenChemLib's canonical (idcode) identity of two molfiles, stereo parities included; throws when they differ. */
  assertConstrainedLayoutIdentity?: typeof assertConstrainedLayoutIdentity;
}

export type StereoReadoutTarget =
  | { molecule: MoleculeObject; atomId: string }
  | { molecule: MoleculeObject; bondId: string };

export type StereoReadoutPart =
  | { kind: "atom"; atomId: string }
  | { kind: "bond"; bondId: string }
  | { kind: string };

/** The readout target for a single right-clicked atom or bond; undefined for anything else. */
export function stereoReadoutTargetFromPart(
  molecule: MoleculeObject | undefined, part: StereoReadoutPart | undefined
): StereoReadoutTarget | undefined {
  if (!molecule || !part) return undefined;
  if (part.kind === "atom" && "atomId" in part) return { molecule, atomId: part.atomId };
  if (part.kind === "bond" && "bondId" in part) return { molecule, bondId: part.bondId };
  return undefined;
}

// What the V2000 writer emits for a real atom; "D" and "T" are hydrogen isotopes.
const ELEMENT_SYMBOLS: ReadonlySet<string> = new Set([...elementSymbols, "D", "T"]);

/**
 * The molfile the perceiver reads, or undefined when the writer replaced any drawn atom with a
 * placeholder. Decided from the molfile actually written, not by re-deciding which labels spell:
 * every atom line must carry an element symbol, and no `M  RGP` placeholder line may appear.
 * Throws whatever `stereoPerceptionMolfile` throws (query bonds, over 999 atoms).
 */
export function stereoReadoutMolfile(molecule: MoleculeObject): string | undefined {
  const molfile = stereoPerceptionMolfile(molecule);
  const lines = molfile.split("\n");
  const atomCount = Number.parseInt(lines[3]?.slice(0, 3) ?? "", 10);
  if (atomCount !== molecule.atoms.length) return undefined;
  for (let index = 0; index < atomCount; index++) {
    // V2000 atom line: x, y, z (10 columns each), a space, then the 3-column symbol.
    if (!ELEMENT_SYMBOLS.has(lines[4 + index]?.slice(31, 34).trim() ?? "")) return undefined;
  }
  return lines.some(line => line.startsWith("M  RGP")) ? undefined : molfile;
}

/** Synchronous readout against an already loaded engine. Never throws. */
export function stereoReadoutLabel(target: StereoReadoutTarget, engine: StereoEngine): string | undefined {
  const { molecule } = target;
  try {
    if ("atomId" in target) {
      const index = molecule.atoms.findIndex(atom => atom.id === target.atomId);
      if (index < 0) return undefined;
      const molfile = stereoReadoutMolfile(molecule);
      if (!molfile) return undefined;
      // Index-aligned to molecule.atoms: stereoPerceptionMolfile writes atoms in document order,
      // and the perceiver reports in that input order (disconnected components included).
      const center = engine.perceiveStereoCentersFromMolfile(molfile)[index];
      if (!center?.isStereoCenter) return undefined;
      return center.descriptor === "R" || center.descriptor === "S" ? `Stereocentre: ${center.descriptor}` : undefined;
    }
    const bond = molecule.bonds.find(candidate => candidate.id === target.bondId);
    // An "either" (crossed/wavy) double bond is drawn as unspecified; respect it even if the
    // coordinates happen to look E or Z.
    if (!bond || bond.order !== "double" || bond.stereo === "either") return undefined;
    const from = molecule.atoms.findIndex(atom => atom.id === bond.fromAtomId);
    const to = molecule.atoms.findIndex(atom => atom.id === bond.toAtomId);
    if (from < 0 || to < 0) return undefined;
    const molfile = stereoReadoutMolfile(molecule);
    if (!molfile) return undefined;
    const perceived = engine.perceiveDoubleBondStereoFromMolfile(molfile)
      .find(entry => (entry.from === from && entry.to === to) || (entry.from === to && entry.to === from));
    return perceived?.descriptor === "E" || perceived?.descriptor === "Z" ? `Double bond: ${perceived.descriptor}` : undefined;
  } catch {
    // Query bonds (refused by the molfile writer) or an engine failure: show nothing.
    return undefined;
  }
}

type StereoEngineImporter = () => Promise<StereoEngine>;
const defaultImporter: StereoEngineImporter = () => import("@chemdraft/ocl-adapter");
let enginePromise: Promise<StereoEngine> | undefined;

/** Lazily loads the stereo engine once (§13). A failed load is retried on the next request. */
export function loadStereoEngine(importer: StereoEngineImporter = defaultImporter): Promise<StereoEngine> {
  enginePromise ??= importer().catch(error => {
    enginePromise = undefined;
    throw error;
  });
  return enginePromise;
}

/** Test hook: forget the cached engine load. */
export function resetStereoEngineForTests(): void {
  enginePromise = undefined;
}

/** Loads the engine if needed and resolves the label, or undefined when there is none or the
 * engine is unavailable. Never rejects, so a menu can await it without a failure path. */
export async function resolveStereoReadout(
  target: StereoReadoutTarget | undefined, load: () => Promise<StereoEngine> = loadStereoEngine
): Promise<string | undefined> {
  if (!target) return undefined;
  try {
    return stereoReadoutLabel(target, await load());
  } catch {
    return undefined;
  }
}

/** A readout callback for the context menu, or undefined when the target cannot carry one. */
export function stereoReadoutRequest(
  molecule: MoleculeObject | undefined, part: StereoReadoutPart | undefined,
  load?: () => Promise<StereoEngine>
): (() => Promise<string | undefined>) | undefined {
  const target = stereoReadoutTargetFromPart(molecule, part);
  return target ? () => resolveStereoReadout(target, load) : undefined;
}
