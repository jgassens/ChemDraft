/** Engine failures are remembered for the worker's lifetime, outside the layout budget. */
export interface DepictionEngineAvailability {
  rdkitLoadFailure?: string;
  oclLoadFailure?: string;
}

export async function loadDepictionEngines(
  loadRdkit: () => Promise<unknown>,
  loadOcl: () => Promise<unknown>
): Promise<DepictionEngineAvailability> {
  const [rdkit, ocl] = await Promise.allSettled([
    Promise.resolve().then(loadRdkit), Promise.resolve().then(loadOcl)
  ]);
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const availability = {
    ...(rdkit.status === "rejected" ? { rdkitLoadFailure: message(rdkit.reason) } : {}),
    ...(ocl.status === "rejected" ? { oclLoadFailure: message(ocl.reason) } : {})
  };
  if (rdkit.status === "rejected" && ocl.status === "rejected") {
    throw new Error(`RDKit failed to load: ${availability.rdkitLoadFailure}; OpenChemLib failed to load: ${availability.oclLoadFailure}`);
  }
  return availability;
}
