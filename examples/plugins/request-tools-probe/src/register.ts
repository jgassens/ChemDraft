import type {
  DocumentObject, PluginActiveDocumentChanged, PluginCommandContext, PluginPanelReport,
  PluginRequestArguments, PluginRequestContext, PluginRequestResult, PluginToolCallResult, PluginWorkerRegistration
} from "@chemdraft/plugin-api";
import { actions, commandId, manifest, panelId, probeName, type Action } from "./index";

const insertLabel = "Insert probe text and molecule";
const pageSpaceLabel = "Insert probe overflow text";
const smiles = "CCO";

const definitions: PluginRequestArguments<"toolSessions", "open">["definitions"] = [
  {
    name: "get_document",
    description: "Read the title and page IDs of the pinned document.",
    readOnly: true,
    inputSchema: { type: "object", additionalProperties: false }
  },
  {
    name: "get_selection",
    description: "Read the captured page and object IDs.",
    readOnly: true,
    inputSchema: { type: "object", additionalProperties: false }
  }
];

function required<T>(capability: T | undefined, name: string): T {
  if (!capability) throw new Error(`${name} is unavailable.`);
  return capability;
}

function value<T>(result: PluginRequestResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function details(data: unknown): PluginPanelReport["sections"][number] {
  return { kind: "text", body: typeof data === "string" ? data : JSON.stringify(data, null, 2) };
}

async function show(ctx: PluginCommandContext, title: string, ...sections: PluginPanelReport["sections"]) {
  await required(ctx.panels, "Plugin panels").showReport(panelId, { title, sections });
}

function textObject(text: string, x: number, y: number): Extract<DocumentObject, { type: "text" }> {
  return {
    id: crypto.randomUUID(), type: "text", text, x, y, width: 140, height: 24,
    rotation: 0, style: {}, spans: []
  };
}

function pageFor(snapshot: PluginRequestContext) {
  return snapshot.pages.find(page => page.pageId === snapshot.viewport?.pageId) ?? snapshot.pages[0]!;
}

function selectionTarget(snapshot: PluginRequestContext) {
  const pageId = snapshot.selection[0]?.pageId;
  if (!pageId) throw new Error("Select at least one object on the page and try again.");
  if (snapshot.selection.some(ref => ref.pageId !== pageId)) throw new Error("Select objects on a single page and try again.");
  return { pageId, target: { kind: "objects" as const, objectIds: snapshot.selection.map(ref => ref.objectId) } };
}

type EndRequest = NonNullable<PluginCommandContext["requests"]>["end"];

export function createProbeRegistration(): PluginWorkerRegistration {
  const events: PluginActiveDocumentChanged[] = [];
  let droppedEvents = 0;
  let onSwitch: ((event: PluginActiveDocumentChanged) => void) | undefined;
  let pendingEnd: (() => ReturnType<EndRequest>) | undefined;
  let checkRequest: (() => void) | undefined;

  async function withRequest(
    ctx: PluginCommandContext,
    label: string,
    run: (requestId: string, snapshot: PluginRequestContext, stop: AbortSignal,
      end: () => ReturnType<EndRequest>) => Promise<void>
  ) {
    if (pendingEnd) throw new Error("A probe request is running. Use Probe: End request to release it.");
    const requests = required(ctx.requests, "Request tools");
    const stop = new AbortController();
    let ending: ReturnType<EndRequest> | undefined;
    const begun = requests.begin({ label });
    const end = () => ending ??= (async () => {
      try {
        const result = await begun;
        return result.ok ? await requests.end({ requestId: result.value.requestId }) : result;
      } finally {
        stop.abort();
      }
    })();
    pendingEnd = end;
    try {
      const { requestId } = value(await begun);
      const snapshot = value(await requests.getContext({ requestId }));
      checkRequest = () => {
        void requests.getContext({ requestId }).then(result => {
          if (!result.ok && (result.error.code === "cancelled" || result.error.code === "stale")) stop.abort();
        }).catch(() => stop.abort());
      };
      if (!stop.signal.aborted) await run(requestId, snapshot, stop.signal, end);
    } finally {
      checkRequest = undefined;
      try { await end(); }
      finally { pendingEnd = undefined; }
    }
  }

  async function waitForSwitch(ctx: PluginCommandContext, title: string, documentKey: string, stop: AbortSignal) {
    // Listen before the panel opens so a switch during panel presentation is observed.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const switched = new Promise<PluginActiveDocumentChanged | undefined>(resolve => {
      abort = () => resolve(undefined);
      stop.addEventListener("abort", abort, { once: true });
      if (stop.aborted) abort();
      onSwitch = event => {
        if (event.documentKey && event.documentKey !== documentKey) resolve(event);
      };
      timeout = setTimeout(abort, 45_000);
    });
    try {
      await show(ctx, title, details("Switch tab now. Click a different document tab within 45 seconds."),
        details({ pinnedDocumentKey: documentKey }));
      const event = await switched;
      if (!event && !stop.aborted) await show(ctx, title, details("No tab switch was observed. Run the command again."));
      return stop.aborted ? undefined : event;
    } finally {
      onSwitch = undefined;
      clearTimeout(timeout);
      stop.removeEventListener("abort", abort);
    }
  }

  const handlers: Record<Action, (ctx: PluginCommandContext) => Promise<void>> = {
    pinnedRead: ctx => withRequest(ctx, "Read pinned document", async (requestId, snapshot, stop) => {
      const event = await waitForSwitch(ctx, actions.pinnedRead, snapshot.documentKey, stop);
      if (!event) return;
      const { pageId } = pageFor(snapshot);
      const read = value(await required(ctx.documents.readRequest, "Pinned read")({ requestId, pageId }));
      const document = await ctx.documents.getActiveDocument();
      const captured = value(await ctx.requests!.getContext({ requestId }));
      await show(ctx, actions.pinnedRead, details({
        pinnedTitle: document?.title,
        pinnedDocumentKey: captured.documentKey,
        activeDocumentKey: event.documentKey,
        capturedSelection: captured.selection,
        pageId,
        objects: read.objects.map(({ object }) => ({
          objectId: object.id, type: object.type,
          text: object.type === "text" && typeof object.text === "string" ? object.text.slice(0, 200) : undefined
        })),
        moreObjects: Boolean(read.nextCursor)
      }));
    }),

    insert: ctx => withRequest(ctx, insertLabel, async (requestId, snapshot, stop) => {
      const molecule = await required(ctx.chemistry?.structureFromSmiles, "SMILES depiction")({ smiles, origin: probeName });
      if (!molecule.available || !molecule.built) throw new Error(molecule.reason);
      if (molecule.object.type !== "molecule") throw new Error("SMILES depiction did not return a molecule.");
      const event = await waitForSwitch(ctx, actions.insert, snapshot.documentKey, stop);
      if (!event) return;
      const { pageId } = pageFor(snapshot);
      const label = textObject(`Probe insertion (${smiles})`, molecule.object.x, Math.max(0, molecule.object.y - 36));
      const receipt = value(await required(ctx.documents.applyRequestPatch, "Request patch")({
        requestId,
        patch: { op: "batch", patches: [
          { op: "addObject", pageId, object: label },
          { op: "addObject", pageId, object: molecule.object }
        ] },
        expectedStructures: [{ kind: "insertion", opIndex: 1, sourceSmiles: smiles }]
      }));
      await show(ctx, actions.insert, details({ undoLabel: insertLabel, smiles, receipt }));
    }),

    outsideScope: ctx => withRequest(ctx, "Attempt out-of-scope edit", async (requestId, snapshot) => {
      const { pageId } = pageFor(snapshot);
      const selected = new Set(snapshot.selection.filter(ref => ref.pageId === pageId).map(ref => ref.objectId));
      const read = required(ctx.documents.readRequest, "Pinned read");
      let cursor: string | undefined;
      do {
        const page = value(await read({ requestId, pageId, ...(cursor ? { cursor } : {}) }));
        const target = page.objects.find(({ object }) => object.type === "text" && !selected.has(object.id));
        if (target) {
          const { object, revision } = target;
          const result = await required(ctx.documents.applyRequestPatch, "Request patch")({
            requestId,
            patch: { op: "moveObject", objectId: object.id, x: object.x + 1, y: object.y },
            preconditions: [{ kind: "objectRevision", pageId, objectId: object.id, token: revision }]
          });
          const expectedRefusal = !result.ok && result.error.code === "scope";
          await show(ctx, actions.outsideScope, details({ objectId: object.id, expectedRefusal, result }));
          return;
        }
        cursor = page.nextCursor;
      } while (cursor);
      throw new Error("Leave a text object unselected on the active page and try again.");
    }),

    pageSpace: async ctx => {
      const mode = ctx.input?.source === "panel" && ctx.input.panelId === panelId ? ctx.input.controlId : undefined;
      if (mode !== "ask" && mode !== "ask-and-end") {
        await show(ctx, actions.pageSpace, {
          kind: "actions", id: "page-space", buttons: [
            { id: "ask", label: "Ask for page space", commandId: commandId("pageSpace"), disabled: false, tone: "default" },
            { id: "ask-and-end", label: "Ask and end after 10 seconds", commandId: commandId("pageSpace"), disabled: false, tone: "default" }
          ]
        });
        return;
      }
      await withRequest(ctx, pageSpaceLabel, async (requestId, snapshot, stop, end) => {
        const { pageId, revision, width, height } = pageFor(snapshot);
        const object = textObject("Probe overflow", -40, 72);
        const requiredBounds = { x: -64, y: 48, width: 256, height: 96 };
        const ask = required(ctx.requests?.requestPageSpace, "Page-space decisions");
        if (mode === "ask-and-end") {
          value(await required(ctx.toolSessions, "Tool sessions").open({ requestId, definitions }));
        }
        // The modal prompt suspends the floating panel. This mode lets the owner end the
        // request while the question is visible, without relying on access to another window.
        let timedEnd: ReturnType<EndRequest> | undefined;
        const timer = mode === "ask-and-end" ? setTimeout(() => { timedEnd = end(); void timedEnd.catch(() => {}); }, 10_000) : undefined;
        try {
          const decision = value(await ask({ requestId, pageId, revision, requiredBounds }));
          const before = { width, height, requestedPosition: { x: object.x, y: object.y } };
          if (mode === "ask-and-end") {
            const ended = timedEnd ? await timedEnd.catch(error => ({ ok: false as const,
              error: { code: "cancelled" as const, message: String(error) } })) : undefined;
            const passed = Boolean(timedEnd && ended?.ok && decision.outcome === "unanswered");
            await show(ctx, actions.pageSpace, details({ check: passed ? "PASSED" : "FAILED", decision: decision.outcome,
              before, applied: false, ended }));
            return;
          }
          if (decision.outcome === "unanswered" || stop.aborted) {
            await show(ctx, actions.pageSpace, details({ decision: decision.outcome, before, applied: false }));
            return;
          }
          const receipt = value(await required(ctx.documents.applyRequestPatch, "Request patch")({
            requestId,
            patch: { op: "addObject", pageId, object },
            pageSpace: { pageId, decisionId: decision.decisionId }
          }));
          const after = value(await ctx.requests!.getContext({ requestId })).pages.find(page => page.pageId === pageId);
          const inserted = value(await required(ctx.documents.readRequest, "Pinned read")({
            requestId, pageId, objectIds: receipt.insertions.map(item => item.objectId)
          })).objects[0]?.object;
          await show(ctx, actions.pageSpace, details({ decision: decision.outcome, before,
            after: { width: after?.width, height: after?.height, x: inserted?.x, y: inserted?.y },
            applied: true, undoLabel: pageSpaceLabel, receipt }));
        } finally {
          clearTimeout(timer);
        }
      });
    },

    openSession: ctx => withRequest(ctx, "Open probe tool session", async (requestId, snapshot, stop) => {
      const { tools } = value(await required(ctx.toolSessions, "Tool sessions").open({ requestId, definitions }));
      await show(ctx, actions.openSession, details({ tools, pinnedDocumentKey: snapshot.documentKey }),
        details("The session stays open until you run Probe: End request or the pinned document closes."));
      if (!stop.aborted) await new Promise<void>(resolve => stop.addEventListener("abort", () => resolve(), { once: true }));
    }),

    measure: ctx => withRequest(ctx, "Measure selection", async (requestId, snapshot) => {
      const result = value(await required(ctx.depiction, "Depiction").measure({ requestId, ...selectionTarget(snapshot) }));
      await show(ctx, actions.measure, details({
        units: result.units, bounds: result.bounds, objectCount: result.objects.length,
        objects: result.objects.map(({ objectId, bounds, labelBounds, bondLength, atomLabels }) => ({
          objectId, bounds, labelBounds, bondLength, atomLabelCount: atomLabels?.length
        })),
        unsupported: result.unsupported, warnings: result.warnings
      }));
    }),

    render: ctx => withRequest(ctx, "Render selection PNG", async (requestId, snapshot) => {
      const depiction = required(ctx.depiction, "Depiction");
      const { pageId, target } = selectionTarget(snapshot);
      const { bounds } = value(await depiction.measure({ requestId, pageId, target }));
      if (!bounds) throw new Error("The selection has no measurable ink.");
      const padding = 8;
      const region = { x: bounds.x - padding, y: bounds.y - padding,
        width: bounds.width + 2 * padding, height: bounds.height + 2 * padding };
      const png = value(await depiction.renderRegion({
        requestId, pageId, target: { kind: "region", bounds: region }, widthPx: 400, heightPx: 300
      }));
      await show(ctx, actions.render, {
        kind: "image", dataUri: `data:${png.mimeType};base64,${png.base64}`, alt: "Pinned selection region",
        caption: `${png.widthPx} × ${png.heightPx} pixels`, maxWidthPx: png.widthPx
      }, details({ pageId, bounds: png.bounds, warnings: png.warnings }));
    }),

    events: ctx => show(ctx, actions.events, details({ droppedEvents, events })),

    end: async ctx => {
      const result = pendingEnd ? await pendingEnd() : "There is no running probe request.";
      await show(ctx, actions.end, details(result));
    }
  };

  return {
    manifest,
    commandHandlers: Object.fromEntries((Object.keys(handlers) as Action[]).map(action => [
      commandId(action), async (ctx: PluginCommandContext) => {
        try {
          await handlers[action](ctx);
        } catch (error) {
          await show(ctx, actions[action], details(error instanceof Error ? error.message : String(error)));
        }
      }
    ])),
    onActiveDocumentChanged: event => {
      if (events.length === 100) {
        events.shift();
        droppedEvents += 1;
      }
      events.push(event);
      onSwitch?.(event);
      checkRequest?.();
    },
    onToolCall: async (ctx, call, signal): Promise<PluginToolCallResult> => {
      signal.throwIfAborted();
      if (call.name === "get_document") {
        const document = await ctx.documents.getActiveDocument();
        if (!document) return { ok: false, error: { code: "stale", message: "The pinned document is unavailable." } };
        signal.throwIfAborted();
        return { ok: true, value: { title: document.title, pageIds: document.pages.map(page => page.id) } };
      }
      if (call.name === "get_selection") {
        const snapshot = await required(ctx.requests, "Request tools").getContext({ requestId: call.requestId });
        signal.throwIfAborted();
        return snapshot.ok ? { ok: true, value: { selection: snapshot.value.selection } } : snapshot;
      }
      return { ok: false, error: { code: "invalid", message: "Unknown probe tool." } };
    }
  };
}
