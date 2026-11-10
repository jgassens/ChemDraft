import { initialDocumentTabId } from "./testSupport/documentTabIdentity";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, DocumentObjectSchema } from "@chemdraft/chem-core";
import { createSmilesMolecule, normalizeNativeMoleculeGeometry, resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import { MainWindow } from "./MainWindow";
import { getAssistantHistoryPort } from "./assistant/historyPort";
import { getAssistantTransactions } from "./assistant/assistantTransaction";
import { createSelectionClipboardPayload, insertNativeTemplateMolecule, serializeSelectionClipboardPayload, setDocumentCustomPageSize, insertNativeTextObject, insertTableIntoDocument } from "./documentWorkflow";
import { setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";
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
});
async function command(commandId: string) {
  await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })); });
}
const current = () => getAssistantHistoryPort().read(initialDocumentTabId())!;
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
    const txId = path === "assistant patch" ? transactions.beginAssistantTransaction({ pluginId, runId: "shift-test",
      label: "Insert large content", tabId: initialDocumentTabId(), sendSelection: { objectIds: [] } }) : undefined;
    await act(async () => {
      runtime.registerPlugin({ id: pluginId, name: "Page shift", version: "0.1.0", apiVersion: "^0.1.20", entry: "test.js",
        permissions: [path === "reviewed proposal" ? "document.proposePatch" : "document.write"],
        contributes: { commands: [{ id: "plugin.pageShift.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageShift.insert": async context => {
        const patch = { reason: "Insert oversized content", patch: { op: "addObject" as const, pageId: page.id, object } };
        if (path === "reviewed proposal") await context.documents!.proposePatch(patch);
        else {
          if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
          await context.documents.applyPatch(patch);
        }
      } } });
      await runtime.invokeCommand("plugin.pageShift.insert");
    });
    if (path === "reviewed proposal") {
      await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-badge")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".patch-review-actions button")!.click());
    }
    if (txId) await act(async () => {
      expect(await transactions.pageEnlargementConsent(txId, platform).confirm()).toBe(answer);
      transactions.endAssistantTransaction(txId, { touchedIds: [object.id] });
    });
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
    expect(getAssistantHistoryPort().read(initialDocumentTabId())!.pages[0]!.objects).toHaveLength(1);
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
    expect(current()).toEqual(before);
    expect(runtime.host.listProposedPatches("pending")).toHaveLength(1);
    const external = setDocumentCustomPageSize(before, { width: 80, height: 80, unit: "css-px" });
    await act(async () => { getAssistantHistoryPort().push(initialDocumentTabId(), before, external, "External edit"); });
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
    const txId = transactions.beginAssistantTransaction({ pluginId, runId: "unanswered-test",
      label: "Insert large content", tabId: initialDocumentTabId(), sendSelection: { objectIds: [] } });
    const deadline = new AbortController();
    const pending = transactions.pageEnlargementConsent(txId, platform).confirm(deadline.signal);
    deadline.abort();
    expect(await pending).toBe("unanswered");
    let failure: unknown;
    await act(async () => {
      runtime.registerPlugin({ id: pluginId, name: "Unanswered", version: "0.1.0", apiVersion: "^0.1.20",
        entry: "test.js", permissions: ["document.write"],
        contributes: { commands: [{ id: "plugin.pageUnanswered.insert", title: "Insert" }] }
      }, { commandHandlers: { "plugin.pageUnanswered.insert": async context => {
        if (!context.documents?.applyPatch) throw new Error("document.write capability is unavailable");
        await context.documents.applyPatch({ reason: "Insert", patch: { op: "addObject", pageId: before.pages[0]!.id,
          object: DocumentObjectSchema.parse({ id: "unanswered-overflow", type: "plus", x: 0, y: 0, width: 1000, height: 1000 }) } });
      } } });
      try { await runtime.invokeCommand("plugin.pageUnanswered.insert"); } catch (error) { failure = error; }
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("No answer to the enlarge-page question");
    await act(async () => { answer("enlarge"); transactions.endAssistantTransaction(txId, { touchedIds: [] }); });
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
    expect(current()).toEqual(before);
    await act(async () => { runtime.unregisterPlugin("org.chemdraft.pageCancelled"); });
    await expect(finished).resolves.toBe("cancelled");
    await act(async () => { answer("enlarge"); });
    expect(current()).toEqual(before);
  });
});
