import { afterEach, describe, expect, it, vi } from "vitest";
import * as brackets from "./brackets";
import {
  createEmptyDocument, deserializeDocument, migrateDocument, parseDocument, readDocument,
  readSerializedDocument, serializeDocument, validateDocument
} from "./document";
import { applyPatch } from "./patches";
import type { BracketObject, ChemDraftDocument, MoleculeObject } from "./schemas";

const open: BracketObject = {
  id: "open", type: "bracket", bracketKind: "square", side: "open", pairId: "pair",
  bracketUsage: "multiple", repeatCount: 3, containedObjectIds: ["molecule"],
  crossingBondIds: [{ objectId: "molecule", bondId: "bond" }],
  x: 0, y: 0, width: 10, height: 60, rotation: 0, style: {}
};
const close: BracketObject = { ...open, id: "close", side: "close", x: 70, label: "m" };

function documentWithBrackets(version?: string): ChemDraftDocument {
  const document = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
  document.pages[0]!.objects = [structuredClone(open), structuredClone(close)];
  if (version) document.formatVersion = document.minAppVersion = version;
  return document;
}

afterEach(() => vi.restoreAllMocks());

describe("native reader bracket normalization", () => {
  const loaders: [string, (candidate: ChemDraftDocument) => ChemDraftDocument][] = [
    ["strict parse", parseDocument],
    ["strict validation", candidate => {
      const result = validateDocument(candidate);
      if (!result.ok) throw new Error("Expected a valid document");
      return result.document;
    }],
    ["migration", migrateDocument],
    ["decoded reader", candidate => readDocument(candidate).document],
    ["serialized reader", candidate => readSerializedDocument(JSON.stringify(candidate)).document],
    ["deserialization", candidate => deserializeDocument(JSON.stringify(candidate))]
  ];

  it.each(loaders)("normalizes an orphan exactly once through %s", (_name, load) => {
    const source = documentWithBrackets();
    source.pages[0]!.objects.pop();
    const before = structuredClone(source);
    const normalize = vi.spyOn(brackets, "normalizeBracketPairs");
    const loaded = load(source);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(loaded.pages[0]!.objects).toEqual([{
      id: "open", type: "bracket", bracketKind: "square", side: "open", containedObjectIds: [],
      x: 0, y: 0, width: 10, height: 60, rotation: 0, style: {}
    }]);
    expect(loaded.compatibility.warnings).toEqual([{
      code: "document.bracket_partner_missing", objectId: "open",
      message: "Bracket open had no partner; repeat-unit mark removed."
    }]);
    expect(source).toEqual(before);
  });

  it("normalizes exactly once after a legacy layout migration", () => {
    const source = documentWithBrackets();
    source.pages[0]!.objects.pop();
    const raw = JSON.parse(JSON.stringify(source));
    delete raw.pages[0].layout;
    const normalize = vi.spyOn(brackets, "normalizeBracketPairs");
    const loaded = readDocument(raw).document;
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(loaded.compatibility.warnings).toHaveLength(1);
    expect(loaded.pages[0]!.objects[0]).not.toHaveProperty("pairId");
  });

  it.each([undefined, "1.2.0", "1.3.0"])("annotates cached chemistry without changing the graph with version %s", version => {
    const source = documentWithBrackets(version);
    const molecule: MoleculeObject = {
      id: "molecule", type: "molecule", x: 20, y: 20, width: 22, height: 10, rotation: 0, style: {},
      structure: "CO", structureFormat: "smiles",
      atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "o", element: "O", x: 22, y: 0, formalCharge: 0 }],
      bonds: [{ id: "bond", fromAtomId: "c", toAtomId: "o", order: "single" }], superatoms: [], rGroups: [],
      chemistry: { formula: "CH4O", averageMass: 32.04, isotopeLabels: [], stereochemistry: [], warnings: [] }
    };
    source.pages[0]!.objects.unshift(molecule);
    const normalize = vi.spyOn(brackets, "normalizeBracketPairs");
    const loaded = readDocument(source).document;
    expect(normalize).toHaveBeenCalledTimes(1);
    const warning = { code: "chemistry.bracket_multiplier", objectId: "molecule",
      message: "Molecule molecule is inside a multiple group x3; values and molecular graph exports are for one drawn copy only." };
    expect(loaded.pages[0]!.objects[0]).toEqual({ ...molecule, chemistry: { ...molecule.chemistry, warnings: [warning] } });
    expect(molecule.chemistry!.warnings).toEqual([]);
    expect(deserializeDocument(serializeDocument(loaded)).pages[0]!.objects).toEqual(loaded.pages[0]!.objects);
  });
});

