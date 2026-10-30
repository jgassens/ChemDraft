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
    // Open-E/Z perception parses with removeHs:false to keep its atom/bond correspondence.
    // Fold ordinary explicit H first, as the default SMILES depiction does. RDKit decides
    // which H can be folded and retains isotope-labelled H and specified stereochemistry.
    let input = smiles;
    if (/\[H\b/.test(smiles)) {
      const { ensureRdkit } = await import("@chemdraft/rdkit-adapter");
      const molecule = (await ensureRdkit()).get_mol(smiles, JSON.stringify({ removeHs: true }));
      try {
        const normalized = molecule?.get_smiles?.(JSON.stringify({ canonical: false }));
        if (!normalized) throw new Error("RDKit could not normalize explicit hydrogens for SMILES paste.");
        input = normalized;
      } finally { molecule?.delete(); }
    }
    return fromMolfile(await generateMolfile(input, {
      ...options,
      openUnspecifiedDoubleBonds: true,
      onStandardMolfile: (molfile) => onStandard(fromMolfile(molfile))
    }));
  } catch (error) {
    if (!ocl) throw error;
    if (options.rdkitLoadFailure !== undefined) warnings.push(`RDKit failed to load: ${options.rdkitLoadFailure}; used OpenChemLib fallback.`);
    // Preserve the existing complete local fallback, including its chemistry refusal errors.
    let fallback: ReturnType<NonNullable<typeof ocl>["depictSmiles2D"]>;
    try { fallback = ocl.depictSmiles2D(smiles, { openUnspecifiedDoubleBonds: true }); }
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
        bonds: fallback.bonds.map(({ from, to, order, wedge, stereo }) => ({ from, to, order, wedge, ...(stereo ? { stereo } : {}) }))
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
