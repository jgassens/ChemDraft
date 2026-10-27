import { DocumentObjectSchema } from "@chemdraft/chem-core";
import { PluginMinimize3DResultSchema } from "@chemdraft/plugin-api";
import { z } from "zod";

// Internal host checks reuse the existing public model/method/minimization contracts.
// No new SDK shape or version: providers are checked before results reach plugin code.
const schemas = {
  embed3d: PluginMinimize3DResultSchema.pick({ model: true, method: true, warnings: true }),
  minimize3d: PluginMinimize3DResultSchema,
  flatten3d: z.object({
    objects: z.array(DocumentObjectSchema),
    depthByAtom: z.array(z.array(z.number().finite())),
    method: PluginMinimize3DResultSchema.shape.method,
    warnings: PluginMinimize3DResultSchema.shape.warnings
  }).strict()
};

export function chemistry3dResultError(method: keyof typeof schemas, value: unknown): string | undefined {
  const checked = schemas[method].safeParse(value);
  if (checked.success) return undefined;
  const issue = checked.error.issues[0];
  return `chemistry.${method} returned an invalid result at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
}
