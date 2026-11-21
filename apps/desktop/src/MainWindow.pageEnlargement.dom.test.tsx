// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, createEmptyDocument, DocumentObjectSchema } from "@chemdraft/chem-core";
import { createSmilesMolecule, normalizeNativeMoleculeGeometry, resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { AssistantCapabilityPermissions } from "@chemdraft/plugin-api";
import { MainWindow } from "./MainWindow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { getAssistantTransactions } from "./assistant/assistantTransaction";
import { createSelectionClipboardPayload, insertNativeTemplateMolecule, serializeSelectionClipboardPayload, setDocumentCustomPageSize, insertNativeTextObject, insertTableIntoDocument } from "./documentWorkflow";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
import * as workflow from "./documentWorkflow";
import * as clipboard from "./clipboard";
import type { DesktopPluginRuntime } from "./plugins/createPluginRuntime";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
const captured = vi.hoisted(() => ({ runtime: undefined as DesktopPluginRuntime | undefined }));
vi.mock("./plugins/createPluginRuntime", async original => {
  const actual = await original<typeof import("./plugins/createPluginRuntime")>();
  return { ...actual, createPluginRuntime: (options: import("./plugins/createPluginRuntime").DesktopPluginRuntimeOptions) => {
    captured.runtime = actual.createPluginRuntime(options); return captured.runtime;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement, restorePrompt: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); restorePrompt?.(); restorePrompt = undefined;
  captured.runtime = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});
async function command(commandId: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
}
const current = () => getAssistantHistoryPort().read("initial")!;
function selectRepeatUnitMolecule(explicit: boolean) {
  const drawing = workflow.applySingleBondToolAtPoint(initial(400), { x: 140, y: 140 });
  const molecule = drawing.pages[0].objects.find(object => object.type === "molecule")!;
  const repeat = toggleBracketRepeatUnit(workflow.insertNativeBracket(drawing,
    { x: 100, y: 100 }, "square", { x: 220, y: 180 }));
  const brackets = repeat.pages[0].objects.filter(object => object.type === "bracket");
  return { molecule, selected: applyPatches(repeat, [
    ...brackets.map(object => ({ op: "updateObject" as const, objectId: object.id,
      changes: { containedObjectIds: explicit ? [molecule.id] : [], crossingBondIds: [] } })),
    { op: "setSelection", objectIds: [molecule.id] }
  ]) };
}
function initial(size: number) {
  return setDocumentCustomPageSize(createEmptyDocument(), { width: size, height: size, unit: "css-px" });
}
const actions = ["template", "bracket stamp", "bracket drag", "text paste", "private paste", "duplicate", "cleanup", "plugin batch", "reviewed proposal"] as const;
describe.each(["macos", "windows"] as const)("mounted page commits on %s", platform => {
  it.each(["plugin", "assistant patch", "reviewed proposal"].flatMap(path => ["enlarge", "keep"].map(answer => ({ path, answer }))))(
    "$path / $answer shifts all affected-page content with one undo and selects only the insertion", async ({ path, answer }) => {
    const blank = initial(100), page = blank.pages[0]!;
    const molecule = createSmilesMolecule(blank, { x: 50, y: 50 }, depictSmiles2D("CC"), "CC");
    const drawing = { ...blank, pages: [{ ...page, objects: [molecule] }, { ...page, id: "second-page", objects: [] }] };
    const prompt = vi.fn(async () => answer);
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    const object = DocumentObjectSchema.parse({ id: "oversized", type: "plus", x: -24, y: -32, width: 176, height: 184 });
    const pluginId = "org.chemdraft.pageShift";
    const transactions = getAssistantTransactions(getAssistantHistoryPort());
    await act(async () => {
      runtime.registerPlugin({ id: pluginId, name: "Page shift", version: "0.1.0", apiVersion: "^0.1.20", entry: "test.js",
        permissions: path === "assistant patch" ? [...AssistantCapabilityPermissions] : [path === "reviewed proposal" ? "document.proposePatch" : "document.write"],
        contributes: { commands: [{ id: "plugin.pageShift.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageShift.insert": async context => {
        const tx = path === "assistant patch" ? await context.assistant!.beginRequest({ prompt: "Insert large content" }) : undefined;
        const patch = { reason: "Insert oversized content", patch: { op: "addObject" as const, pageId: page.id, object } };
        if (path === "reviewed proposal") await context.documents!.proposePatch(patch);
        else {
          if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
          await context.documents.applyPatch(patch);
        }
        if (tx) {
          expect(await transactions.pageEnlargementConsent(tx.requestId, platform).confirm()).toBe(answer);
          await context.assistant!.endRequest(tx);
        }
      } } });
      await runtime.invokeCommand("plugin.pageShift.insert");
    });
    if (path === "reviewed proposal") {
      await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
    }
    const after = current();
    expect(after.selection.objectIds).toEqual([object.id]);
    expect(after.pages[1]).toEqual(before.pages[1]);
    const moved = after.pages[0]!.objects.find(candidate => candidate.id === molecule.id)!;
    if (answer === "enlarge") {
      expect(after.pages[0]).toMatchObject({ width: 176, height: 184 });
      expect(moved).toMatchObject({ x: molecule.x + 24, y: molecule.y + 32,
        atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + 24, y: atom.y + 32 })), bonds: molecule.bonds });
      expect(after.pages[0]!.objects.find(candidate => candidate.id === object.id)).toMatchObject({ x: 0, y: 0 });
    } else {
      expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout); expect(moved).toEqual(molecule);
      expect(after.pages[0]!.objects.find(candidate => candidate.id === object.id)).toEqual(object);
    }
    expect(prompt).toHaveBeenCalledOnce();
    await command("edit.undo"); expect(current()).toEqual(before);
    await command("edit.redo"); expect(current()).toEqual(after);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it.each(["plugin", "assistant patch"].flatMap(path => ["fits", "enlarge", "keep"].flatMap(answer =>
    ["charge mark", "late movement"].map(change => ({ path, answer, change })))))(
    "$path / $answer refuses an unselected object's $change despite page-fit consent, without changing document or undo", async ({ path, answer, change }) => {
    const blank = initial(answer === "fits" ? 1000 : 100), page = blank.pages[0]!;
    const molecule = createSmilesMolecule(blank, { x: 50, y: 50 }, depictSmiles2D("CC"), "CC");
    const prompt = vi.fn(async () => answer);
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={{ ...blank, pages: [{ ...page, objects: [molecule] }] }}
      shortcutPlatform={platform} initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!, pluginId = "org.chemdraft.pageScope";
    const object = DocumentObjectSchema.parse({ id: "oversized", type: "plus",
      x: answer === "fits" ? 400 : -24, y: answer === "fits" ? 400 : -32, width: 176, height: 184 });
    const atom = molecule.atoms[0]!;
    const mark = DocumentObjectSchema.parse({ id: "inserted-charge", type: "electron-mark", markKind: "charge", charge: 1,
      atomAssociation: "explicit", anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id },
      x: atom.x + 12, y: atom.y - 12, width: 18, height: 18 });
    let normalizationCalls = 0;
    if (change === "late movement") {
      const normalize = workflow.normalizeCommittedDocument;
      vi.spyOn(workflow, "normalizeCommittedDocument").mockImplementation(document => {
        const normalized = normalize(document);
        // The first pass is safe. Add a plugin-induced move only at the final history boundary,
        // after the host's approved translation, to prove positions are still protected.
        if (++normalizationCalls === 1) return normalized;
        return { ...normalized, pages: normalized.pages.map(page => ({ ...page, objects: page.objects.map(object =>
          object.id !== molecule.id || object.type !== "molecule" ? object : { ...object, x: object.x + 7,
            atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + 7 })) }) })) };
      });
    }
    await act(async () => {
      runtime.registerPlugin({ id: pluginId, name: "Page scope", version: "0.1.0", apiVersion: "^0.1.20", entry: "test.js",
        permissions: path === "assistant patch" ? [...AssistantCapabilityPermissions] : ["document.write"],
        contributes: { commands: [{ id: "plugin.pageScope.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageScope.insert": async context => {
        const tx = path === "assistant patch" ? await context.assistant!.beginRequest({ prompt: "Insert large content" }) : undefined;
        try {
          await context.documents.applyPatch!({ reason: "Insert large content", patch: {
            op: "batch", patches: (change === "charge mark" ? [object, mark] : [object])
              .map(object => ({ op: "addObject", pageId: page.id, object }))
          } });
        } finally {
          if (tx) expect((await context.assistant!.endRequest(tx)).touchedIds).toEqual([]);
        }
      } } });
      await expect(runtime.invokeCommand("plugin.pageScope.insert")).rejects.toThrow(change === "charge mark"
        ? /Plugin write refused:.*atom.*formal charge/ : /Plugin write refused:.*atom.*x/);
    });
    expect(prompt).toHaveBeenCalledTimes(answer === "fits" ? 0 : 1);
    if (change === "late movement") expect(normalizationCalls).toBe(2);
    expect(current()).toBe(before);
    vi.restoreAllMocks();

    await command("edit.undo"); expect(current()).toBe(before);
    await command("edit.redo"); expect(current()).toBe(before);
  });

  it.each([false, true])("keeps direct bracket edits out of scope and records host cleanup with the molecule deletion (assistant: %s)", async assistant => {
    const { molecule, selected } = selectRepeatUnitMolecule(false);
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!, pluginId = "org.chemdraft.repeatDelete";
    const close = before.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")!;
    const transactions = getAssistantTransactions(getAssistantHistoryPort());
    const txId = assistant ? transactions.beginAssistantTransaction({ pluginId, runId: "repeat-delete",
      label: "Delete repeat unit", tabId: "initial", sendSelection: { objectIds: [molecule.id] } }) : undefined;
    await act(async () => {
      const remove = { op: "removeObject", objectId: molecule.id } as const;
      runtime.registerPlugin({ id: pluginId, name: "Repeat delete", version: "0.1.0", apiVersion: "^0.1.25",
        entry: "test.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.repeatDelete.edit", title: "Edit" }, { id: "plugin.repeatDelete.remove", title: "Delete" }] }
      }, { commandHandlers: {
        "plugin.repeatDelete.edit": context => context.documents.applyPatch!({ reason: "Edit unselected bracket", patch: {
          op: "batch", patches: [remove, { op: "updateObject", objectId: close.id, changes: { label: "m" } }]
        } }),
        "plugin.repeatDelete.remove": context => context.documents.applyPatch!({ reason: "Delete selected molecule", patch: remove })
      } });
      await expect(runtime.invokeCommand("plugin.repeatDelete.edit")).rejects.toThrow(`${close.id} was not selected`);
    });
    expect(current()).toBe(before);
    const normalize = vi.spyOn(workflow, "normalizeCommittedDocument");
    await act(async () => {
      await expect(runtime.invokeCommand("plugin.repeatDelete.remove")).resolves.toMatchObject({ applied: true, objectIds: [] });
      if (txId) transactions.endAssistantTransaction(txId, { touchedIds: [] });
    });
    expect(normalize.mock.calls.some(([draft]) =>
      draft.pages[0].objects.filter(object => object.type === "bracket").length === 2)).toBe(true);
    const after = current();
    expect(after.pages[0].objects).toEqual([]);
    await command("edit.undo");
    expect(current()).toEqual(before);
    expect(container.querySelector("[data-status-message]")?.textContent)
      .toBe(assistant ? "Undid ChemDraft Assistant: Delete repeat unit" : "Undid Repeat delete: Delete");
    await command("edit.redo");
    expect(current()).toEqual(after);
  });

  it.each([false, true])("runs assistant delete_objects cleanup only after the authored write passes scope (explicit members: %s)", async explicit => {
    const { molecule, selected } = selectRepeatUnitMolecule(explicit);
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.repeatTool", name: "Repeat tool", version: "0.1.0", apiVersion: "^0.1.25",
        entry: "test.js", permissions: [...AssistantCapabilityPermissions],
        contributes: { commands: [{ id: "plugin.repeatTool.run", title: "Delete" }] }
      }, { commandHandlers: { "plugin.repeatTool.run": async context => {
        const assistant = context.assistant!;
        const { requestId } = await assistant.beginRequest({ prompt: "Delete repeat member" });
        const result = await assistant.callTool({ name: "delete_objects", input: { objectIds: [molecule.id] } });
        await assistant.endRequest({ requestId });
        return result;
      } } });
      const result = await runtime.invokeCommand("plugin.repeatTool.run");
      if (explicit) expect(result).toMatchObject({ isError: true,
        content: [{ type: "text", text: expect.stringContaining("unselected bracket") }] });
      else expect(result).toMatchObject({ structuredContent: { objectIds: [molecule.id] } });
    });
    const after = current();
    if (explicit) expect(after).toBe(before);
    else expect(after.pages[0].objects).toEqual([]);
    await command("edit.undo");
    expect(current()).toEqual(before);
    await command("edit.redo");
    expect(current()).toEqual(after);
  });

  it.each(["plugin bond edit", "plugin deletion", "assistant delete_objects"])(
    "matches 1.2.0 mixed-repeat-unit authorization for %s", async operation => {
    const blank = initial(400);
    const pageId = blank.pages[0].id;
    const chain = createSmilesMolecule(blank, { x: 150, y: 130 }, depictSmiles2D("CCC"), "CCC");
    const [a, b, c] = chain.atoms.map((atom, i) => ({ ...atom, x: [130, 150, 275][i], y: 130 }));
    const edited = { ...chain, id: "edited", atoms: [a, b, c], bonds: [
      { ...chain.bonds[0], fromAtomId: a.id, toAtomId: b.id },
      { ...chain.bonds[1], fromAtomId: b.id, toAtomId: c.id }
    ] };
    const protectedMolecule = { ...createSmilesMolecule(blank, { x: 145, y: 164 }, depictSmiles2D("CC"), "CC"), id: "protected" };
    const stored = { ...protectedMolecule, id: "stored", x: 177, atoms: [], bonds: [], chemistry: undefined };
    const drawing = applyPatches(blank, [edited, protectedMolecule, stored].map(object => ({ op: "addObject", pageId, object })));
    const repeat = toggleBracketRepeatUnit(workflow.insertNativeBracket(drawing,
      { x: 100, y: 100 }, "square", { x: 220, y: 200 }));
    const glyphs = repeat.pages[0].objects.filter(object => object.type === "bracket");
    const edit = operation === "plugin bond edit";
    const selected = applyPatches(repeat, [
      ...glyphs.map(object => ({ op: "updateObject" as const, objectId: object.id, changes: {
        containedObjectIds: [stored.id], crossingBondIds: [{ objectId: edited.id, bondId: edited.bonds[1].id }]
      } })),
      { op: "setSelection", objectIds: edit ? [edited.id] : [stored.id, ...glyphs.map(object => object.id)] }
    ]);
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    const protectedBefore = before.pages[0].objects.find(object => object.id === protectedMolecule.id);
    const assistant = operation === "assistant delete_objects";
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.mixedUnit", name: "Mixed unit", version: "0.1.0", apiVersion: "^0.1.25", entry: "test.js",
        permissions: assistant ? [...AssistantCapabilityPermissions] : ["document.write"],
        contributes: { commands: [{ id: "plugin.mixedUnit.run", title: "Edit mixed repeat unit" }] }
      }, { commandHandlers: { "plugin.mixedUnit.run": async context => {
        if (assistant) {
          const { requestId } = await context.assistant!.beginRequest({ prompt: "Delete the stored molecule" });
          try { return await context.assistant!.callTool({ name: "delete_objects", input: { objectIds: [stored.id] } }); }
          finally { await context.assistant!.endRequest({ requestId }); }
        }
        return context.documents!.applyPatch!({ reason: "Edit mixed repeat unit", patch: edit
          ? { op: "updateObject", objectId: edited.id, changes: { bonds: [{ ...edited.bonds[0], toAtomId: c.id }, edited.bonds[1]] } }
          : { op: "removeObject", objectId: stored.id }
        });
      } } });
      const result = runtime.invokeCommand("plugin.mixedUnit.run");
      if (edit) await expect(result).rejects.toThrow(/molecule "protected" was changed.*chemistry.*not selected/);
      else await expect(result).resolves.toMatchObject(assistant
        ? { structuredContent: { objectIds: [stored.id] } }
        : { applied: true });
    });
    if (edit) expect(current()).toBe(before);
    else {
      expect(current().pages[0].objects.some(object => object.id === stored.id)).toBe(false);
      expect(current().pages[0].objects.filter(object => object.type === "bracket")).toHaveLength(2);
      expect(current().pages[0].objects.find(object => object.id === protectedMolecule.id)).toEqual(protectedBefore);
    }
  });

  it.each([false, true])("keeps a replacement SRU with reused ids while a plugin command is pending (page fit: %s)", async pageFit => {
    const { molecule, selected } = selectRepeatUnitMolecule(false);
    let answer!: (value: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    if (pageFit) restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    const originals = before.pages[0].objects.filter(object => object.type === "bracket");
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let completion!: ReturnType<DesktopPluginRuntime["invokeCommand"]>;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.pendingDelete", name: "Pending delete", version: "0.1.0", apiVersion: "^0.1.25",
        entry: "test.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.pendingDelete.run", title: "Delete" }] }
      }, { commandHandlers: { "plugin.pendingDelete.run": async context => {
        const remove = { op: "removeObject", objectId: molecule.id } as const;
        if (!pageFit) {
          await pending;
          return context.documents!.applyPatch!({ reason: "Delete original member", patch: remove });
        }
        const oversized = DocumentObjectSchema.parse({ id: "oversized", type: "plus", x: 100, y: 100, width: 480, height: 480 });
        return context.documents!.applyPatch!({ reason: "Replace original member", patch: { op: "batch", patches: [
          remove, { op: "addObject", pageId: before.pages[0].id, object: oversized }
        ] } });
      } } });
      completion = runtime.invokeCommand("plugin.pendingDelete.run");
    });
    if (pageFit) expect(prompt).toHaveBeenCalledOnce();
    const removed = workflow.deleteSelectedDocumentObjects(before, originals.map(object => object.id));
    let replaced = toggleBracketRepeatUnit(workflow.insertNativeBracket(removed,
      pageFit ? { x: 100, y: 100 } : { x: 275, y: 250 }, "square",
      pageFit ? { x: 220, y: 180 } : { x: 360, y: 320 }));
    if (pageFit) {
      // The user redraws the same values while the confirmation holds a prepared commit.
      replaced = applyPatches(replaced, originals.map(glyph => ({ op: "updateObject", objectId: glyph.id,
        changes: { containedObjectIds: glyph.containedObjectIds, crossingBondIds: glyph.crossingBondIds } })));
      expect(replaced.pages[0].objects).toEqual(before.pages[0].objects);
    }
    const replacement = replaced.pages[0].objects.filter(object => object.type === "bracket");
    expect(replacement.map(({ id, pairId, side }) => ({ id, pairId, side })))
      .toEqual(originals.map(({ id, pairId, side }) => ({ id, pairId, side })));
    await act(async () => { getAssistantHistoryPort().push("initial", before, replaced, "Replace brackets"); });
    await act(async () => {
      if (pageFit) {
        answer("keep");
        await expect(completion).rejects.toThrow("The drawing changed while the page question was open");
      } else {
        finish();
        await expect(completion).resolves.toMatchObject({ applied: true });
      }
    });
    if (!pageFit) {
      expect(current().pages[0].objects).toEqual(replacement);
      await command("edit.undo");
    }
    expect(current()).toEqual(replaced);
  });

  it.each(["no intervening edit", "redraw before acceptance", "redraw during page fit"] as const)(
    "accepts a deletion proposal with exact undo and redo after %s", async scenario => {
      const { molecule, selected } = selectRepeatUnitMolecule(false);
      const needsFit = scenario === "redraw during page fit";
      let answer!: (decision: string) => void;
      const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
      restorePrompt = setNativePromptProvider(prompt);
      await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
        initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
      const before = current(), runtime = captured.runtime!;
      const pageId = before.pages[0].id;
      const originals = before.pages[0].objects.filter(object => object.type === "bracket");
      const oversized = DocumentObjectSchema.parse({ id: "oversized", type: "plus", x: 100, y: 100, width: 480, height: 480 });
      const removal = { op: "removeObject", objectId: molecule.id } as const;
      const patch = needsFit ? { op: "batch" as const, patches: [
        removal, { op: "addObject" as const, pageId, object: oversized }
      ] } : removal;
      await act(async () => {
        runtime.registerPlugin({ id: "org.chemdraft.reviewDelete", name: "Review delete", version: "0.1.0", apiVersion: "^0.1.25",
          entry: "test.js", permissions: ["document.proposePatch"],
          contributes: { commands: [{ id: "plugin.reviewDelete.run", title: "Propose deletion" }] }
        }, { commandHandlers: { "plugin.reviewDelete.run": context => context.documents.proposePatch({
          reason: "Delete original member", patch
        }) } });
        await runtime.invokeCommand("plugin.reviewDelete.run");
      });
      await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
      const accept = () => act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
      if (needsFit) {
        await accept();
        expect(prompt).toHaveBeenCalledOnce();
      }
      if (scenario !== "no intervening edit") {
        const removed = workflow.deleteSelectedDocumentObjects(before, originals.map(object => object.id));
        const redrawn = toggleBracketRepeatUnit(workflow.insertNativeBracket(removed,
          { x: 100, y: 100 }, "square", { x: 220, y: 180 }));
        const replacement = applyPatches(redrawn, originals.map(glyph => ({ op: "updateObject", objectId: glyph.id,
          changes: { containedObjectIds: glyph.containedObjectIds, crossingBondIds: glyph.crossingBondIds } })));
        expect(replacement.pages[0].objects).toEqual(before.pages[0].objects);
        await act(async () => getAssistantHistoryPort().push("initial", before, replacement, "Redraw repeat unit"));
      }
      const beforeAccept = current();
      if (needsFit) {
        await act(async () => answer("keep"));
        expect(runtime.host.listProposedPatches("pending")).toHaveLength(1);
        expect(current()).toBe(beforeAccept);
      }
      await accept();
      if (needsFit) {
        expect(prompt).toHaveBeenCalledTimes(2);
        await act(async () => answer("keep"));
      }
      expect(runtime.host.listProposedPatches("pending")).toHaveLength(0);
      const accepted = current();
      expect(accepted.pages[0].objects.some(object => object.id === molecule.id)).toBe(false);
      expect(accepted.pages[0].objects.filter(object => object.type === "bracket"))
        .toEqual(scenario === "no intervening edit" ? [] : originals);
      await command("edit.undo");
      expect(current()).toBe(beforeAccept);
      await command("edit.redo");
      expect(current()).toBe(accepted);
    }
  );

  it("cleans up a populated SRU after an accepted write removes its last temporary member", async () => {
    const { molecule, selected } = selectRepeatUnitMolecule(false);
    const temporary = { ...molecule, id: "temporary" };
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.swapMember", name: "Swap member", version: "0.1.0", apiVersion: "^0.1.25",
        entry: "test.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.swapMember.run", title: "Swap repeat member" }] }
      }, { commandHandlers: { "plugin.swapMember.run": async context => {
        const apply = context.documents!.applyPatch!;
        await apply({ reason: "Add a temporary member", patch: { op: "addObject", pageId: before.pages[0].id, object: temporary } });
        await apply({ reason: "Remove the original member", patch: { op: "removeObject", objectId: molecule.id } });
        expect(current().pages[0].objects.filter(object => object.type === "bracket")).toHaveLength(2);
        return apply({ reason: "Remove the temporary member", patch: { op: "removeObject", objectId: temporary.id } });
      } } });
      await expect(runtime.invokeCommand("plugin.swapMember.run")).resolves.toMatchObject({ applied: true });
    });
    expect(current().pages[0].objects).toEqual([]);
    await command("edit.undo");
    expect(current().pages[0].objects.map(object => object.id)).toEqual([
      ...before.pages[0].objects.filter(object => object.type === "bracket").map(object => object.id), temporary.id
    ]);
  });

  it("keeps an empty SRU and its containing group when separate plugin writes add and delete a temporary member", async () => {
    const blank = initial(400);
    const emptyUnit = toggleBracketRepeatUnit(workflow.insertNativeBracket(blank,
      { x: 100, y: 100 }, "square", { x: 220, y: 180 }));
    const page = emptyUnit.pages[0];
    const group = DocumentObjectSchema.parse({ id: "group", type: "group", x: 100, y: 100,
      width: 120, height: 80, childObjectIds: page.objects.map(object => object.id) });
    const reaction = DocumentObjectSchema.parse({ id: "reaction", type: "reaction", x: 100, y: 100, width: 120, height: 80,
      mappingState: "absent", components: [], conditionsTextObjectIds: [group.id] });
    const drawing = applyPatches(emptyUnit, [group, reaction].map(object => ({ op: "addObject", pageId: page.id, object })));
    const temporary = createSmilesMolecule(blank, { x: 150, y: 140 }, depictSmiles2D("CC"), "CC");
    await act(async () => root.render(<MainWindow initialDocument={applyPatch(drawing, { op: "setSelection", objectIds: [] })}
      shortcutPlatform={platform} initialActiveToolCommandId="tool.select" initialPaletteMode="hidden"
      initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.tempMember", name: "Temporary member", version: "0.1.0", apiVersion: "^0.1.25",
        entry: "test.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.tempMember.run", title: "Discard a draft" }] }
      }, { commandHandlers: { "plugin.tempMember.run": async context => {
        await expect(context.documents.applyPatch!({ reason: "Add a draft",
          patch: { op: "addObject", pageId: page.id, object: temporary }
        })).resolves.toMatchObject({ objectIds: [temporary.id] });
        return context.documents.applyPatch!({ reason: "Discard the draft", patch: { op: "removeObject", objectId: temporary.id } });
      } } });
      await expect(runtime.invokeCommand("plugin.tempMember.run")).resolves.toMatchObject({ applied: true, objectIds: [] });
    });
    expect(current().pages[0].objects).toEqual(before.pages[0].objects);
  });

  it("cuts the selected glyph and all the selected member atoms in one undo entry", async () => {
    const size = 400;
    const blank = initial(size);
    const molecule = createSmilesMolecule(blank, { x: 140, y: 140 }, depictSmiles2D("CCC"), "CCC");
    const drawing = applyPatch(blank, { op: "addObject", pageId: blank.pages[0].id, object: molecule });
    const member = molecule.atoms.find(atom => molecule.bonds.filter(bond => bond.fromAtomId === atom.id || bond.toAtomId === atom.id).length === 1)!;
    const adjacent = molecule.bonds.find(bond => bond.fromAtomId === member.id || bond.toAtomId === member.id)!;
    const retained = molecule.atoms.find(atom => atom.id !== adjacent.fromAtomId && atom.id !== adjacent.toAtomId)!;
    const repeat = toggleBracketRepeatUnit(drawing, [{ kind: "atom", objectId: molecule.id, atomId: member.id }]);
    const open = repeat.pages[0].objects.find(object => object.type === "bracket" && object.side === "open")!;
    const selected = applyPatch(repeat, { op: "setSelection", objectIds: [open.id] });
    const write = vi.spyOn(clipboard, "writeClipboardItems").mockResolvedValue({ ok: true, written: [], failed: [], warnings: [] });
    window.history.replaceState(null, "", "/?agentBridge=1");
    await act(async () => root.render(<MainWindow initialDocument={selected} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    container.querySelectorAll(".page, .canvas-region").forEach(element => {
      element.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: size, height: size,
        right: size, bottom: size, toJSON: () => ({}) });
    });
    const target = container.querySelector<HTMLElement>(".page")!;
    target.setPointerCapture = () => {};
    target.hasPointerCapture = () => false;
    const bridge = window.__CHEMDRAFT_AGENT__!;
    const start = bridge.resolvePoint({ page: { x: member.x - 5, y: member.y - 14 } }).client;
    const end = bridge.resolvePoint({ page: { x: member.x + 5, y: member.y + 5 } }).client;
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      const point = type === "pointerdown" ? start : end;
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, shiftKey: true,
        buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      await act(async () => target.dispatchEvent(event));
    }
    expect(bridge.snapshot().selectedNativeMoleculePart).toMatchObject({ kind: "parts", atomIds: [member.id], bondIds: [adjacent.id] });
    const before = current();
    expect(before.selection.objectIds).toEqual([open.id]);
    await command("clipboard.cut");
    expect(write).toHaveBeenCalledOnce();
    const after = current();
    expect(after.pages[0].objects).toMatchObject([{ id: molecule.id, atoms: [{ id: retained.id }] }]);
    await command("edit.undo");
    expect(current()).toEqual(before);
    await command("edit.redo");
    expect(current()).toEqual(after);
  });

  it.each([false, true])("refuses late normalization outside request scope (approved fit=%s)", async approved => {
    const blank = initial(200);
    const pageId = blank.pages[0]!.id;
    const drawing = applyPatch(blank, { op: "addObject", pageId,
      object: DocumentObjectSchema.parse({ id: "existing", type: "plus", x: 50, y: 50, width: 10, height: 10 }) });
    const prompt = vi.fn(async () => "enlarge");
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current();
    const normalize = workflow.normalizeCommittedDocument;
    let passes = 0;
    vi.spyOn(workflow, "normalizeCommittedDocument").mockImplementation(doc => {
      const normalized = normalize(doc);
      if (++passes !== 2) return normalized;
      if (!approved) return setDocumentCustomPageSize(normalized, { width: 400, height: 400, unit: "css-px" });
      return { ...normalized, pages: normalized.pages.map(page => ({ ...page, objects: page.objects.map(object =>
        object.id === "existing" ? { ...object, x: object.x + 7 } : object) })) };
    });
    const runtime = captured.runtime!;
    runtime.registerPlugin({ id: "org.test.publicFit", name: "Public page fit", version: "1.0.0", apiVersion: "^0.1.26",
      entry: "test.js", permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
      contributes: { commands: [{ id: "plugin.publicFit.insert", title: "Insert" }] }
    }, { commandHandlers: { "plugin.publicFit.insert": async ctx => {
      const request = await ctx.requests!.begin({ label: "Caption" });
      if (!request.ok) throw new Error(request.error.message);
      const { requestId } = request.value;
      const result = await ctx.documents.applyRequestPatch!({ requestId, patch: { op: "addObject", pageId: before.pages[0]!.id,
        object: DocumentObjectSchema.parse({ id: "plus", type: "plus", x: approved ? -20 : 20, y: 20, width: 10, height: 10 }) } });
      await ctx.requests!.end({ requestId });
      return result;
    } } });
    await act(async () => {
      expect(await runtime.invokeCommand("plugin.publicFit.insert")).toMatchObject({ ok: false, error: { code: "scope" } });
    });
    expect(prompt).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(current()).toBe(before);
    await command("edit.undo");
    expect(current()).toBe(before);
  });

  it.each(["fits", "keep", "enlarge", "cancelled"] as const)(
    "request page space / %s reuses the explicit decision for its patch only", async answer => {
      const blank = initial(100);
      const pageId = blank.pages[0]!.id;
      const existing = createSmilesMolecule(blank, { x: 50, y: 50 }, depictSmiles2D("CC"), "CC");
      const drawing = applyPatch(blank, { op: "addObject", pageId, object: existing });
      const prompt = vi.fn(async (): Promise<string> => answer);
      restorePrompt = setNativePromptProvider(prompt);
      await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform}
        initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
      const before = current(), runtime = captured.runtime!;
      const commandId = "plugin.pageRequest.draw";
      const geometry = answer === "fits" ? { x: 20, y: 20, width: 5, height: 5 } :
        { x: -24, y: -32, width: 176, height: 184 };
      const patch = { op: "addObject" as const, pageId,
        object: DocumentObjectSchema.parse({ id: "arranged", type: "plus", ...geometry }) };
      let resolveLateAnswer: (answer: string) => void;
      if (answer === "cancelled") {
        prompt.mockImplementation(() => new Promise(resolve => { resolveLateAnswer = resolve; }));
      }
      const draw = vi.fn(async (ctx: import("@chemdraft/plugin-api").PluginCommandContext) => {
        const requests = ctx.requests!;
        const started = await requests.begin({ label: "Place content" });
        if (!started.ok) throw new Error(started.error.message);
        const { requestId } = started.value;
        const context = await requests.getContext({ requestId });
        if (!context.ok) throw new Error(context.error.message);
        const { revision } = context.value.pages[0]!;
        const bounds = { x: geometry.x - 1, y: geometry.y - 1, width: geometry.width + 2, height: geometry.height + 2 };
        const pending = requests.requestPageSpace!({ requestId, pageId, revision, requiredBounds: bounds });
        if (answer === "cancelled") {
          await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
          await requests.end({ requestId });
          expect(await pending).toEqual({ ok: true, value: { outcome: "unanswered" } });
          resolveLateAnswer("enlarge");
          expect(await ctx.documents.applyRequestPatch!({ requestId, patch })).toMatchObject({ ok: false, error: { code: "cancelled" } });
          return;
        }
        const decision = await pending;
        if (!decision.ok || decision.value.outcome === "unanswered") throw new Error(JSON.stringify(decision));
        expect(decision.value.outcome).toBe(answer);
        const pageSpace = { pageId, decisionId: decision.value.decisionId };
        expect(await ctx.documents.applyRequestPatch!({ requestId, patch, pageSpace: { ...pageSpace, decisionId: "forged" } }))
          .toMatchObject({ ok: false, error: { code: "stale" } });
        if (answer !== "fits") {
          expect(await ctx.documents.applyRequestPatch!({ requestId, pageSpace, patch: {
            ...patch, object: { ...patch.object, x: -500 }
          } })).toMatchObject({ ok: false, error: { code: "stale" } });
        }
        expect(await ctx.documents.applyRequestPatch!({ requestId, patch, pageSpace })).toMatchObject({ ok: true });
        expect(await ctx.documents.applyRequestPatch!({ requestId, patch, pageSpace }))
          .toMatchObject({ ok: false, error: { code: "stale" } });
        // A second write at a new revision and rectangle needs a separate decision.
        if (answer !== "fits") await ctx.documents.applyPatch!({ reason: "Add a second mark", patch: {
          ...patch, object: { ...patch.object, id: "second", x: 500, y: 50 }
        } });
        await requests.end({ requestId });
      });
      await act(async () => {
        runtime.registerPlugin({ id: "org.test.pageRequest", name: "Page Request", version: "1.0.0", apiVersion: "^0.1.26",
          entry: "test.js", permissions: ["document.read", "selection.read", "document.write", "chemistry.compute"],
          contributes: { commands: [{ id: commandId, title: "Place content" }] }
        }, { commandHandlers: { [commandId]: draw } });
        await runtime.invokeCommand(commandId);
      });
      const after = current();
      expect(prompt).toHaveBeenCalledTimes(answer === "fits" ? 0 : answer === "cancelled" ? 1 : 2);
      if (answer === "cancelled") {
        expect(after).toBe(before);
        return;
      }
      expect(after.selection.objectIds).toEqual(answer === "fits" ? ["arranged"] : ["arranged", "second"]);
      if (answer === "enlarge") {
        expect(after.pages[0]!.width).toBeGreaterThan(500);
        expect(after.pages[0]!.objects[0]).toMatchObject({ x: existing.x + 24, y: existing.y + 32 });
      } else expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout);
      await command("edit.undo"); expect(current()).toEqual(before);
      await command("edit.redo"); expect(current()).toEqual(after);
      expect(draw).toHaveBeenCalledOnce();
    }
  );

  it.each(actions.flatMap(action => (["fits", "enlarge", "keep"] as const).map(answer => ({ action, answer }))))(
    "$action / $answer asks once, selects the result, and undoes page + content together", async ({ action, answer }) => {
    const size = answer === "fits" ? 2000 : 20;
    let document = initial(size);
    if (action === "duplicate" || action === "cleanup") {
      document = insertNativeTemplateMolecule(document, { x: size / 2, y: size / 2 }, "cyclohexane");
      if (action === "cleanup") {
        const ring = document.pages[0]!.objects[0]!;
        if (ring.type !== "molecule") throw new Error("Expected ring");
        document = applyPatch(document, { op: "updateObject", objectId: ring.id,
          changes: normalizeNativeMoleculeGeometry({ ...ring, atoms: ring.atoms.map(atom => ({ ...atom,
            x: 100 + atom.x * 0.2, y: 100 + atom.y * 0.2 })) }) });
      }
    }
    const prompt = vi.fn(async (_prompt: NativePromptOptions) => answer === "enlarge" ? "enlarge" : "keep");
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={document} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current();
    if (action === "template") await command(`template.insert.${resolveStructureTemplateName("beta-cyclodextrin")!.id}`);
    if (action === "bracket stamp" || action === "bracket drag") {
      await command("tool.squareBracket");
      const page = container.querySelector<HTMLElement>(".page")!;
      page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: size, bottom: size,
        width: size, height: size, toJSON: () => ({}) });
      page.setPointerCapture = () => {};
      page.hasPointerCapture = () => false;
      const start = size === 2000 ? 100 : 10;
      for (const type of ["pointerdown", ...(action === "bracket drag" ? ["pointermove"] : []), "pointerup"]) {
        const end = action === "bracket drag" && type !== "pointerdown";
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === "pointerup" ? 0 : 1, clientX: end ? start + 150 : start, clientY: end ? start + 130 : start });
        Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
        await act(async () => page.dispatchEvent(event));
      }
    }
    if (action === "text paste" || action === "private paste") {
      let text = "Ordinary caption\nSecond caption\nThird caption";
      let type = "text/plain";
      if (action === "private paste") {
        const source = insertNativeTemplateMolecule(initial(2000), { x: 600, y: 600 }, "cyclohexane");
        text = serializeSelectionClipboardPayload(createSelectionClipboardPayload(source)!);
        type = "application/x-chemdraft-selection+json";
      }
      vi.spyOn(clipboard, "readClipboardPayload").mockResolvedValue({ types: [type], textItems: [{ type, text }] });
      await command("clipboard.paste");
    }
    if (action === "duplicate") await command("layout.duplicate");
    if (action === "cleanup") await command("structure.cleanup2d");
    if (action === "plugin batch" || action === "reviewed proposal") {
      const object = createSmilesMolecule(before, { x: 600, y: 600 }, depictSmiles2D("CCCCCCCCCCCC"), "CCCCCCCCCCCC");
      const runtime = captured.runtime!;
      await act(async () => {
        runtime.registerPlugin({ id: "org.chemdraft.pageTest", name: "Page test", version: "0.1.0", apiVersion: "^0.1.20",
          entry: "test.js", permissions: [action === "plugin batch" ? "document.write" : "document.proposePatch"],
          contributes: { commands: [{ id: "plugin.pageTest.insert", title: "Insert" }] }
        }, { commandHandlers: { "plugin.pageTest.insert": async context => {
          const patch = { reason: "Insert batch", patch: { op: "batch" as const, patches: [
            { op: "addObject" as const, pageId: before.pages[0]!.id, object },
            { op: "addObject" as const, pageId: before.pages[0]!.id, object: { ...object, id: "second" } }
          ] } };
          if (action === "reviewed proposal") await context.documents!.proposePatch(patch);
          else {
            if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
            await context.documents.applyPatch(patch);
          }
        } } });
        await runtime.invokeCommand("plugin.pageTest.insert");
      });
      if (action === "reviewed proposal") {
        await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
        await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
        // An accepted insertion's chemistry is checked off-thread before the page question and the commit.
        await act(async () => { await vi.waitFor(() => expect(runtime.host.listProposedPatches("pending")).toHaveLength(0), { timeout: 4_000 }); });
      }
    }
    await act(async () => {});
    expect(prompt).toHaveBeenCalledTimes(answer === "fits" ? 0 : 1);
    if (answer !== "fits") expect(prompt.mock.calls[0]![0]).toMatchObject({
      owner: "document", message: "This doesn't fit on the page. Enlarge the page to fit? Content on the page may shift to make room.",
      choices: [{ id: "enlarge", label: "Enlarge" }, { id: "keep", label: "Keep Page Size", cancel: true }]
    });
    const after = current();
    expect(after).not.toEqual(before);
    expect(after.selection.objectIds.length).toBeGreaterThan(0);
    if (action === "bracket stamp" || action === "bracket drag") {
      const brackets = after.pages[0]!.objects.filter(object => object.type === "bracket");
      expect(brackets).toHaveLength(2);
      expect(after.selection.objectIds).toEqual(brackets.map(bracket => bracket.id));
      expect(brackets.map(bracket => bracket.height)).toEqual(action === "bracket stamp" ? [64, 64] : [130, 130]);
      expect(brackets[1]!.x - brackets[0]!.x).toBe(action === "bracket stamp" ? 64 : 134);
    }
    if (answer === "enlarge") expect(after.pages[0]!.width > size || after.pages[0]!.height > size).toBe(true);
    else expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout);
    await command("edit.undo");
    expect(current()).toEqual(before);
    await command("edit.redo");
    expect(current()).toEqual(after);
    expect(prompt).toHaveBeenCalledTimes(answer === "fits" ? 0 : 1);
  });

  it.each(["layout.rotate90", "layout.flipHorizontal", "text.size.24", "table.row.insertBelow", "table.column.insertRight"])(
    "%s commits overflowing manual edits without asking or changing the page", async commandId => {
    let drawing = initial(20);
    if (commandId.startsWith("table.")) {
      let id = 0;
      drawing = insertTableIntoDocument(drawing, { rows: 2, columns: 2, headerRows: 1, preset: "grid",
        center: { x: 100, y: 100 }, newId: prefix => `${prefix}-${++id}` });
    } else if (commandId.startsWith("text.")) {
      drawing = insertNativeTextObject(drawing, { x: 100, y: 100 }, "Caption");
    } else {
      const object = createSmilesMolecule(drawing, { x: 100, y: 100 }, depictSmiles2D("CCCCCC"), "CCCCCC");
      drawing = applyPatch(applyPatch(drawing, { op: "addObject", pageId: drawing.pages[0]!.id, object }),
        { op: "setSelection", objectIds: [object.id] });
    }
    const prompt = vi.fn(async () => "enlarge");
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={drawing} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current();
    await command(commandId);
    const after = current();
    expect(after).not.toEqual(before);
    expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout);
    expect(after.pages[0]!.width).toBe(20);
    expect(after.pages[0]!.height).toBe(20);
    expect(prompt).not.toHaveBeenCalled();
    await command("edit.undo"); expect(current()).toEqual(before);
    await command("edit.redo"); expect(current()).toEqual(after);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("waits for the answer and commits to the originating tab after switching tabs", async () => {
    let answer!: (value: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={initial(20)} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current();
    await command(`template.insert.${resolveStructureTemplateName("beta-cyclodextrin")!.id}`);
    expect(prompt).toHaveBeenCalledOnce();
    expect(current()).toEqual(before);
    await command("document.new");
    await act(async () => { answer("enlarge"); });
    expect(getAssistantHistoryPort().read("initial")!.pages[0]!.objects).toHaveLength(1);
    await command("document.previousTab");
    await command("edit.undo");
    expect(current()).toEqual(before);
  });

  it("retains a reviewed proposal if the drawing changes during the page question", async () => {
    let answer!: (value: string) => void;
    restorePrompt = setNativePromptProvider(() => new Promise<string>(resolve => { answer = resolve; }));
    await act(async () => root.render(<MainWindow initialDocument={initial(20)} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    const object = createSmilesMolecule(before, { x: 600, y: 600 }, depictSmiles2D("CCCCCCCCCCCC"), "CCCCCCCCCCCC");
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.pageReview", name: "Page review", version: "0.1.0", apiVersion: "^0.1.20",
        entry: "test.js", permissions: ["document.proposePatch"] });
      runtime.host.proposePatch("org.chemdraft.pageReview", { reason: "Review", patch: { op: "addObject", pageId: before.pages[0]!.id, object } });
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
    // The insertion's chemistry is checked off-thread before the page question opens.
    await act(async () => { await vi.waitFor(() => expect(answer).toBeDefined(), { timeout: 4_000 }); });
    expect(current()).toEqual(before);
    expect(runtime.host.listProposedPatches("pending")).toHaveLength(1);
    const external = setDocumentCustomPageSize(before, { width: 80, height: 80, unit: "css-px" });
    await act(async () => { getAssistantHistoryPort().push("initial", before, external, "External edit"); });
    await act(async () => { answer("enlarge"); });
    expect(current()).toEqual(external);
    expect(runtime.host.listProposedPatches("pending")).toHaveLength(1);
  });

  it.each(["enlarge", "keep"])("shares %s across writes in one plugin command and asks again for the next command", async choice => {
    const prompt = vi.fn(async () => choice);
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={initial(20)} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.pageSequence", name: "Page sequence", version: "0.1.0", apiVersion: "^0.1.20",
        entry: "test.js", permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pageSequence.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageSequence.insert": async context => {
        for (const scale of [1, 10]) {
          let object = createSmilesMolecule(current(), { x: 600, y: 600 }, depictSmiles2D("CCCCCCCCCCCC"), "CCCCCCCCCCCC");
          object = normalizeNativeMoleculeGeometry({ ...object, atoms: object.atoms.map(atom => ({ ...atom, x: 600 + atom.x * scale })) });
          if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
          await context.documents.applyPatch({ reason: "Insert", patch: { op: "addObject", pageId: before.pages[0]!.id, object } });
        }
      } } });
      await runtime.invokeCommand("plugin.pageSequence.insert");
    });
    expect(prompt).toHaveBeenCalledOnce(); expect(current().pages[0]!.objects).toHaveLength(2);
    await command("edit.undo"); await command("edit.undo"); expect(current()).toEqual(before);
    await act(async () => { await runtime.invokeCommand("plugin.pageSequence.insert"); });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("rejects a direct plugin patch after the request's page question went unanswered", async () => {
    let answer!: (value: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    restorePrompt = setNativePromptProvider(prompt);
    await act(async () => root.render(<MainWindow initialDocument={initial(20)} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    const pluginId = "org.chemdraft.pageUnanswered";
    const transactions = getAssistantTransactions(getAssistantHistoryPort());
    let failure: unknown;
    await act(async () => {
      runtime.registerPlugin({ id: pluginId, name: "Unanswered", version: "0.1.0", apiVersion: "^0.1.20",
        entry: "test.js", permissions: [...AssistantCapabilityPermissions],
        contributes: { commands: [{ id: "plugin.pageUnanswered.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageUnanswered.insert": async context => {
        const tx = await context.assistant!.beginRequest({ prompt: "Insert large content" });
        try {
          const deadline = new AbortController();
          const pending = transactions.pageEnlargementConsent(tx.requestId, platform).confirm(deadline.signal);
          deadline.abort();
          expect(await pending).toBe("unanswered");
          await context.documents.applyPatch!({ reason: "Insert", patch: { op: "addObject", pageId: before.pages[0]!.id,
            object: DocumentObjectSchema.parse({ id: "unanswered-overflow", type: "plus", x: 0, y: 0, width: 1000, height: 1000 }) } });
        } finally { await context.assistant!.endRequest(tx); }
      } } });
      try { await runtime.invokeCommand("plugin.pageUnanswered.insert"); } catch (error) { failure = error; }
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("No answer to the enlarge-page question");
    await act(async () => { answer("enlarge"); });
    expect(current()).toEqual(before);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("rejects a plugin write if the command unregisters while its page question is open", async () => {
    let answer!: (value: string) => void;
    restorePrompt = setNativePromptProvider(() => new Promise<string>(resolve => { answer = resolve; }));
    await act(async () => root.render(<MainWindow initialDocument={initial(20)} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialPaletteMode="hidden" initialRulersVisible={false} nativePalette={false} />));
    const before = current(), runtime = captured.runtime!;
    let finished!: Promise<unknown>;
    await act(async () => {
      runtime.registerPlugin({ id: "org.chemdraft.pageCancelled", name: "Cancelled", version: "0.1.0", apiVersion: "^0.1.20",
        entry: "test.js", permissions: ["document.write"], contributes: { commands: [{ id: "plugin.pageCancelled.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageCancelled.insert": async context => {
        const object = createSmilesMolecule(before, { x: 600, y: 600 }, depictSmiles2D("CCCCCCCCCCCC"), "CCCCCCCCCCCC");
        if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
        await context.documents.applyPatch({ reason: "Insert", patch: { op: "addObject", pageId: before.pages[0]!.id, object } });
      } } });
      finished = runtime.invokeCommand("plugin.pageCancelled.insert").then(() => "applied", () => "cancelled");
    });
    // The insertion's chemistry is checked off-thread before the page question opens.
    await act(async () => { await vi.waitFor(() => expect(answer).toBeDefined(), { timeout: 4_000 }); });
    expect(current()).toEqual(before);
    await act(async () => { runtime.unregisterPlugin("org.chemdraft.pageCancelled"); });
    await expect(finished).resolves.toBe("cancelled");
    await act(async () => { answer("enlarge"); });
    expect(current()).toEqual(before);
  });
});
