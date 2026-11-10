import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { applySingleBondToolAtNativeAtom, createPhase4Document, insertNativeBracket,
  insertNativeSingleBondMolecule } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { allShellCommands } from "./commands";
import { buildAppMenuModel, flattenAppMenuCommands, structureSearchMenuItems } from "./appMenu";
import { nativePromptButtons } from "./nativePrompt";
import { createStructureSearchController, stripSearchCxSmiles, structureSearchCommands,
  structureSearchDocument, structureSearchNotice } from "./structureSearch";
import { loadStructureSearchEnabled, saveStructureSearchEnabled, STRUCTURE_SEARCH_DEFAULT_ENABLED,
  STRUCTURE_SEARCH_STORAGE_KEY } from "./structureSearchSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), isTauri: vi.fn(() => true) }));
// Exercise the real clipboard/SMILES pipeline with its native writer, without loading WASM.
vi.mock("./moleculeSmiles", async importOriginal => ({
  ...await importOriginal<typeof import("./moleculeSmiles")>(),
  loadStructureIdentifiers: async () => undefined
}));

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
});
afterEach(() => vi.unstubAllGlobals());

function drawing() {
  return insertNativeSingleBondMolecule(createPhase4Document("Search test"), { x: 300, y: 300 });
}
function propane() {
  const source = drawing();
  const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
  return applySingleBondToolAtNativeAtom(source, {
    objectId: molecule.id, kind: "atom", atomId: molecule.atoms[1]!.id
  });
}
function setup(answer = "continue") {
  let time = 1000;
  let enabled = true;
  const prompt = vi.fn(async (_options: ReturnType<typeof structureSearchNotice>) => answer);
  const serialize = vi.fn(async () => "C/C=C/C |test|");
  const search = createStructureSearchController({ enabled: () => enabled, now: () => time, storage, prompt, serialize });
  return { search, prompt, serialize, advance: (delta: number) => { time += delta; }, disable: () => { enabled = false; } };
}

