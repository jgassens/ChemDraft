import { applyPatch, createEmptyDocument } from "@chemdraft/chem-core";
import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginInvocationDocumentProvider } from "./index";

const manifest = {
  id: "org.test.binding", name: "Binding", version: "1", apiVersion: "^0.1.25", entry: "worker.js",
  permissions: ["document.read", "document.write", "selection.read"],
  contributes: { commands: [{ id: "plugin.binding.run", title: "Run" }] }
};
function provider(key: string) {
  let document = createEmptyDocument({ title: key });
  const apply = vi.fn<PluginInvocationDocumentProvider["applyDocumentPatch"]>(request => {
    document = applyPatch(document, request.patch.patch);
    return { applied: true, objectIds: [] };
  });
  const binding: PluginInvocationDocumentProvider = {
    getDocument: () => document, getDocumentKey: () => key,
    getSelection: () => ({ objectIds: [key], molecules: [] }), applyDocumentPatch: apply
  };
  return { binding, apply, document: () => document };
}
function host(run: (context: PluginCommandContext) => unknown | Promise<unknown>) {
  const globalDocument = vi.fn(() => { throw new Error("Global document provider used"); });
  const globalSelection = vi.fn(() => { throw new Error("Global selection provider used"); });
  const globalApply = vi.fn(() => { throw new Error("Global write provider used"); });
  const runtime = new PluginHost({ getActiveDocument: globalDocument, getSelection: globalSelection, applyDocumentPatch: globalApply });
  runtime.registerPlugin(manifest, { commandHandlers: { "plugin.binding.run": run } });
  return { runtime, globalDocument, globalSelection, globalApply };
}

describe("trusted per-invocation document providers", () => {
  it("isolates concurrent reads, selections and writes without changing global providers", async () => {
    let continueCalls!: () => void;
    const resume = new Promise<void>(resolve => { continueCalls = resolve; });
    const f = host(async ctx => {
      await resume;
      const document = (await ctx.documents.getActiveDocument())!;
      const selection = await ctx.selection!.getSelection();
      await ctx.documents.applyPatch!({ reason: "Insert into captured document", patch: { op: "addObject", pageId: document.pages[0]!.id,
        object: { id: "inserted", type: "text", text: document.title, x: 0, y: 0, width: 10, height: 10, spans: [] } } });
      return { title: document.title, ids: selection.objectIds };
    });
    const a = provider("a"), b = provider("b");
    const first = f.runtime.invokeCommand("plugin.binding.run", { documentProvider: a.binding });
    const second = f.runtime.invokeCommand("plugin.binding.run", { documentProvider: b.binding });
    continueCalls();
    await expect(first).resolves.toEqual({ title: "a", ids: ["a"] });
    await expect(second).resolves.toEqual({ title: "b", ids: ["b"] });
    expect(a.apply).toHaveBeenCalledOnce(); expect(b.apply).toHaveBeenCalledOnce();
    expect(f.globalDocument).not.toHaveBeenCalled(); expect(f.globalSelection).not.toHaveBeenCalled(); expect(f.globalApply).not.toHaveBeenCalled();
  });

  it("copies provider callbacks before an asynchronous selection snapshot", async () => {
    const original = provider("original"), replacement = provider("replacement");
    const f = host(async ctx => (await ctx.documents.getActiveDocument())?.title);
    let resolve!: (value: ReturnType<typeof original.document>) => void;
    original.binding.getDocument = vi.fn().mockImplementationOnce(() => new Promise<ReturnType<typeof original.document>>(done => { resolve = done; }))
      .mockImplementation(original.document);
    const result = f.runtime.invokeCommand("plugin.binding.run", { documentProvider: original.binding });
    original.binding.getDocument = replacement.binding.getDocument;
    resolve(original.document());
    await expect(result).resolves.toBe("original");
  });

  it("does not fall back to an active document when the captured document is unavailable", async () => {
    const f = host(ctx => ctx.documents.getActiveDocument());
    const p = provider("gone"); p.binding.getDocument = () => undefined;
    await expect(f.runtime.invokeCommand("plugin.binding.run", { documentProvider: p.binding,
      writeSelection: { objectIds: [], molecules: [] } })).resolves.toBeUndefined();
    expect(f.globalDocument).not.toHaveBeenCalled();
  });

  it.each(["before read", "during read"] as const)("keeps the document-key guard for bound writes (%s)", async timing => {
    const p = provider("original"); let key = "original";
    p.binding.getDocumentKey = () => key;
    const f = host(ctx => {
      if (timing === "before read") key = "replacement";
      return ctx.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject", pageId: p.document().pages[0]!.id,
        object: { id: "x", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10, spans: [] } } });
    });
    const read = p.binding.getDocument;
    p.binding.getDocument = () => { if (timing === "during read") key = "replacement"; return read(); };
    await expect(f.runtime.invokeCommand("plugin.binding.run", { documentProvider: p.binding, writeSelection: { objectIds: [], molecules: [] } }))
      .rejects.toThrow("The document changed while the plugin was running; nothing was inserted.");
    expect(p.apply).not.toHaveBeenCalled();
  });

  it("keeps document and selection snapshots immutable and independent", async () => {
    const p = provider("original");
    const f = host(async ctx => {
      const document = (await ctx.documents.getActiveDocument())!;
      const selection = await ctx.selection!.getSelection();
      expect(Object.isFrozen(document)).toBe(true);
      expect(Object.isFrozen(document.pages)).toBe(true);
      expect(Object.isFrozen(selection.objectIds)).toBe(true);
      expect(document).not.toBe(p.document());
      return document.title;
    });
    await expect(f.runtime.invokeCommand("plugin.binding.run", { documentProvider: p.binding })).resolves.toBe("original");
  });

  it("does not grant document.write or selection.read just because a provider exists", async () => {
    const p = provider("original");
    const runtime = new PluginHost();
    runtime.registerPlugin({ ...manifest, permissions: [] }, { commandHandlers: { "plugin.binding.run": async ctx => {
      expect(ctx.documents.applyPatch).toBeUndefined(); expect(ctx.selection).toBeUndefined();
      await expect(ctx.documents.getActiveDocument()).rejects.toThrow('requires permission "document.read"');
    } } });
    await runtime.invokeCommand("plugin.binding.run", { documentProvider: p.binding });
    expect(p.apply).not.toHaveBeenCalled();
  });
});
