import { describe, expect, it } from "vitest";
import { EditorAdapterError, type EditorLoadRequest } from "@chemdraft/editor-adapter";
import {
  createKetcherAdapter,
  createKetcherEngineHost,
  ketcherAdapterDisconnectedCapabilities,
  type KetcherEngineHost,
  type KetcherRuntimeApi,
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
  it("does not attribute the previous molecule's structure to an object whose load failed", async () => {
    // `loadedObject` was assigned before awaiting the engine load. On rejection the adapter then
    // claimed the NEW object was loaded while the engine still held the PREVIOUS one, so the next
    // save wrote the old structure under the new object's id and metadata — a silent swap that
    // looks like a successful edit. Reachable from the editor host's Apply after a failed load.
    let failNextLoad = false;
    const engine: KetcherEngineHost & { loaded?: KetcherStructurePayload } = {
      version: "fixture-1",
      clear() {
        this.loaded = undefined;
      },
      loadMolecule(payload) {
        if (failNextLoad) {
          throw new Error("ketcher refused the structure");
        }
        this.loaded = payload;
      },
      saveMolecule(format) {
        return { format, value: this.loaded?.value ?? "" };
      },
      exportSvg() {
        return "<svg />";
      }
    };

    const adapter = createKetcherAdapter({ engine });
    await adapter.loadObject({ object: { ...molecule, id: "mol_first", structure: "CCO" } });

    failNextLoad = true;
    await expect(
      adapter.loadObject({ object: { ...molecule, id: "mol_second", structure: "c1ccccc1" } })
    ).rejects.toThrow();

    // The engine still holds the first molecule, so the save must still describe the first object.
    const saved = await adapter.saveObject();
    expect(saved.object).toMatchObject({ id: "mol_first", structure: "CCO" });
  });

  it("wraps the real Ketcher runtime shape behind the engine host contract", async () => {
    const calls: string[] = [];
    const runtime: KetcherRuntimeApi = {
      version: "runtime-fixture",
      async setMolecule(structure) {
        calls.push(`set:${structure}`);
      },
      async getSmiles() {
        calls.push("get:smiles");
        return "CCN";
      },
      async getMolfile(format) {
        calls.push(`get:molfile:${format}`);
        return `molfile-${format}`;
      },
      async generateImage(data) {
        calls.push(`svg:${data}`);
        return new Blob(["<svg data-ketcher-runtime=\"fixture\" />"], { type: "image/svg+xml" });
      }
    };
    const engine = createKetcherEngineHost(runtime);

    await engine.loadMolecule({ format: "smiles", value: "CCO" });
    await expect(engine.saveMolecule("smiles")).resolves.toEqual({ format: "smiles", value: "CCN" });
    await expect(engine.saveMolecule("molfile-v3000")).resolves.toEqual({
      format: "molfile-v3000",
      value: "molfile-v3000"
    });
    await expect(engine.exportSvg?.()).resolves.toContain("data-ketcher-runtime");

    expect(engine.version).toBe("runtime-fixture");
    expect(calls).toEqual([
      "set:CCO",
      "get:smiles",
      "get:molfile:v3000",
      "get:molfile:v3000",
      "svg:molfile-v3000"
    ]);
  });

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
