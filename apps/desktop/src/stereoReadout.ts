import { elementSymbols, type MoleculeObject } from "@chemdraft/chem-core";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type {
  perceiveDoubleBondStereoFromMolfile,
  perceiveStereoCentersFromMolfile
} from "@chemdraft/ocl-adapter";
import type { contextStereoHits } from "./interaction/hitTest";

/**
 * Read-only CIP readout for the canvas context menu ("Stereocenter: R", "Double bond: E").
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

function stereoLabelsForMolecule(molecule: MoleculeObject, engine: StereoEngine) {
  let molfile: string | undefined;
  try {
    molfile = stereoReadoutMolfile(molecule);
  } catch {
    // Query bonds and other shapes refused by the writer have no readout.
  }
  const atomIndices = new Map(molecule.atoms.map((atom, index) => [atom.id, index]));
  let centers: ReturnType<StereoEngine["perceiveStereoCentersFromMolfile"]> | undefined;
  let doubles: ReturnType<StereoEngine["perceiveDoubleBondStereoFromMolfile"]> | undefined;
  return (target: { atomId: string } | { bondId: string }): string | undefined => {
    if (!molfile) return undefined;
    try {
      if ("atomId" in target) {
        const index = atomIndices.get(target.atomId);
        if (index === undefined) return undefined;
        // The perceiver reports in the molfile's input order, including disconnected components.
        const center = (centers ??= engine.perceiveStereoCentersFromMolfile(molfile))[index];
        if (center?.isStereoCenter && (center.descriptor === "R" || center.descriptor === "S")) {
          return `Stereocenter: ${center.descriptor}`;
        }
        return undefined;
      }
      const bond = molecule.bonds.find(candidate => candidate.id === target.bondId);
      // An "either" double bond is unspecified even when its coordinates look E or Z.
      if (bond?.order !== "double" || bond.stereo === "either") return undefined;
      const from = atomIndices.get(bond.fromAtomId), to = atomIndices.get(bond.toAtomId);
      if (from === undefined || to === undefined) return undefined;
      const perceived = (doubles ??= engine.perceiveDoubleBondStereoFromMolfile(molfile))
        .find(entry => (entry.from === from && entry.to === to) || (entry.from === to && entry.to === from));
      return perceived?.descriptor === "E" || perceived?.descriptor === "Z" ? `Double bond: ${perceived.descriptor}` : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Synchronous readout against an already loaded engine. Never throws. */
export function stereoReadoutLabel(target: StereoReadoutTarget, engine: StereoEngine): string | undefined {
  return stereoLabelsForMolecule(target.molecule, engine)(target);
}

/**
 * How long a right-click whose target stereo reach may change waits for the engine before it opens
 * the ordinary menu instead. The engine load is cached and keeps going, so a later right-click
 * uses it once it arrives.
 */
export const CONTEXT_STEREO_DEADLINE_MS = 1_500;

/** The first geometric candidate the engine can actually describe. */
export async function resolveContextStereo(candidates: ReturnType<typeof contextStereoHits>) {
  try {
    const engine = await loadStereoEngine();
    const readers = new Map<MoleculeObject, ReturnType<typeof stereoLabelsForMolecule>>();
    for (const { molecule, hit } of candidates) {
      let read = readers.get(molecule);
      if (!read) {
        read = stereoLabelsForMolecule(molecule, engine);
        readers.set(molecule, read);
      }
      const label = read(hit);
      if (label) return { hit, label };
    }
  } catch {
    // The menu still opens when the stereo engine is unavailable.
  }
  return undefined;
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
