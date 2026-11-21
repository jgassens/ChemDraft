import { runPluginWorker, type PluginRequestJsonObject, type PluginRequestResult, type PluginToolCallResult,
  type PluginWorkerRegistration } from "@chemdraft/plugin-api";
import { manifest } from "./requestWorkerManifest";

function value<T>(result: PluginRequestResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const events: { documentKey: string | null; sequence: number }[] = [];
let endSession: (() => void) | undefined;

const registration: PluginWorkerRegistration = {
  manifest,
  onActiveDocumentChanged: event => { events.push(event); },
  commandHandlers: {
    "plugin.requestWorker.events": async () => events,
    "plugin.requestWorker.finishTools": () => { endSession?.(); },
    "plugin.requestWorker.arrange": async ctx => {
      const requests = ctx.requests!;
      const { requestId } = value(await requests.begin({ label: "Arrange captions" }));
      try {
        const context = value(await requests.getContext({ requestId }));
        const { pageId, revision } = context.pages[0]!;
        const read = value(await ctx.documents.readRequest!({ requestId, pageId }));
        const objectIds = read.objects.filter(({ object }) => object.type === "text").map(({ object }) => object.id);
        const depiction = ctx.depiction!;
        const layout = value(await depiction.planLayout!({ requestId, pageId,
          spec: { kind: "row", objectIds, anchor: { x: 40, y: 75 }, gap: 30 } }));
        const patch = { op: "batch" as const,
          patches: layout.transforms.map(({ objectId, changes }) => ({ op: "updateObject" as const, objectId, changes })) };
        const target = { kind: "objects" as const, objectIds };
        const { bounds } = value(await depiction.measure!({ requestId, pageId, target, preview: patch }));
        if (!bounds) throw new Error("The arrangement has no visible ink.");
        // Allow for the page fitter's stored frames as well as the visible ink.
        const requiredBounds = { x: bounds.x - 10, y: bounds.y - 10, width: bounds.width + 20, height: bounds.height + 20 };
        const decision = value(await requests.requestPageSpace!({ requestId, pageId, requiredBounds, revision }));
        if (decision.outcome === "unanswered") return decision;
        const receipt = value(await ctx.documents.applyRequestPatch!({ requestId, patch,
          pageSpace: { pageId, decisionId: decision.decisionId },
          preconditions: read.objects.map(({ object, revision: token }) => ({ kind: "objectRevision", pageId, objectId: object.id, token })) }));
        const png = value(await depiction.renderRegion!({ requestId, pageId, target, widthPx: 120, heightPx: 40 }));
        return { context, objectIds, bounds, decision: decision.outcome, receipt, png };
      } finally { await requests.end({ requestId }); }
    },
    "plugin.requestWorker.openTools": async ctx => {
      const requests = ctx.requests!;
      const { requestId } = value(await requests.begin({ label: "Caption tools" }));
      try {
        value(await ctx.toolSessions!.open({ requestId, hostTools: ["insert_text"], definitions: [
          ...["get_document", "get_selection"].map(name => ({
            name, description: name, readOnly: true, inputSchema: { type: "object" as const, additionalProperties: false }
          })),
          { name: "get_structure", description: "Read a molecule as SMILES.", readOnly: true,
            inputSchema: { type: "object", properties: { objectId: { type: "string" }, format: { type: "string", enum: ["smiles"] } },
              required: ["objectId", "format"], additionalProperties: false } },
          { name: "render", description: "Render the document on a transparent background.", readOnly: true,
            inputSchema: { type: "object", properties: { target: { type: "string", enum: ["document"] },
              background: { type: "string", enum: ["transparent"] } }, required: ["target", "background"], additionalProperties: false } }
        ] }));
        await new Promise<void>(resolve => { endSession = resolve; });
        return await requests.getContext({ requestId });
      } finally {
        endSession = undefined;
        await requests.end({ requestId });
      }
    }
  },
  onToolCall: async (ctx, call): Promise<PluginToolCallResult> => {
    const context = value(await ctx.requests!.getContext({ requestId: call.requestId }));
    const { requestId } = call;
    const { pageId, width, height } = context.pages[0]!;
    const inspect = async (objectId: string) => value(await ctx.chemistry!.inspectStructure!({
      kind: "molecule", requestId, pageId, objectId
    }));
    if (call.name === "get_structure") {
      const objectId = String(call.input.objectId);
      const result = await inspect(objectId);
      return { ok: true, value: { objectId, format: "smiles", structure: result.canonicalIsomericSmiles, warnings: result.warnings } };
    }
    if (call.name === "render") {
      const png = value(await ctx.depiction!.renderRegion!({ requestId, pageId,
        target: { kind: "region", bounds: { x: 0, y: 0, width, height } }, widthPx: width, heightPx: height }));
      return { ok: true, value: { content: [{ type: "image", mimeType: png.mimeType, data: png.base64 }],
        structuredContent: { width: png.widthPx, height: png.heightPx } } };
    }
    const document = (await ctx.documents.getActiveDocument())!;
    const selection = { objectIds: context.selection.map(ref => ref.objectId) };
    const counts: Record<string, number> = {};
    const objects: PluginRequestJsonObject[] = [];
    for (const { object } of value(await ctx.documents.readRequest!({ requestId, pageId })).objects) {
      const { id, type, x, y, width, height } = object;
      counts[type] = (counts[type] ?? 0) + 1;
      const inScope = selection.objectIds.includes(id);
      if (call.name === "get_selection" && !inScope) continue;
      const frame = { id, type, pageId, x, y, width, height, inScope };
      if (object.type === "text" && typeof object.text === "string") objects.push({ ...frame, text: object.text });
      else if (object.type === "reaction-arrow" && typeof object.arrowKind === "string") objects.push({ ...frame, arrowKind: object.arrowKind });
      else if (object.type === "molecule") {
        const result = await inspect(id);
        const rings = value(await ctx.chemistry!.rings!({ requestId, pageId, objectId: id, representation: "drawable" }));
        if (rings.representation !== "drawable") throw new Error("Expected drawable rings.");
        objects.push({ ...frame, atomCount: object.atoms?.length ?? 0, ringKeys: rings.rings.map(ring => ring.key),
          smiles: result.canonicalIsomericSmiles, formula: result.formula, warnings: result.warnings });
      } else throw new Error(`Unexpected object in the fixture drawing: ${id} (${type}).`);
    }
    return { ok: true, value: { title: document.title, selection, objects, truncated: false,
      pages: document.pages.map(({ id, width, height }) => ({ id, width, height })), counts, empty: objects.length === 0 } };
  }
};

runPluginWorker(registration);
