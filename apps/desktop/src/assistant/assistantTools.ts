import type { PluginPermission } from "@chemdraft/plugin-api";
import {
  assistantScope, recordAssistantInsertions, requireDocument, type AssistantToolContext
} from "./AssistantToolContext";
import { toolJsonSchema, toolSchemas, type AssistantToolName, type ToolInput } from "./tools/schemas";
import * as read from "./tools/read";
import * as chemistry from "./tools/chemistry";
import * as write from "./tools/write";
import * as commands from "./tools/commands";

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
export const ASSISTANT_TOOLS: readonly AssistantToolDefinition[] = [
  define("list_commands", "Discover ChemDraft's allowed drawing, layout, cleanup and 3D commands. Call this before saying ChemDraft cannot do something; use run_command for a matching capability.", READ, true, commands.listCommands),
  define("run_command", "Run an id returned by list_commands on the selection captured at Send. Writes use this request's scope and one Undo entry; cleanup refuses identity or stereochemistry changes. 3D view commands open the view without editing the document. Current commands take no args.", [...CHEM_WRITE, "selection.read", "native.execute"], false, commands.runCommand, 60_000),
  define("get_document", "Read a bounded summary of the pinned document. inScope marks objects the request may change; rings and bond IDs support figure placement and explicit crossing references.", READ, true, read.getDocument),
  define("get_selection", "Read the objects selected when Send was pressed; empty means only insertion is allowed.", ["selection.read"], true, read.getSelection),
  define("get_structure", "Read a molecule's live graph as SMILES or molfile, with conversion warnings.", READ, true, read.getStructure),
  define("render", "Render a page or objects as PNG, at most 4 MiB and 1568 px by default.", READ, true, read.render),
  define("name_to_structure", "Parse a chemical name with the local OPSIN engine.", ["chemistry.compute", "native.execute"], true, chemistry.nameToStructure, 60_000),
  define("validate_smiles", "Validate SMILES using RDKit, reporting canonical SMILES, formula, and heavy atom count (maximum 500).", ["chemistry.compute"], true, chemistry.validateSmiles),
  define("structure_to_name", "Name a document molecule using the installed naming engine; never opens an install dialog.", ["chemistry.compute", "native.execute", "selection.read"], true, chemistry.structureToName, 60_000),
  define("insert_structures", "Insert up to 24 molecule/group/text items in a host-positioned row or grid. Molecule labels are captions; group labels are native abbreviation or condensed-formula atoms (e.g. methyl: {kind:'group',label:'CH3'}, Ph, Boc, OTs). Optional to anchors the figure at a center, ring centroid or axis with bond-length offsets and rotation; zOrder sets stacking and crossings:auto or explicit over/under bond references create interlocks without merging molecules. Both crossing objects must be in scope. Render to inspect and refine.", CHEM_WRITE, false, write.insertStructures, 60_000),
  define("insert_reaction", "Insert a reaction scheme with up to six reactants and six products, plus reagent and condition labels. Optional to anchors the whole scheme as a rigid figure; zOrder and crossings use the same scoped batch.", CHEM_WRITE, false, write.insertReaction, 60_000),
  define("insert_text", "Insert up to 2000 characters, optionally beside an object or at a to center/ring/axis anchor, with bond-length offset, rotation and zOrder. The host computes page coordinates.", WRITE, false, write.insertText),
  define("edit_structure", "Replace an in-scope molecule with verified SMILES, preserving its centre by default.", CHEM_WRITE, false, write.editStructure, 60_000),
  define("delete_objects", "Delete up to 100 in-scope objects. Any out-of-scope id refuses the entire call.", WRITE, false, write.deleteObjects),
  define("style_objects", "Change only style on up to 100 in-scope objects; atoms and bonds stay unchanged.", WRITE, false, write.styleObjects),
  define("move_objects", "Move up to 100 in-scope objects beside another, into a row/grid, or by to:{by:{dx,dy}} in document points (x right, y down; each finite and within ±5000; (0,0) is refused). For threading use to:{relativeTo,anchor:'center'|{ringKey}|'axis',offset?:{dx,dy},rotateDeg?}; offsets are page-axis bond lengths, axis aligns long axes before rotation. Explicit anchors allow overlap. crossings:'auto' makes an axle pass over one ring side and under the other, and handles ring-to-ring interlocks; both objects must be in scope. For a catenane offset the rings until they intersect; for Olympiadane place three CBPQT4+ rings and two crown macrocycles successively in a chain. If auto refuses, render and adjust offset/rotation or give [{over:{objectId,bondId},under:{objectId,bondId}}]. zOrder:'front'|'behind'|{above:id}|{below:id} changes whole-object stacking, not threading; only in-scope objects may move through the order; unselected objects keep their content and relative order. Chemistry and separate molecules are preserved.", WRITE, false, write.moveObjects)
];
export function listAssistantTools() {
  return ASSISTANT_TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description,
    inputSchema: structuredClone(inputSchema), annotations: { readOnlyHint: readOnly, idempotentHint: readOnly } }));
}
function result(value: unknown): AssistantToolResult {
  if (value && typeof value === "object" && "content" in value) return value as AssistantToolResult;
  return { content: [{ type: "text", text: JSON.stringify(value) }],
    ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}) };
}

