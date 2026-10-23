import type { PluginPermission } from "@chemdraft/plugin-api";
import {
  assistantScope, recordAssistantInsertions, requireDocument, type AssistantToolContext
} from "./AssistantToolContext";
import { toolJsonSchema, toolSchemas, type AssistantToolName, type ToolInput } from "./tools/schemas";
import * as read from "./tools/read";
import * as chemistry from "./tools/chemistry";
import * as write from "./tools/write";

export interface AssistantToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; mimeType: "image/png"; data: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface AssistantToolDefinition {
  name: AssistantToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: readonly PluginPermission[];
  timeoutMs: number;
  readOnly: boolean;
  handler(context: AssistantToolContext, input: unknown): Promise<unknown>;
}
const READ: PluginPermission[] = ["document.read"];
const WRITE: PluginPermission[] = ["document.write", "document.read"];
const CHEM_WRITE: PluginPermission[] = [...WRITE, "chemistry.compute"];
function define<N extends AssistantToolName>(name: N, description: string, permissions: PluginPermission[],
  readOnly: boolean, handler: (context: AssistantToolContext, input: ToolInput<N>) => unknown, timeoutMs = 30_000): AssistantToolDefinition {
  return { name, description, inputSchema: toolJsonSchema(name), permissions, timeoutMs, readOnly,
    handler: async (context, input) => handler(context, toolSchemas[name].parse(input) as ToolInput<N>) };
}
// The amended table enumerates fourteen names (four reads, three chemistry, seven writes).
export const ASSISTANT_TOOLS: readonly AssistantToolDefinition[] = [
  define("get_document", "Read a bounded summary of the pinned document. inScope marks objects the request may change.", READ, true, read.getDocument),
  define("get_selection", "Read the objects selected when Send was pressed; empty means only insertion is allowed.", ["selection.read"], true, read.getSelection),
  define("get_structure", "Read a molecule's live graph as SMILES or molfile, with conversion warnings.", READ, true, read.getStructure),
  define("render", "Render a page or objects as PNG, at most 4 MiB and 1568 px by default.", READ, true, read.render),
  define("name_to_structure", "Parse a chemical name with the local OPSIN engine.", ["chemistry.compute", "native.execute"], true, chemistry.nameToStructure, 60_000),
  define("validate_smiles", "Validate SMILES using RDKit, reporting canonical SMILES, formula, and heavy atom count (maximum 500).", ["chemistry.compute"], true, chemistry.validateSmiles),
  define("structure_to_name", "Name a document molecule using the installed naming engine; never opens an install dialog.", ["chemistry.compute", "native.execute", "selection.read"], true, chemistry.structureToName, 60_000),
  define("insert_structures", "Insert up to 24 molecule/text items in a host-positioned row or grid; labels go below molecules.", CHEM_WRITE, false, write.insertStructures, 60_000),
  define("insert_reaction", "Insert a reaction scheme with up to six reactants and six products, plus reagent and condition labels.", CHEM_WRITE, false, write.insertReaction, 60_000),
  define("insert_text", "Insert up to 2000 characters, optionally beside a document object. The host chooses coordinates.", WRITE, false, write.insertText),
  define("edit_structure", "Replace an in-scope molecule with verified SMILES, preserving its centre by default.", CHEM_WRITE, false, write.editStructure, 60_000),
  define("delete_objects", "Delete up to 100 in-scope objects. Any out-of-scope id refuses the entire call.", WRITE, false, write.deleteObjects),
  define("style_objects", "Change only style on up to 100 in-scope objects; atoms and bonds stay unchanged.", WRITE, false, write.styleObjects),
  define("move_objects", "Move up to 100 in-scope objects beside another object or into a row/grid, using host coordinates.", WRITE, false, write.moveObjects)
];
export function listAssistantTools() {
  return ASSISTANT_TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description,
    inputSchema: structuredClone(inputSchema), annotations: { readOnlyHint: readOnly, idempotentHint: readOnly } }));
}
function result(value: unknown): AssistantToolResult {
  if (value && typeof value === "object" && "content" in value) return value as AssistantToolResult;
  return { content: [{ type: "text", text: JSON.stringify(value) }],
    ...(value && typeof value === "object" ? { structuredContent: value as Record<string, unknown> } : {}) };
}

/** Runtime validation and permission enforcement also apply to in-process callers. */
export async function callAssistantTool(context: AssistantToolContext, name: string, input: unknown): Promise<AssistantToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    const tool = ASSISTANT_TOOLS.find(tool => tool.name === name);
    if (!tool) throw new Error(`Unknown assistant tool "${name}".`);
    requireDocument(context);
    for (const permission of tool.permissions) {
      if (!context.plugin.permissions.includes(permission)) throw new Error(`Assistant tool ${name} requires ${permission}.`);
    }
    // Share run scope with the original context, but prevent work finishing after the deadline from writing.
    const guarded: AssistantToolContext = { ...context, getInsertedObjectIds: () => [...assistantScope(context)],
      write: async patch => {
        if (!active) throw new Error(`Assistant tool ${name} timed out.`);
        requireDocument(context);
        const beforeIds = new Set(context.getDocument()!.pages.flatMap(page => page.objects.map(object => object.id)));
        const written = await context.write(patch);
        recordAssistantInsertions(context, written.objectIds.filter(id => !beforeIds.has(id)));
        return written;
      }
    };
    const value = await Promise.race([
      tool.handler(guarded, input), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { active = false; reject(new Error(`Assistant tool ${name} timed out after ${tool.timeoutMs} ms.`)); }, tool.timeoutMs);
      })
    ]);
    return result(value);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  } finally { active = false; if (timer) clearTimeout(timer); }
}
