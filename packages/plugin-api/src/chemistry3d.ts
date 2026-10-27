import type { DocumentObject } from "@chemdraft/chem-core";
import { z } from "zod";

/** Plain, engine-independent data. Coordinates are in Angstrom, in a right-handed y-up frame.
 * Only coords may be edited: the session-bound modelToken authenticates the entire chemical graph.
 * Atom/bond order and component ranges are stable across minimization. */
export const Plugin3DModelSchema = z.object({
  atoms: z.array(z.object({
    element: z.string().regex(/^[A-Z][a-z]?$/),
    charge: z.number().int(),
    isotope: z.number().int().positive().optional(),
    radical: z.number().int().min(0).max(3).optional(),
    component: z.number().int().min(0).max(7),
    addedHydrogen: z.boolean()
  }).strict()).min(1).max(4096),
  bonds: z.array(z.object({
    a: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    order: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("aromatic")])
  }).strict()).max(8192),
  coords: z.array(z.number({ invalid_type_error: "3D model coordinates must all be finite numbers." })
    .finite("3D model coordinates must all be finite numbers.")).max(12288),
  components: z.array(z.object({
    smiles: z.string().min(1).max(5000),
    atomStart: z.number().int().nonnegative(),
    atomCount: z.number().int().positive()
  }).strict()).min(1).max(8),
  modelToken: z.string().min(1).max(256)
}).strict().superRefine((model, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (model.coords.length !== model.atoms.length * 3) issue("3D model coordinates length must equal 3 times its atom count.");
  if (model.atoms.filter(atom => atom.element !== "H").length > 500) issue("3D chemistry accepts at most 500 heavy atoms total.");
  let end = 0;
  model.components.forEach((component, index) => {
    if (component.atomStart !== end || model.atoms.slice(end, end + component.atomCount).some(atom => atom.component !== index)) {
      issue("3D model component ranges must partition the atoms in component order.");
    }
    end += component.atomCount;
  });
  if (end !== model.atoms.length) issue("3D model component ranges must partition the atoms in component order.");
  if (model.bonds.some(bond => bond.a === bond.b || !model.atoms[bond.a] || !model.atoms[bond.b] ||
      model.atoms[bond.a].component !== model.atoms[bond.b].component)) issue("3D model bonds must join distinct atoms within one component.");
});
export type Plugin3DModel = z.infer<typeof Plugin3DModelSchema>;

export const PluginEmbed3DRequestSchema = z.object({
  components: z.array(z.object({ smiles: z.string().min(1).max(5000) }).strict()).min(1).max(8),
  seed: z.number().int().min(0).max(2147483647).optional()
}).strict();
export type PluginEmbed3DRequest = z.infer<typeof PluginEmbed3DRequestSchema>;

export const PluginMinimize3DRequestSchema = z.object({
  model: Plugin3DModelSchema,
  forceField: z.enum(["mmff94s", "mmff94", "uff"]).optional(),
  interfragment: z.boolean({ required_error: "minimize3d interfragment must be a boolean (true or false).",
    invalid_type_error: "minimize3d interfragment must be a boolean (true or false)." }),
  maxIters: z.number().int().min(1).max(20000).optional()
}).strict().superRefine((request, ctx) => {
  if (request.interfragment && request.model.components.length === 1) ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "minimize3d interfragment:true requires more than one component."
  });
});
export type PluginMinimize3DRequest = z.infer<typeof PluginMinimize3DRequestSchema>;

/** Row-major proper rotation; reflections are refused because they invert stereochemistry. */
export const Plugin3DRotationSchema = z.array(z.number().finite()).length(9).superRefine((r, ctx) => {
  if (r.length !== 9) return;
  const dot = (a: number, b: number) => r[a] * r[b] + r[a + 1] * r[b + 1] + r[a + 2] * r[b + 2];
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  if ([0, 3, 6].some(i => Math.abs(dot(i, i) - 1) > 1e-6) ||
      Math.abs(dot(0, 3)) > 1e-6 || Math.abs(dot(0, 6)) > 1e-6 || Math.abs(dot(3, 6)) > 1e-6 || Math.abs(det - 1) > 1e-6) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "flatten3d rotation must be an orthonormal 3x3 proper rotation (determinant +1)." });
  }
});
export const PluginFlatten3DRequestSchema = z.object({
  model: Plugin3DModelSchema,
  /** auto uses the first stereo-preserving view in a fixed list, beginning with identity. */
  view: z.union([z.literal("auto"), z.object({ rotation: Plugin3DRotationSchema }).strict()])
}).strict();
export type PluginFlatten3DRequest = z.infer<typeof PluginFlatten3DRequestSchema>;

export interface Plugin3DMethod {
  engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008";
  embedding: "ETKDGv3";
  seed: number;
  forceField: "none" | "mmff94s" | "mmff94" | "uff";
  interfragment: boolean;
  coordinateUnits: "Angstrom";
  energyUnits: "kcal/mol";
  conventions: string[];
  viewRotation?: number[];
}
export interface PluginEmbed3DResult { model: Plugin3DModel; method: Plugin3DMethod; warnings: string[] }
export interface PluginMinimize3DResult extends PluginEmbed3DResult {
  forceField: { name: "mmff94s" | "mmff94" | "uff"; status: "converged" | "not-converged" | "setup-failed";
    energy: number | null; iterationsBudget: number };
  /** True below 2.2 A, independently of convergence or interaction mode. Never insert a clashing model. */
  clash: boolean;
  closestInterComponentHeavyAtomA?: number;
}

/** Validate structured minimization diagnostics crossing a worker boundary. */
export const PluginMinimize3DResultSchema = z.object({
  model: Plugin3DModelSchema,
  forceField: z.object({
    name: z.enum(["mmff94s", "mmff94", "uff"]),
    status: z.enum(["converged", "not-converged", "setup-failed"]),
    energy: z.number().finite().nullable(),
    iterationsBudget: z.number().int().nonnegative().max(20000)
  }).strict(),
  clash: z.boolean(),
  closestInterComponentHeavyAtomA: z.number().finite().nonnegative().optional(),
  method: z.object({
    engine: z.literal("RDKit MinimalLib Release_2026_03_3 + patches 0001-0008"),
    embedding: z.literal("ETKDGv3"), seed: z.number().int(),
    forceField: z.enum(["none", "mmff94s", "mmff94", "uff"]), interfragment: z.boolean(),
    coordinateUnits: z.literal("Angstrom"), energyUnits: z.literal("kcal/mol"),
    conventions: z.array(z.string()), viewRotation: z.array(z.number().finite()).optional()
  }).strict(),
  warnings: z.array(z.string())
}).strict() satisfies z.ZodType<PluginMinimize3DResult>;
export interface PluginFlatten3DResult {
  objects: DocumentObject[];
  /** Rotated z in Angstrom, centered on each returned molecule's retained atom centroid,
   * in native atom order. Model-added Hs are omitted; input-explicit H atoms remain. */
  depthByAtom: number[][];
  method: Plugin3DMethod;
  warnings: string[];
}
