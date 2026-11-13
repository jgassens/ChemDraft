import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStorage } from "./testSupport/memoryStorage";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { repeatUnits } from "@chemdraft/export-engine";
import { applyPatch } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { applySingleBondToolAtNativeAtom, copyAsSmiles, createPhase4Document, deleteSelectedDocumentObjects, insertNativeBracket,
  insertNativeSingleBondMolecule } from "./documentWorkflow";
import { toggleBracketRepeatUnit } from "./bracketCommands";
import { allShellCommands } from "./commands";
import { buildAppMenuModel, flattenAppMenuCommands, structureSearchMenuItems } from "./appMenu";
import { nativePromptButtons } from "./nativePrompt";
import { createStructureSearchController, stripSearchCxSmiles, structureSearchCommands,
  structureSearchDocument, structureSearchErrorStatus, structureSearchNotice, StructureSearchRefusal } from "./structureSearch";
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
function propane(source = drawing()) {
  const molecule = source.pages[0]!.objects.filter(object => object.type === "molecule")
    .find(object => source.selection.objectIds.includes(object.id))!;
  return applySingleBondToolAtNativeAtom(source, {
    objectId: molecule.id, kind: "atom", atomId: molecule.atoms[1]!.id, distanceToPointer: 0
  });
}
function pentaneWithRepeatUnit() {
  let source = drawing();
  for (let index = 0; index < 3; index++) {
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    source = applySingleBondToolAtNativeAtom(source, {
      objectId: molecule.id, kind: "atom", atomId: molecule.atoms.at(-1)!.id, distanceToPointer: 0
    });
  }
  const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
  expect(molecule.atoms).toHaveLength(5);
  const members = molecule.atoms.slice(0, 3);
  const bracketed = toggleBracketRepeatUnit(insertNativeBracket(source, {
    x: Math.min(...members.map(atom => atom.x)) - 5, y: Math.min(...members.map(atom => atom.y)) - 5
  }, "round", {
    x: Math.max(...members.map(atom => atom.x)) + 5, y: Math.max(...members.map(atom => atom.y)) + 5
  }));
  const pair = bracketed.pages[0]!.objects.filter(object => object.type === "bracket");
  expect(pair).toHaveLength(2);
  expect(pair[0]!.pairId).toBe(pair[1]!.pairId);
  expect(pair.map(object => object.side).sort()).toEqual(["close", "open"]);
  expect(pair.every(object => object.bracketKind === "round" && object.repeatUnit && object.bracketUsage === "sru")).toBe(true);
  expect(pair.find(object => object.side === "close")!.label).toBe("n");
  expect(repeatUnits(bracketed)).toMatchObject([{ members: [{ atomIds: members.map(atom => atom.id) }] }]);
  return bracketed;
}
function importedBracketAndNeighbor(usage: "SRU" | "MultipleGroup", options: {
  unresolvedMember?: boolean; keepCrossing?: boolean;
} = {}) {
  const fixture = readFileSync(new URL("../../../packages/fixtures/cdxml/brackets-native-sru.cdxml", import.meta.url), "utf8");
  const membership = options.unresolvedMember ? fixture.replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="missing"') : fixture;
  const cdxml = (options.keepCrossing ? membership : membership.replace(/<crossingbond[^>]*\/>/, ""))
    .replaceAll('BracketUsage="SRU"', `BracketUsage="${usage}"`)
    .replace("</page>", `<fragment id="40">
      <n id="41" Element="6" p="300 100"/><n id="42" Element="6" p="330 100"/>
      <b id="43" B="41" E="42" Order="1"/>
    </fragment></page>`);
  const document = openChemDraftPayload(cdxml).document!;
  const [member, neighbor] = document.pages[0]!.objects.filter(object => object.type === "molecule");
  expect(member).toBeDefined();
  expect(neighbor).toBeDefined();
  return { document, member: member!, neighbor: neighbor! };
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
  it("refuses an imported bracket with an unresolved member and a live crossing into the selected molecule", async () => {
    const { document, member } = importedBracketAndNeighbor("SRU", { unresolvedMember: true, keepCrossing: true });
    expect(repeatUnits(document, [member])).toMatchObject([{ usage: "sru", members: [] }]);
    expect(document.pages[0]!.objects.filter(object => object.type === "bracket")
      .flatMap(bracket => bracket.crossingBondIds ?? [])).toEqual([{ objectId: member.id, bondId: member.bonds[0]!.id }]);
    expect(member.chemistry?.warnings.some(warning => warning.code === "chemistry.bracket_multiplier") ?? false).toBe(false);
    const selected = applyPatch(document, { op: "setSelection", objectIds: [member.id] });
    const flow = setup();

    const error = await flow.search("pubchem", structureSearchDocument(selected)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StructureSearchRefusal);
    expect(structureSearchErrorStatus(error)).toBe("Search can't include a polymer repeat unit. Select atoms outside the brackets.");
    expect(flow.serialize).not.toHaveBeenCalled();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["SRU", "MultipleGroup"] as const)("searches an unresolved imported %s member with no crossing reference", async usage => {
    const { document, member } = importedBracketAndNeighbor(usage, { unresolvedMember: true });
    expect(repeatUnits(document)).toMatchObject([{ members: [] }]);
    expect(document.pages[0]!.objects.filter(object => object.type === "bracket")
      .flatMap(bracket => bracket.crossingBondIds ?? [])).toEqual([]);
    const selected = applyPatch(document, { op: "setSelection", objectIds: [member.id] });
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", structureSearchDocument(selected))).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CO" });
  });

  it.each(["native bond", "imported bond", "imported inner atom"] as const)(
    "refuses an atom-only selection touched by an unresolved bracket's %s reference", async reference => {
      const { document, member } = importedBracketAndNeighbor("SRU", { unresolvedMember: true, keepCrossing: true });
      const bracketed = applyPatch(document, { op: "batch", patches: document.pages[0]!.objects
        .filter(object => object.type === "bracket").map(bracket => ({
          op: "updateObject" as const, objectId: bracket.id, changes: {
            crossingBondIds: reference === "native bond" ? bracket.crossingBondIds : [],
            compatibility: { ...bracket.compatibility!, unknown: { ...bracket.compatibility!.unknown,
              cdxmlBracketCrossings: reference === "native bond" ? [] : [{
                ref: { objectId: member.id, bondId: reference === "imported bond" ? member.bonds[0]!.id : "missing-bond" },
                ...(reference === "imported inner atom" ? { innerAtomId: member.atoms[0]!.id } : {})
              }]
            } }
          }
        })) });
      const scoped = structureSearchDocument(bracketed, [{ objectId: member.id, atomIds: [member.atoms[0]!.id], bondIds: [] }]);
      const flow = setup();

      await expect(flow.search("pubchem", scoped)).rejects.toBeInstanceOf(StructureSearchRefusal);
      expect(flow.serialize).not.toHaveBeenCalled();
      expect(flow.prompt).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    }
  );

  it("searches a molecule beside an unresolved imported bracket with a live crossing into another molecule", async () => {
    const { document, neighbor } = importedBracketAndNeighbor("SRU", { unresolvedMember: true, keepCrossing: true });
    const selected = applyPatch(document, { op: "setSelection", objectIds: [neighbor.id] });
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", structureSearchDocument(selected))).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CC" });
  });

  it.each(["SRU", "MultipleGroup"] as const)("searches the remaining molecule after deleting an imported %s bracket's member", async usage => {
    const { document, member, neighbor } = importedBracketAndNeighbor(usage);
    const removed = deleteSelectedDocumentObjects(document, [member.id]);
    const brackets = removed.pages[0]!.objects.filter(object => object.type === "bracket");
    expect(brackets).toHaveLength(2);
    expect(brackets.every(bracket => bracket.containedObjectIds.length === 0 &&
      bracket.compatibility?.unknown.bracketedGroup !== undefined)).toBe(true);
    expect(repeatUnits(removed, [neighbor])).toMatchObject([{
      usage: usage === "SRU" ? "sru" : "multiple", members: []
    }]);
    const selected = applyPatch(removed, { op: "setSelection", objectIds: [neighbor.id] });
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", structureSearchDocument(selected))).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CC" });
  });

  it.each([
    ["SRU", "Search can't include a polymer repeat unit. Select atoms outside the brackets."],
    ["MultipleGroup", "Search can't include a repeated (multiple) bracket group. Select atoms outside the brackets."]
  ] as const)("searches beside an imported %s bracket but still refuses its member", async (usage, message) => {
    const { document, member, neighbor } = importedBracketAndNeighbor(usage);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });
    const selected = applyPatch(document, { op: "setSelection", objectIds: [neighbor.id] });

    await expect(search("pubchem", structureSearchDocument(selected))).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CC" });

    const selectedMember = applyPatch(document, { op: "setSelection", objectIds: [member.id] });
    const memberSearch = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });
    const error = await memberSearch("pubchem", structureSearchDocument(selectedMember)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StructureSearchRefusal);
    expect(structureSearchErrorStatus(error)).toBe(message);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["multiple", "Search can't include a repeated (multiple) bracket group. Select atoms outside the brackets."],
    ["unknown", "Search can't include bracketed structure. Select atoms outside the brackets."]
  ] as const)("refuses a %s bracket group using its original usage", async (usage, message) => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const plain = insertNativeBracket(source, { x: 250, y: 250 }, "round", { x: 400, y: 400 });
    const bracketed = applyPatch(plain, { op: "batch", patches: plain.pages[0]!.objects
      .filter(object => object.type === "bracket").map(object => ({
        op: "updateObject" as const, objectId: object.id, changes: {
          bracketUsage: usage, repeatCount: usage === "multiple" ? 3 : undefined,
          containedObjectIds: [molecule.id]
        }
      })) });
    const document = applyPatch(bracketed, { op: "setSelection", objectIds: [molecule.id] });
    const scoped = structureSearchDocument(document);
    const flow = setup();

    const error = await flow.search("pubchem", scoped).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StructureSearchRefusal);
    expect(structureSearchErrorStatus(error)).toBe(message);
    expect(flow.serialize).not.toHaveBeenCalled();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a whole molecule once after Mark as Repeat Unit and selection patches cache its warning", async () => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const plain = insertNativeBracket(source, { x: 250, y: 250 }, "round", { x: 400, y: 400 });
    const marked = toggleBracketRepeatUnit(plain);
    const document = applyPatch(marked, { op: "setSelection", objectIds: [molecule.id] });
    const cached = document.pages[0]!.objects.find(object => object.type === "molecule")!;
    expect(cached.chemistry?.warnings).toEqual([
      expect.objectContaining({ code: "chemistry.bracket_multiplier" })
    ]);
    const scoped = structureSearchDocument(document);
    const flow = setup();

    const error = await flow.search("pubchem", scoped).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StructureSearchRefusal);
    expect(structureSearchErrorStatus(error)).toBe(
      "Search can't include a polymer repeat unit. Select atoms outside the brackets."
    );
    expect(flow.serialize).not.toHaveBeenCalled();
    expect(flow.prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["atom", "bond", "molecule", "all"] as const)(
    "refuses a real round repeat-unit pair once in plain language for %s selection", async selection => {
      const bracketed = pentaneWithRepeatUnit();
      const molecule = bracketed.pages[0]!.objects.find(object => object.type === "molecule")!;
      const document = { ...bracketed, selection: { ...bracketed.selection, objectIds: selection === "all"
        ? bracketed.pages[0]!.objects.map(object => object.id) : [molecule.id] } };
      const fragments = selection === "atom" ? [{ objectId: molecule.id, atomIds: [molecule.atoms[1]!.id], bondIds: [] }]
        : selection === "bond" ? [{ objectId: molecule.id, atomIds: [], bondIds: [molecule.bonds[0]!.id] }] : [];
      const original = structuredClone(document);
      const scoped = structureSearchDocument(document, fragments);
      const prompt = vi.fn(async () => "continue");
      const open = vi.fn(async () => undefined);
      const search = createStructureSearchController({ enabled: () => true, storage, prompt, open });

      const error = await search("pubchem", scoped).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(StructureSearchRefusal);
      expect(structureSearchErrorStatus(error)).toBe(
        "Search can't include a polymer repeat unit. Select atoms outside the brackets."
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(document).toEqual(original);
    }
  );

  it.each([new Error("Browser unavailable"), "Browser unavailable"])("keeps the failure prefix for %s", error => {
    expect(structureSearchErrorStatus(error)).toBe("Structure search failed: Browser unavailable");
  });

  it.each(["atom", "bond"] as const)("searches only the selected %s outside the real repeat-unit pair", async selection => {
    const bracketed = pentaneWithRepeatUnit();
    const molecule = bracketed.pages[0]!.objects.find(object => object.type === "molecule")!;
    const document = { ...bracketed, selection: { ...bracketed.selection, objectIds: [molecule.id] } };
    const scoped = structureSearchDocument(document, [{ objectId: molecule.id,
      atomIds: selection === "atom" ? [molecule.atoms[4]!.id] : [],
      bondIds: selection === "bond" ? [molecule.bonds[3]!.id] : []
    }]);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", {
      site: "pubchem", smiles: selection === "atom" ? "C" : "CC"
    });
  });

  it("keeps detailed SMILES copy/export warnings for the real repeat-unit pair", async () => {
    const bracketed = pentaneWithRepeatUnit();
    const molecule = bracketed.pages[0]!.objects.find(object => object.type === "molecule")!;
    const document = { ...bracketed, selection: { ...bracketed.selection, objectIds: [molecule.id] } };
    const original = structuredClone(document);
    const warnings: string[] = [];

    expect(await copyAsSmiles(document, warnings)).toBe("CCCCC");
    expect(warnings).toEqual([expect.stringContaining(
      "SMILES cannot hold the repeat unit n around 3 atoms (bracket "
    )]);
    expect(warnings[0]).toContain("only the bare structure is written.");
    expect(document).toEqual(original);
  });

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

  it("searches only a click-selected single atom", async () => {
    const source = drawing();
    const molecule = source.pages[0]!.objects.find(object => object.type === "molecule")!;
    const scoped = structureSearchDocument(source, [{
      objectId: molecule.id, atomIds: [molecule.atoms[0]!.id], bondIds: []
    }]);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "C" });
  });

  it("searches only the selected parts of two separate molecules", async () => {
    const first = propane();
    const second = insertNativeSingleBondMolecule(first, { x: 600, y: 300 });
    const molecules = second.pages[0]!.objects.filter(object => object.type === "molecule");
    expect(molecules).toHaveLength(2);
    const scoped = structureSearchDocument({ ...second,
      selection: { ...second.selection, objectIds: [] }
    }, molecules.map(molecule => ({ objectId: molecule.id,
      atomIds: [molecule.atoms[0]!.id], bondIds: [] })));
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "C.C" });
  });

  it("keeps a whole molecule and only the clicked bond fragment of another", async () => {
    const first = propane();
    const second = propane(insertNativeSingleBondMolecule(first, { x: 600, y: 300 }));
    const molecules = second.pages[0]!.objects.filter(object => object.type === "molecule");
    const [whole, fragment] = molecules;
    expect(fragment!.atoms).toHaveLength(3);
    // A clicked bond highlights its host ID too, but must send only its two endpoints.
    const scoped = structureSearchDocument({ ...second,
      selection: { ...second.selection, objectIds: [whole!.id, fragment!.id] }
    }, [{ objectId: fragment!.id, atomIds: [], bondIds: [fragment!.bonds[0]!.id] }]);
    const search = createStructureSearchController({ enabled: () => true, storage, prompt: async () => "continue" });

    await expect(search("pubchem", scoped)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_structure_search", { site: "pubchem", smiles: "CCC.CC" });
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

    await expect(search("pubchem", scoped)).rejects.toMatchObject({
      message: "Search can't include a polymer repeat unit. Select atoms outside the brackets."
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(document).toEqual(original);
  });

  it.each([false, true])("refuses a whole bracketed repeat-unit molecule with its warning once (brackets selected = %s)", async selectBrackets => {
    const bracketed = toggleBracketRepeatUnit(insertNativeBracket(
      drawing(), { x: 250, y: 250 }, "square", { x: 350, y: 350 }
    ));
    const molecule = bracketed.pages[0]!.objects.find(object => object.type === "molecule")!;
    // Creating/marking the brackets selects only the pair; explicitly select the whole molecule.
    expect(bracketed.selection.objectIds).not.toContain(molecule.id);
    const document = { ...bracketed, selection: { ...bracketed.selection,
      objectIds: [molecule.id, ...(selectBrackets ? bracketed.selection.objectIds : [])]
    } };
    const prompt = vi.fn(async () => "continue");
    const search = createStructureSearchController({ enabled: () => true, storage, prompt });

    await expect(search("pubchem", structureSearchDocument(document))).rejects.toMatchObject({
      message: "Search can't include a polymer repeat unit. Select atoms outside the brackets."
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
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
      await expect(search("pubchem", scoped)).rejects.toMatchObject({
        message: "Search can't include a polymer repeat unit. Select atoms outside the brackets."
      });
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
