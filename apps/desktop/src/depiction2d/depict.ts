import { pastedStructureDepictionFromMolfile, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";
import type { Smiles2DOptions } from "@chemdraft/rdkit-adapter";
import type { DepictionEngineAvailability } from "@chemdraft/rdkit-adapter/depiction";

export interface PasteDepiction {
  depiction: PastedStructureDepiction;
  stereoCount: number;
  warnings?: string[];
}

type GenerateMolfile = (smiles: string, options: Smiles2DOptions) => Promise<string>;

/** Worker-only engine chain. OCL layout and stereo perception also stay off the UI thread. */
export async function depictInWorker(
  smiles: string,
  generateMolfile: GenerateMolfile,
  onStandard: (result: PasteDepiction) => void,
  options: Pick<Smiles2DOptions, "standardOnly"> & DepictionEngineAvailability = {}
): Promise<PasteDepiction> {
  const ocl = options.oclLoadFailure === undefined ? await import("@chemdraft/ocl-adapter") : undefined;
  const warnings = options.oclLoadFailure === undefined ? [] :
    [`OpenChemLib failed to load: ${options.oclLoadFailure}; stereo center counts are unavailable.`];
  const fromMolfile = (molfile: string): PasteDepiction => ({
    depiction: pastedStructureDepictionFromMolfile(molfile),
    stereoCount: ocl?.perceiveStereoCentersFromMolfile(molfile)
      .filter((center) => center.isStereoCenter).length ?? 0,
    ...(warnings.length ? { warnings: [...warnings] } : {})
  });
  try {
    if (options.rdkitLoadFailure !== undefined) throw new Error(`RDKit failed to load: ${options.rdkitLoadFailure}`);
    return fromMolfile(await generateMolfile(smiles, {
      ...options,
      onStandardMolfile: (molfile) => onStandard(fromMolfile(molfile))
    }));
  } catch (error) {
    if (!ocl) throw error;
    if (options.rdkitLoadFailure !== undefined) warnings.push(`RDKit failed to load: ${options.rdkitLoadFailure}; used OpenChemLib fallback.`);
    // Preserve the existing complete local fallback, including its chemistry refusal errors.
    let fallback: ReturnType<NonNullable<typeof ocl>["depictSmiles2D"]>;
    try { fallback = ocl.depictSmiles2D(smiles); }
    catch (error) {
      // Only an explicit parser failure is ordinary text. Layout and transport failures must surface.
      if (error instanceof Error && /SmilesParser:/.test(error.message)) {
        Object.assign(error, { notSmiles: true });
      }
      throw error;
    }
    try {
      return fromMolfile(fallback.molfile);
    } catch {
      // Large OCL coordinates can overflow V2000. Keep the existing structured fallback.
      const depiction: PastedStructureDepiction = {
        atoms: fallback.atoms.map(({ element, x, y, charge }) => ({ element, x, y, charge })),
        bonds: fallback.bonds.map(({ from, to, order, wedge }) => ({ from, to, order, wedge }))
      };
      let stereoCount: number;
      try {
        stereoCount = ocl.perceiveStereoCentersFromMolfile(fallback.molfile)
          .filter((center) => center.isStereoCenter).length;
      } catch {
        stereoCount = fallback.bonds.filter((bond) => bond.wedge !== null).length;
      }
      return { depiction, stereoCount, ...(warnings.length ? { warnings: [...warnings] } : {}) };
    }
  }
}
