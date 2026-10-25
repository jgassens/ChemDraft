import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type ChemDraftDocument } from "@chemdraft/chem-core";
import { ASSISTANT_COMMANDS } from "./commandCatalog";
import { callAssistantTool } from "./assistantTools";
import { testContext } from "./tools/testContext";
import { testCommandRegistry } from "./testCommandRegistry";
import { groupSelectedDocumentObjects, rotateSelectedDocumentObjects90 } from "../documentWorkflow";

afterEach(() => vi.useRealTimers());
describe("assistant registry commands", () => {
  it("lists only the explicit catalog, with typed metadata and no excluded command categories", async () => {
    const { context } = testContext();
    context.commands = { has: () => true, invoke: vi.fn() };
    const result = await callAssistantTool(context, "list_commands", {});
    const content = result.content[0];
    expect(content?.type).toBe("text");
    const catalog = JSON.parse(content && "text" in content ? content.text : "null");
    expect(catalog).toEqual(ASSISTANT_COMMANDS);
    expect(catalog).toHaveLength(20);
    for (const command of ASSISTANT_COMMANDS) {
      expect(Object.keys(command).sort()).toEqual(["actsOn", "changesChemistry", "id", "needsSelection", "title", "whenToUse"]);
      expect(command.id).not.toMatch(/^(?:file|document|export|print|preferences|plugin|plugins|network|clipboard|debug|view)\./);
      expect(command.id).not.toMatch(/(?:dialog|prompt|settings|preferences|install|download)/i);
      expect(command.whenToUse).not.toMatch(/\n/);
      expect(command.changesChemistry).toBe(false);
    }
    for (const id of ["document.open", "document.save", "export.open", "view.togglePreferences", "clipboard.copy", "plugin.demo.run", "debug.open", "layout.adjustArrangementSpacing", "structure.rotate3d"]) {
      expect(await callAssistantTool(context, "run_command", { id })).toMatchObject({ isError: true });
    }
    expect(context.commands.invoke).not.toHaveBeenCalled();
  });
  it("uses the captured selection via the same registry, even when the live menu is disabled", async () => {
    const { context, molecule, text, replace } = testContext();
    replace({ ...context.getDocument()!, selection: { objectIds: [text.id] } });
    const registry = testCommandRegistry(context, "layout.rotate90", target => {
      expect(target.getDocument().selection.objectIds).toEqual([molecule.id]);
      target.commit(rotateSelectedDocumentObjects90);
    });
    const invoke = vi.spyOn(registry, "invoke");
    const result = await callAssistantTool(context, "run_command", { id: "layout.rotate90", args: {} });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(context.write).toHaveBeenCalledOnce();
    expect(context.getDocument()!.pages[0]!.objects.find(object => object.id === text.id)).toEqual(text);
  });
  it("refuses the entire call when a later staged edit is outside scope", async () => {
    const { context, molecule, text } = testContext();
    const before = structuredClone(context.getDocument());
    testCommandRegistry(context, "layout.rotate90", target => {
      for (const objectId of [molecule.id, text.id]) target.commit(doc => applyPatch(doc, { op: "updateObject", objectId, changes: { x: 800 } }));
    });
    expect(await callAssistantTool(context, "run_command", { id: "layout.rotate90" })).toMatchObject({ isError: true,
      content: [{ text: expect.stringContaining(text.id) }] });
    expect(context.getDocument()).toEqual(before);
    expect(context.write).not.toHaveBeenCalled();
  });
  it("refuses a cleanup that drops a molecule instead of preserving its identity", async () => {
    const { context, molecule } = testContext();
    testCommandRegistry(context, "structure.cleanup2d", target => {
      target.commit(doc => applyPatch(doc, { op: "removeObject", objectId: molecule.id }));
    });
    expect(await callAssistantTool(context, "run_command", { id: "structure.cleanup2d" })).toMatchObject({ isError: true,
      content: [{ text: "refused: would change identity" }] });
    expect(context.write).not.toHaveBeenCalled();
  });
  it("does not widen selection when grouping inserts an object; later calls may edit that insertion", async () => {
    const { context, molecule, text } = testContext();
    context.getSelectionAtSend = () => [molecule.id, text.id];
    testCommandRegistry(context, "layout.group", target => { target.commit(groupSelectedDocumentObjects); });
    const grouped = await callAssistantTool(context, "run_command", { id: "layout.group" });
    expect(grouped.isError, JSON.stringify(grouped)).not.toBe(true);
    const group = context.getDocument()!.pages[0]!.objects.find(object => object.type === "group")!;
    expect(group).toBeDefined();
    expect((await callAssistantTool(context, "style_objects", { objectIds: [group.id], style: { color: "#112233" } })).isError).not.toBe(true);
  });
  it("refuses reorder calls whose whole-page patch would include out-of-scope ids", async () => {
    const { context, text } = testContext();
    testCommandRegistry(context, "layout.sendToBack", target => {
      target.commit(doc => applyPatch(doc, { op: "setObjectOrder", pageId: doc.pages[0]!.id, objectIds: doc.pages[0]!.objects.map(object => object.id).reverse() }));
    });
    expect(await callAssistantTool(context, "run_command", { id: "layout.sendToBack" })).toMatchObject({ isError: true,
      content: [{ text: expect.stringContaining(text.id) }] });
    expect(context.write).not.toHaveBeenCalled();
  });
  it.each(["structure.spin3d", "structure.openInteractive3d"])("%s opens the view without a document write", async id => {
    const { context, molecule } = testContext();
    const before = structuredClone(context.getDocument());
    const open = vi.fn(target => { expect(target.getDocument().selection.objectIds).toEqual([molecule.id]); });
    testCommandRegistry(context, id, open);
    expect(await callAssistantTool(context, "run_command", { id })).toMatchObject({ structuredContent: { summary: "opened the 3D view", objectIds: [] } });
    expect(open).toHaveBeenCalledOnce();
    expect(context.getDocument()).toEqual(before);
    expect(context.write).not.toHaveBeenCalled();
  });
  it("rejects a view handler attempting a write or reporting failure", async () => {
    const { context } = testContext();
    testCommandRegistry(context, "structure.spin3d", target => { target.commit(doc => doc); });
    expect(await callAssistantTool(context, "run_command", { id: "structure.spin3d" })).toMatchObject({ isError: true });
    testCommandRegistry(context, "structure.spin3d", () => { throw new Error("3D engine unavailable"); });
    expect(await callAssistantTool(context, "run_command", { id: "structure.spin3d" })).toMatchObject({ isError: true,
      content: [{ text: "3D engine unavailable" }] });
    expect(context.write).not.toHaveBeenCalled();
  });
  it("refuses stale command results after an asynchronous preparation", async () => {
    const { context, replace, text } = testContext();
    testCommandRegistry(context, "layout.rotate90", async target => {
      target.commit(rotateSelectedDocumentObjects90);
      await Promise.resolve();
      replace(applyPatch(context.getDocument()!, { op: "updateObject", objectId: text.id, changes: { x: 99 } }));
    });
    expect(await callAssistantTool(context, "run_command", { id: "layout.rotate90" })).toMatchObject({ isError: true,
      content: [{ text: expect.stringContaining("document changed") }] });
    expect(context.write).not.toHaveBeenCalled();
  });
  it("prevents a timed-out command from later staging writes or opening a view", async () => {
    vi.useFakeTimers();
    const { context } = testContext();
    let release!: () => void;
    const open = vi.fn();
    testCommandRegistry(context, "structure.spin3d", async target => {
      await new Promise<void>(resolve => { release = resolve; });
      target.assertActive();
      open();
    });
    const pending = callAssistantTool(context, "run_command", { id: "structure.spin3d" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await pending).isError).toBe(true);
    release();
    await vi.runAllTimersAsync();
    expect(open).not.toHaveBeenCalled();
    expect(context.write).not.toHaveBeenCalled();
  });
  it("rejects document-level effects that cannot be expressed by the permitted patches", async () => {
    const { context } = testContext();
    testCommandRegistry(context, "layout.rotate90", target => { target.commit(doc => ({ ...rotateSelectedDocumentObjects90(doc), title: "Changed" } as ChemDraftDocument)); });
    expect((await callAssistantTool(context, "run_command", { id: "layout.rotate90" })).isError).toBe(true);
    expect(context.write).not.toHaveBeenCalled();
  });
});