describe("opaque native bracket usage", () => {
  it.each([undefined, "1.2.0", "1.3.0"])("preserves source strings and warns with version %s", version => {
    const source = JSON.parse(JSON.stringify(documentWithBrackets(version)));
    source.pages[0].objects[0].bracketUsage = "future-usage";
    const before = structuredClone(source);
    expect(() => parseDocument(source)).toThrow();
    const read = readDocument(source);
    expect(read.warnings).toEqual([{
      code: "NATIVE_BRACKET_USAGE_PRESERVED", path: ["pages", 0, "objects", 0, "bracketUsage"], originalValue: "future-usage",
      message: 'Unknown bracket usage "future-usage" in object open was kept as-is; ChemDraft does not interpret it.'
    }]);
    expect(read.document.compatibility.nativeExtensions).toEqual([{
      kind: "enum", path: ["pages", { id: "page_001" }, "objects", { id: "open" }, "bracketUsage"],
      originalValue: "future-usage", fallbackValue: "unknown"
    }]);
    expect(parseDocument(read.document)).toEqual(read.document);
    const saved = serializeDocument(read.document);
    expect(JSON.parse(saved)).toEqual({ ...source, formatVersion: version ?? "1.2.0", minAppVersion: version ?? "1.2.0" });
    const reopened = readSerializedDocument(saved);
    expect(reopened.warnings).toEqual(read.warnings);
    expect(serializeDocument(reopened.document)).toBe(saved);
    expect(source).toEqual(before);
  });

  it("preserves an orphan's opaque usage while removing known pair metadata", () => {
    const source = JSON.parse(JSON.stringify(documentWithBrackets()));
    source.pages[0].objects = [{ ...open, bracketUsage: "future-orphan" }];
    const read = readDocument(source);
    const saved = serializeDocument(read.document);
    expect(JSON.parse(saved).pages[0].objects).toEqual([{
      id: "open", type: "bracket", bracketKind: "square", side: "open", containedObjectIds: [],
      x: 0, y: 0, width: 10, height: 60, rotation: 0, style: {}, bracketUsage: "future-orphan"
    }]);
    expect(read.warnings).toEqual([{
      code: "NATIVE_BRACKET_USAGE_PRESERVED", path: ["pages", 0, "objects", 0, "bracketUsage"], originalValue: "future-orphan",
      message: 'Unknown bracket usage "future-orphan" in object open was kept as-is; ChemDraft does not interpret it.'
    }]);
    expect(read.document.compatibility.warnings).toHaveLength(1);
    expect(serializeDocument(readSerializedDocument(saved).document)).toBe(saved);
  });

  it("keeps explicit edits instead of restoring the preserved source usage", () => {
    const source = JSON.parse(JSON.stringify(documentWithBrackets()));
    source.pages[0].objects[0].bracketUsage = "future-usage";
    const read = readDocument(source);
    const edited = applyPatch(read.document, { op: "updateObject", objectId: "open", changes: { bracketUsage: "generic" } });
    expect(JSON.parse(serializeDocument(edited)).pages[0].objects[0].bracketUsage).toBe("generic");
  });

  it.each([null, 3, {}, []])("rejects malformed bracket usage %j", bracketUsage => {
    const source = JSON.parse(JSON.stringify(documentWithBrackets("1.3.0")));
    source.pages[0].objects[0].bracketUsage = bracketUsage;
    expect(() => readDocument(source)).toThrow(/bracketUsage/);
  });

  it("refuses unlisted future bracket chemistry fields", () => {
    const source = JSON.parse(JSON.stringify(documentWithBrackets("1.3.0")));
    source.pages[0].objects[0].futureConnectivity = { mode: "branch" };
    expect(() => readDocument(source)).toThrow(/Unsupported chemistry field "futureConnectivity"/);
  });
});