/** Runtime validation and permission enforcement also apply to in-process callers. */
export async function callAssistantTool(context: AssistantToolContext, name: string, input: unknown): Promise<AssistantToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const abort = new AbortController();
  const cancel = () => abort.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", cancel, { once: true });
  if (context.signal?.aborted) cancel();
  let waitForWrite: (() => void) | undefined;
  let resumePreparation: (() => void) | undefined;
  try {
    abort.signal.throwIfAborted();
    const tool = ASSISTANT_TOOLS.find(tool => tool.name === name);
    if (!tool) throw new Error(`Unknown assistant tool "${name}".`);
    requireDocument(context);
    for (const permission of tool.permissions) {
      if (!context.plugin.permissions.includes(permission)) throw new Error(`Assistant tool ${name} requires ${permission}.`);
    }
    // Share run scope with the original context, but prevent work finishing after the deadline from writing.
    const guarded: AssistantToolContext = { ...context, signal: abort.signal,
      getDocument: () => active ? context.getDocument() : undefined,
      getInsertedObjectIds: () => [...assistantScope(context)],
      confirmPageGrowth: async growth => {
        abort.signal.throwIfAborted();
        if (timer) clearTimeout(timer);
        try { return await context.confirmPageGrowth(growth, abort.signal); }
        finally { resumePreparation?.(); }
      },
      write: async (patch, _signal, checkPreconditions) => {
        if (!active) throw new Error(`Assistant tool ${name} timed out.`);
        requireDocument(context);
        const beforeIds = new Set(context.getDocument()!.pages.flatMap(page => page.objects.map(object => object.id)));
        waitForWrite?.();
        const written = await context.write(patch, abort.signal, checkPreconditions);
        recordAssistantInsertions(context, written.objectIds.filter(id => !beforeIds.has(id)));
        return written;
      }
    };
    const value = await Promise.race([
      Promise.resolve().then(() => tool.handler(guarded, input)), new Promise<never>((_, reject) => {
        const deadline = (ms: number) => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { active = false; abort.abort(); reject(new Error(`Assistant tool ${name} timed out after ${ms} ms.`)); }, ms);
        };
        // Preparation keeps its own deadline. Once ready, allow the desktop's 60s gesture
        // gate to settle (including its polling interval) before the tool itself times out.
        waitForWrite = () => deadline(61_000);
        resumePreparation = () => { if (active) deadline(tool.timeoutMs); };
        deadline(tool.timeoutMs);
      })
    ]);
    return result(value);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  } finally {
    active = false; abort.abort(); if (timer) clearTimeout(timer);
    context.signal?.removeEventListener("abort", cancel);
  }
}
