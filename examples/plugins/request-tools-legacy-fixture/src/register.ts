import type { PluginCommandContext, PluginWorkerRegistration } from "@chemdraft/plugin-api";
import { actions, commandId, manifest, panelId } from "./index";

async function report<T>(ctx: PluginCommandContext, action: keyof typeof actions, result: T): Promise<T> {
  await ctx.panels!.showReport(panelId, {
    title: actions[action],
    sections: [{ kind: "text", body: JSON.stringify(result, null, 2) }]
  });
  return result;
}

export function createLegacyFixtureRegistration(): PluginWorkerRegistration {
  let receivedEvents = 0;
  return {
    manifest,
    commandHandlers: {
      [commandId("readDocument")]: async ctx => {
        const document = await ctx.documents!.getActiveDocument();
        return report(ctx, "readDocument", { title: document?.title ?? null });
      },
      [commandId("readSelection")]: async ctx => {
        const selection = await ctx.selection!.getSelection();
        return report(ctx, "readSelection", { objectIds: selection.objectIds });
      },
      [commandId("beginRequest")]: async ctx => {
        const result = await ctx.requests!.begin({ label: "Legacy fixture request" });
        if (result.ok) await ctx.requests!.end({ requestId: result.value.requestId });
        return report(ctx, "beginRequest", result);
      },
      [commandId("events")]: ctx => report(ctx, "events", { receivedEvents })
    },
    onToolCall: () => ({ ok: true, value: null }),
    onActiveDocumentChanged: () => { receivedEvents += 1; }
  };
}