describe("online structure search", () => {
  it("has one exported true default and persists the preference", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    expect(STRUCTURE_SEARCH_DEFAULT_ENABLED).toBe(true);
    expect(loadStructureSearchEnabled()).toBe(STRUCTURE_SEARCH_DEFAULT_ENABLED);
    await saveStructureSearchEnabled(false);
    expect(loadStructureSearchEnabled()).toBe(false);
    storage.setItem(STRUCTURE_SEARCH_STORAGE_KEY, "invalid");
    expect(loadStructureSearchEnabled()).toBe(STRUCTURE_SEARCH_DEFAULT_ENABLED);
  });

  it("requires selected chemistry and reports a disabled reason", () => {
    const source = drawing();
    const emptySelection = { ...source, selection: { ...source.selection, objectIds: [] } };
    expect(structureSearchDocument(emptySelection)).toBeUndefined();
    const commands = allShellCommands(emptySelection).filter(command => command.id.startsWith("search."));
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).toMatchObject({ enabled: false, disabledReason: "Select a structure to search." });
    expect(structureSearchDocument(source)?.pages[0]?.objects).toHaveLength(1);
    for (const command of structureSearchCommands(true, true)) {
      expect(command.enabled).toBe(true);
      expect(command.disabledReason).toBeUndefined();
      expect(command.shortcut).toBeUndefined();
    }
  });

  it("searches a selected atom fragment without the rest of its molecule or page", () => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const deselected = { ...source, selection: { ...source.selection, objectIds: [] } };
    const scoped = structureSearchDocument(deselected, [{ objectId: molecule.id, atomIds: [molecule.atoms[0]!.id], bondIds: [] }]);
    expect(scoped?.pages[0]?.objects).toHaveLength(1);
    const fragment = scoped!.pages[0]!.objects[0]!;
    expect(fragment.type).toBe("molecule");
    if (fragment.type === "molecule") { expect(fragment.atoms).toHaveLength(1); expect(fragment.bonds).toHaveLength(0); }
    expect(molecule.atoms).toHaveLength(2);
  });

  it("searches only CC for a click-selected terminal bond of propane even when its host ID is selected", async () => {
    const source = propane();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    expect(molecule.atoms).toHaveLength(3);
    expect(source.selection.objectIds).toEqual([molecule.id]);
    const original = structuredClone(source);
    const scoped = structureSearchDocument(source, [{
      objectId: molecule.id, atomIds: [], bondIds: [molecule.bonds[0]!.id]
    }]);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CC" });
    expect(source).toEqual(original);
  });

  it.each([true, false])("preserves propane search with whole-molecule selection = %s", async wholeMolecule => {
    const source = propane();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const document = { ...source, selection: { ...source.selection, objectIds: wholeMolecule ? [molecule.id] : [] } };
    const scoped = structureSearchDocument(document, wholeMolecule ? [] : [{
      objectId: molecule.id, atomIds: [], bondIds: [molecule.bonds[0]!.id]
    }]);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", {
      site: "pubchem", smiles: wholeMolecule ? "CCC" : "CC"
    });
  });

  it("refuses a bond-midpoint fragment inside a repeat unit before prompting or opening PubChem", async () => {
    const bracketed = toggleBracketRepeatUnit(insertNativeBracket(
      drawing(), { x: 250, y: 250 }, "square", { x: 350, y: 350 }
    ));
    const molecule = bracketed.pages[0]!.objects.find(object => object.type === "molecule")!;
    expect(molecule.chemistry?.warnings.some(warning => warning.code === "chemistry.bracket_multiplier")).toBe(true);
    // A lasso covering only the midpoint selects the bond, with no atoms or whole objects.
    const document = { ...bracketed, selection: { ...bracketed.selection, objectIds: [] } };
    const original = structuredClone(document);
    const scoped = structureSearchDocument(document, [{
      objectId: molecule.id, atomIds: [], bondIds: [molecule.bonds[0]!.id]
    }]);
    const prompt = vi.fn(async () => "continue");
    const search = createStructureSearchController({ enabled: () => true, storage, prompt });

    await expect(search("pubchem", scoped)).rejects.toThrow(
      /Structure search refused: SMILES cannot hold the repeat unit n around 2 atoms/
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(document).toEqual(original);
  });

  it.each([0, 1])("limits repeat-unit diagnostics to selected atoms when searching propane bond %i", async bondIndex => {
    const source = propane();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const terminal = molecule.atoms[0]!;
    // The repeat unit contains just the first atom; the rest of the same molecule is outside.
    const bracketed = toggleBracketRepeatUnit(insertNativeBracket(source,
      { x: terminal.x - 5, y: terminal.y - 5 }, "square", { x: terminal.x + 5, y: terminal.y + 5 }
    ));
    const document = { ...bracketed, selection: { ...bracketed.selection, objectIds: [] } };
    const scoped = structureSearchDocument(document, [{
      objectId: molecule.id, atomIds: [], bondIds: [molecule.bonds[bondIndex]!.id]
    }]);
    const prompt = vi.fn(async () => "continue");
    const search = createStructureSearchController({ enabled: () => true, storage, prompt });

    if (bondIndex === 0) {
      await expect(search("pubchem", scoped)).rejects.toThrow("SMILES cannot hold the repeat unit n around 1 atoms");
      expect(prompt).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } else {
      await expect(search("pubchem", scoped)).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CC" });
    }
  });

  it("disables molfile-only selections with the selection reason", () => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const imported = { ...molecule, atoms: [], bonds: [], structureFormat: "molfile-v2000" as const, structure: "molfile data" };
    const document = { ...source, pages: [{ ...source.pages[0]!, objects: [imported] }] };
    expect(structureSearchDocument(document)).toBeUndefined();
    const commands = allShellCommands(document).filter(command => command.id.startsWith("search."));
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).toMatchObject({ enabled: false, disabledReason: "Select a structure to search." });
  });

  it("refuses mixed native and molfile-only selections before serializing or sending anything", async () => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const imported = { ...molecule, id: "imported", atoms: [], bonds: [], structureFormat: "molfile-v2000" as const, structure: "molfile data" };
    const document = { ...source, pages: [{ ...source.pages[0]!, objects: [molecule, imported] }],
      selection: { ...source.selection, objectIds: [molecule.id, imported.id] } };
    const scoped = structureSearchDocument(document);
    expect(scoped?.pages[0]?.objects).toHaveLength(2);
    const flow = setup();
    await expect(flow.search("pubchem", scoped)).rejects.toThrow(
      "Part of the selection cannot be searched: structures without editable native graphs (imported). Select only drawn structures.");
    expect(flow.serialize).not.toHaveBeenCalled();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("omits both commands and menu items in the web build", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    expect(structureSearchCommands(true, true)).toEqual([]);
    expect(allShellCommands(drawing()).some(command => command.id.startsWith("search."))).toBe(false);
    expect(structureSearchMenuItems(true, true)).toEqual([]);
    const model = buildAppMenuModel({ structureSearchEnabled: true, hasSearchableStructure: true,
      rulersVisible: true, crosshairsVisible: false, canUndo: false, canRedo: false,
      hasSelection: true, hasSelectedMolecule: true, toolbars: [] });
    expect(flattenAppMenuCommands(model).some(item => item.commandId.startsWith("search."))).toBe(false);
  });

  it("does not treat selected text as searchable or fall back to the page", () => {
    const source = drawing();
    const page = source.pages[0]!;
    const withText = { ...source, pages: [{ ...page, objects: [...page.objects, {
      id: "text", type: "text" as const, text: "Note", spans: [], x: 10, y: 10, width: 100, height: 20, rotation: 0, style: {}
    }] }], selection: { ...source.selection, objectIds: ["text"] } };
    expect(structureSearchDocument(withText)).toBeUndefined();
  });

  it.each(["CCO |coordinates|", "CCO\t|labels|", "CCO\nextra", "CCO"])("strips extensions after the first whitespace: %s", value => {
    expect(stripSearchCxSmiles(value)).toBe("CCO");
  });

  it.each(["macos", "windows"] as ShortcutPlatform[])("offers the exact Tools labels with no shortcuts on %s", platform => {
    const model = buildAppMenuModel({ platform, rulersVisible: true, crosshairsVisible: false,
      canUndo: false, canRedo: false, hasSelection: true, hasSelectedMolecule: true, toolbars: [], hasSearchableStructure: true });
    const items = flattenAppMenuCommands([model.find(section => section.id === "tools")!]);
    expect(items.map(item => item.label)).toEqual(["Search PubChem (opens browser)", "Search Reaxys (opens browser)"]);
    expect(items.every(item => item.enabled && !item.shortcut && !item.accelerator)).toBe(true);
    expect(nativePromptButtons(structureSearchNotice("pubchem"), platform)).toEqual({ ok: "Continue", cancel: "Cancel" });
  });

  it("hides both menu items and refuses commands while the preference is off", async () => {
    const flow = setup();
    flow.disable();
    expect(structureSearchMenuItems(false, true)).toEqual([]);
    const model = buildAppMenuModel({ structureSearchEnabled: false, rulersVisible: true, crosshairsVisible: false,
      canUndo: false, canRedo: false, hasSelection: true, hasSelectedMolecule: true, toolbars: [] });
    expect(flattenAppMenuCommands(model).some(item => item.commandId.startsWith("search."))).toBe(false);
    expect(structureSearchCommands(false, true).every(command => !command.enabled && command.disabledReason)).toBe(true);
    await expect(flow.search("pubchem", drawing())).rejects.toThrow("off in Preferences");
    expect(flow.serialize).not.toHaveBeenCalled();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends nothing on construction or without a selection", async () => {
    const flow = setup();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await expect(flow.search("pubchem", undefined)).rejects.toThrow("Select a structure");
    expect(flow.serialize).not.toHaveBeenCalled();
  });

  it("prompts once per site, remembers Continue across controllers, and invokes with site and SMILES only", async () => {
    const flow = setup();
    const source = drawing();
    expect(await flow.search("pubchem", source)).toBe(true);
    flow.advance(1000);
    await flow.search("pubchem", source);
    flow.advance(1000);
    await flow.search("reaxys", source);
    expect(flow.prompt).toHaveBeenCalledTimes(2);
    for (const [index, name] of ["PubChem", "Reaxys"].entries()) expect(flow.prompt.mock.calls[index]![0]).toMatchObject({
      message: `Search sends the selected structure to ${name} in a web address. It will appear in your browser's history and any browser sync. Continue?`
    });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["open_structure_search", { site: "pubchem", smiles: "C/C=C/C" }],
      ["open_structure_search", { site: "pubchem", smiles: "C/C=C/C" }],
      ["open_structure_search", { site: "reaxys", smiles: "C/C=C/C" }]
    ]);
    const reopened = setup();
    await reopened.search("reaxys", source);
    expect(reopened.prompt).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing and asks again next time", async () => {
    const flow = setup("cancel");
    expect(await flow.search("pubchem", drawing())).toBeUndefined();
    await flow.search("pubchem", drawing());
    expect(flow.prompt).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(storage.getItem("chemdraft.structure-search.consent.pubchem.v1")).toBeNull();
  });

  it("limits repeated commands across sites to one browser opening a second", async () => {
    const flow = setup();
    await flow.search("pubchem", drawing());
    flow.advance(999);
    expect(await flow.search("reaxys", drawing())).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    flow.advance(1);
    await flow.search("reaxys", drawing());
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not queue held commands while the first prompt is pending", async () => {
    let resolve!: (answer: string) => void;
    const prompt = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const search = createStructureSearchController({ enabled: () => true, storage, prompt, serialize: async () => "CC" });
    const first = search("pubchem", drawing());
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await search("pubchem", drawing());
    await search("reaxys", drawing());
    resolve("continue");
    await first;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rechecks the preference after consent and refuses lossy serialization", async () => {
    let enabled = true;
    const search = createStructureSearchController({ enabled: () => enabled, storage,
      serialize: async () => "CC", prompt: async () => { enabled = false; return "continue"; } });
    await expect(search("pubchem", drawing())).rejects.toThrow("off in Preferences");
    const warned = createStructureSearchController({ enabled: () => true, storage,
      serialize: async (_document, warnings) => { warnings?.push("Unpreserved charge"); return "CC"; } });
    await expect(warned("pubchem", drawing())).rejects.toThrow("Unpreserved charge");
    expect(invoke).not.toHaveBeenCalled();
  });
});
