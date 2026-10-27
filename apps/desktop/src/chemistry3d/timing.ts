import { ensureRdkit, type RdkitJsMol } from "@chemdraft/rdkit-adapter";

/** Internal opt-in diagnostics, never part of the public chemistry result. */
export interface Chemistry3dTiming { stage: string; ms: number; details?: Record<string, unknown> }
export type Chemistry3dTimingSink = (event: Chemistry3dTiming) => void;

/** Only called by the explicit profiling path. Normal jobs do not patch bindings or read clocks.
 * One job runs at a time in each pool worker. Restore every binding even on a refusal. */
export async function profileChemistry3d<T>(run: (sink: Chemistry3dTimingSink) => Promise<T>, sink: Chemistry3dTimingSink): Promise<T> {
  const load = performance.now();
  const rdkit = await ensureRdkit();
  sink({ stage: "wasm.ensure (fetch/read+compile+init on first call)", ms: performance.now() - load });
  const getMol = rdkit.get_mol;
  let attempt = 0;
  rdkit.get_mol = function (...args: Parameters<typeof getMol>) {
    const start = performance.now();
    const mol = getMol.apply(rdkit, args);
    sink({ stage: "rdkit.parse", ms: performance.now() - start });
    if (!mol) return mol;
    const wrap = (name: "generate_3d_embed" | "optimize_3d_conformer") => {
      const original = mol[name];
      if (!original) return;
      mol[name] = Object.assign(function (details: string) {
        const started = performance.now();
        const options = JSON.parse(details) as Record<string, unknown>;
        let result: string | undefined;
        try { result = original.call(mol, details); return result; }
        finally {
          const payload = result ? JSON.parse(result) as { embedOk?: boolean; forceField?: unknown } : {};
          sink({ stage: name === "generate_3d_embed" ? "embed.attempt" : "minimize.binding",
            ms: performance.now() - started,
            details: { ...options, ...(name === "generate_3d_embed" ? { attempt: ++attempt, embedOk: payload.embedOk } : { result: payload.forceField }) } });
        }
      } as RdkitJsMol[typeof name], original);
    };
    wrap("generate_3d_embed");
    wrap("optimize_3d_conformer");
    return mol;
  };
  // Embind overload dispatch consults this.get_mol.overloadTable on the installed function.
  Object.assign(rdkit.get_mol, getMol);
  const started = performance.now();
  try { return await run(sink); }
  finally {
    rdkit.get_mol = getMol;
    sink({ stage: "worker.job", ms: performance.now() - started });
  }
}
