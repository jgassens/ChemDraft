import { describe, expect, it } from "vitest";
import { EditorAdapterError, type EditorLoadRequest } from "@chemdraft/editor-adapter";
import {
  createKetcherAdapter,
  ketcherAdapterDisconnectedCapabilities,
  type KetcherEngineHost,
  type KetcherStructurePayload
} from "./index";

const molecule = {
  id: "mol_001",
  type: "molecule",
  x: 120,
  y: 160,
  width: 180,
  height: 96,
  rotation: 0,
  style: {},
  structureFormat: "smiles",
  structure: "CCO",
  atoms: [],
  bonds: [],
  superatoms: [],
  rGroups: []
} satisfies EditorLoadRequest["object"];

function createFixtureEngine(): KetcherEngineHost & { loaded?: KetcherStructurePayload } {
  return {
    version: "fixture-1",
    clear() {
      this.loaded = undefined;
    },
    loadMolecule(payload) {
      this.loaded = payload;
    },
    saveMolecule(format) {
      return {
        format,
        value: "fixture-molfile-v3000"
      };
    },
    exportSvg() {
      return "<svg data-fixture=\"ketcher\" />";
    }
  };
}

function createObservableFixtureEngine(): KetcherEngineHost & {
  listener?: (event: { reason: "content" }) => void;
  disposed: boolean;
} {
  return {
    ...createFixtureEngine(),
    disposed: false,
    onChange(listener) {
      this.listener = listener;
      return () => {
        this.disposed = true;
      };
    }
  };
}

describe("KetcherAdapter", () => {
  it("reports honest disconnected capabilities without pretending to edit chemistry", () => {
    const adapter = createKetcherAdapter();

    expect(adapter.getCapabilities()).toEqual(ketcherAdapterDisconnectedCapabilities);
    expect(adapter.getCapabilities().canEditMolecules).toBe(false);
    expect(adapter.getCapabilities().gaps.map((gap) => gap.code)).toContain("editor.gap.page_layout");
  });

  it("loads and saves a molecule through an injected engine host", async () => {
    const engine = createFixtureEngine();
    const adapter = createKetcherAdapter({ engine });

    await adapter.loadObject({ object: molecule });
    const result = await adapter.saveObject();

    expect(engine.loaded).toEqual({ format: "smiles", value: "CCO" });
    expect(result.object).toMatchObject({
      id: "mol_001",
      type: "molecule",
      x: 120,
      y: 160,
      width: 180,
      structureFormat: "molfile-v3000",
      structure: "fixture-molfile-v3000"
    });
    expect(result.warnings).toEqual([]);
  });

  it("rejects page-level objects instead of silently treating them as editor content", async () => {
    const adapter = createKetcherAdapter({ engine: createFixtureEngine() });
    const textObject = {
      id: "text_001",
      type: "text",
      x: 10,
      y: 20,
      width: 120,
      height: 28,
      rotation: 0,
      style: {},
      text: "reaction condition",
      spans: []
    } satisfies EditorLoadRequest["object"];

    await expect(adapter.loadObject({ object: textObject })).rejects.toMatchObject({
      name: "EditorAdapterError",
      code: "editor.unsupported_object"
    } satisfies Partial<EditorAdapterError>);
  });

  it("warns when native ChemDraft metadata is preserved but not editable through the engine", async () => {
    const adapter = createKetcherAdapter({ engine: createFixtureEngine() });
    await adapter.loadObject({
      object: {
        ...molecule,
        superatoms: [{ label: "Ph", attachmentPoints: [], warnings: [] }],
        rGroups: [{ label: "R", querySemantics: "display-only", attachmentPoints: [], warnings: [] }]
      }
    });

    const result = await adapter.saveObject();

    expect(result.warnings).toEqual([
      "Superatom metadata is preserved on the ChemDraft object but is not editable through KetcherAdapter.",
      "R-group metadata is preserved on the ChemDraft object but is not editable through KetcherAdapter."
    ]);
    expect(result.object).toMatchObject({
      superatoms: [{ label: "Ph" }],
      rGroups: [{ label: "R" }]
    });
  });

  it("reports connected capabilities and explicit non-editor gaps", () => {
    const adapter = createKetcherAdapter({ engine: createFixtureEngine() });
    const capabilities = adapter.getCapabilities();

    expect(capabilities).toMatchObject({
      connected: true,
      implementationName: "KetcherAdapter",
      implementationVersion: "fixture-1",
      canEditMolecules: true,
      canEditPageLayoutObjects: false,
      canRenderMechanismAnnotations: false
    });
    expect(capabilities.gaps.map((gap) => gap.code)).toEqual([
      "editor.gap.mechanism_annotations",
      "editor.gap.page_layout",
      "editor.gap.superatoms_rgroups"
    ]);
  });

  it("routes engine and adapter change events through the editor-adapter listener contract", async () => {
    const engine = createObservableFixtureEngine();
    const adapter = createKetcherAdapter({ engine });
    const events: string[] = [];

    const subscription = adapter.onChange((event) => events.push(event.reason));
    await adapter.loadObject({ object: molecule });
    engine.listener?.({ reason: "content" });
    subscription.dispose();

    expect(events).toEqual(["content", "content"]);
    expect(engine.disposed).toBe(true);
  });
});
