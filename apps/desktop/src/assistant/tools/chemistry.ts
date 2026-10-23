import type { AssistantToolContext } from "../AssistantToolContext";
import { findObject, inspectSmiles } from "../writeBuilder";
import { requireDocument } from "../AssistantToolContext";
import type { ToolInput } from "./schemas";

export async function nameToStructure(context: AssistantToolContext, input: ToolInput<"name_to_structure">) {
  return context.chemistry.nameToStructure(input);
}
export async function validateSmiles(context: AssistantToolContext, input: ToolInput<"validate_smiles">) {
  try { return await inspectSmiles(context, input.smiles); }
  catch (error) { return { valid: false, reason: error instanceof Error ? error.message : String(error) }; }
}
export async function structureToName(context: AssistantToolContext, input: ToolInput<"structure_to_name">) {
  const { object } = findObject(requireDocument(context), input.objectId);
  if (object.type !== "molecule") throw new Error(`${object.id} is not a molecule.`);
  return context.chemistry.structureToName(input);
}
