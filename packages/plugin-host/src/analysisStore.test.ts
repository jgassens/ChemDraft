import type { PluginAnalysisRecordInput } from "@chemdraft/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { AnalysisStore, PluginHost } from "./index";

const FIXED_TIME = "2026-07-07T00:00:00.000Z";

function sampleInput(overrides: Partial<PluginAnalysisRecordInput> = {}): PluginAnalysisRecordInput {
  return {
    analysisType: "nmr.forward-prediction",
    schemaVersion: "1",
    source: { documentId: "doc1", pageId: "p1", objectId: "m1", sourceFingerprint: "fp1" },
    status: "complete",
    payload: { shifts: [1, 2, 3] },
    provenance: { engineId: "fixture", method: "fixture-fragment" },
    ...overrides
  };
}

function makeStore(now: () => string = () => FIXED_TIME) {
  let sequence = 0;
  const onChange = vi.fn();
  const store = new AnalysisStore({ now, createId: () => `rec-${++sequence}`, onChange });
  return { store, onChange };
}

describe("AnalysisStore", () => {
  it("stamps id and createdAt, keeps the caller's plugin id, and returns a copy", () => {
    const { store, onChange } = makeStore();
    const record = store.write("org.a", sampleInput());
    expect(record).toMatchObject({ id: "rec-1", pluginId: "org.a", createdAt: FIXED_TIME });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("deep-copies input on write so later mutation of the input cannot change stored state", () => {
    const { store } = makeStore();
    const input = sampleInput();
    store.write("org.a", input);
    (input.payload as { shifts: number[] }).shifts.push(999);
    input.source.objectId = "mutated";

    const [stored] = store.list<{ shifts: number[] }>();
    expect(stored.payload.shifts).toEqual([1, 2, 3]);
    expect(stored.source.objectId).toBe("m1");
  });

  it("returns copies on read so mutating a returned record cannot change stored state", () => {
    const { store } = makeStore();
    store.write("org.a", sampleInput());
    const first = store.list<{ shifts: number[] }>()[0];
    first.payload.shifts.push(42);
    expect(store.list<{ shifts: number[] }>()[0].payload.shifts).toEqual([1, 2, 3]);
  });

  it("filters by plugin, analysisType, document, page, and object (conjunctive)", () => {
    const { store } = makeStore();
    store.write("org.a", sampleInput());
    store.write("org.b", sampleInput({ analysisType: "mass.fragments", source: { documentId: "doc1", pageId: "p1", objectId: "m2", sourceFingerprint: "fp2" } }));
    store.write("org.a", sampleInput({ source: { documentId: "doc2", pageId: "p9", objectId: "m9", sourceFingerprint: "fp9" } }));

    expect(store.list({ pluginId: "org.a" })).toHaveLength(2);
    expect(store.list({ analysisType: "mass.fragments" })).toHaveLength(1);
    expect(store.list({ documentId: "doc1" })).toHaveLength(2);
    expect(store.list({ objectId: "m9" })).toHaveLength(1);
    expect(store.list({ pluginId: "org.a", documentId: "doc2" })).toHaveLength(1);
    expect(store.list({ pluginId: "org.a", analysisType: "mass.fragments" })).toHaveLength(0);
  });

  it("getLatest picks the newest by createdAt, breaking ties by write order", () => {
    // Equal timestamps → last written wins.
    const { store } = makeStore();
    store.write("org.a", sampleInput({ payload: { n: 1 } }));
    store.write("org.a", sampleInput({ payload: { n: 2 } }));
    expect(store.getLatest<{ n: number }>({ pluginId: "org.a" })?.payload.n).toBe(2);

    // Increasing timestamps → highest time wins regardless of write interleaving.
    let tick = 0;
    const timed = makeStore(() => `2026-07-07T00:00:0${tick++}.000Z`).store;
    timed.write("org.a", sampleInput({ payload: { n: 10 } })); // t0
    timed.write("org.a", sampleInput({ payload: { n: 20 } })); // t1
    expect(timed.getLatest<{ n: number }>()?.payload.n).toBe(20);
    expect(timed.getLatest({ objectId: "nope" })).toBeUndefined();
  });
});

// A candidate manifest for registerPlugin (which validates `unknown`); schema fills contribution
// defaults, so only the fields under test are specified.
function writeManifest(id: string) {
  return {
    id,
    name: id,
    version: "0.0.1",
    apiVersion: "^0.1.0",
    entry: "dist/plugin.js",
    permissions: ["analysis.write"],
    contributes: {
      commands: [
        { id: `${id}.write`, title: "Write", requiredPermissions: ["analysis.write"] },
        { id: `${id}.list`, title: "List", requiredPermissions: ["analysis.write"] }
      ]
    }
  };
}

describe("PluginHost analysis wiring", () => {
  it("exposes analysis only with analysis.write", async () => {
    const granted = new PluginHost();
    granted.registerPlugin(writeManifest("org.granted"), {
      commandHandlers: { "org.granted.write": async (context) => context.analysis !== undefined }
    });
    await expect(granted.invokeCommand("org.granted.write")).resolves.toBe(true);

    const denied = new PluginHost();
    denied.registerPlugin(
      {
        id: "org.denied",
        name: "Denied",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: [],
        contributes: { commands: [{ id: "org.denied.check", title: "Check" }] }
      },
      { commandHandlers: { "org.denied.check": async (context) => context.analysis } }
    );
    await expect(denied.invokeCommand("org.denied.check")).resolves.toBeUndefined();
  });

  it("stamps records via the host clock and id factory, and notifies subscribers on write", async () => {
    const host = new PluginHost({ now: () => FIXED_TIME, createId: () => "rec-fixed" });
    const listener = vi.fn();
    host.subscribe(listener);
    host.registerPlugin(writeManifest("org.a"), {
      commandHandlers: { "org.a.write": async (context) => context.analysis?.write(sampleInput()) }
    });
    listener.mockClear();

    const record = await host.invokeCommand("org.a.write");
    expect(record).toMatchObject({ id: "rec-fixed", pluginId: "org.a", createdAt: FIXED_TIME });
    expect(listener).toHaveBeenCalled();
  });

  it("scopes a plugin's reads to its own records while the desktop reads all", async () => {
    const host = new PluginHost({ now: () => FIXED_TIME });

    for (const id of ["org.a", "org.b"]) {
      host.registerPlugin(writeManifest(id), {
        commandHandlers: {
          [`${id}.write`]: async (context) =>
            context.analysis?.write(sampleInput({ source: { documentId: "doc1", pageId: "p1", objectId: id, sourceFingerprint: id } })),
          [`${id}.list`]: async (context) => context.analysis?.list()
        }
      });
    }

    await host.invokeCommand("org.a.write");
    await host.invokeCommand("org.b.write");

    const aRecords = (await host.invokeCommand("org.a.list")) as ReadonlyArray<{ pluginId: string }>;
    expect(aRecords.map((record) => record.pluginId)).toEqual(["org.a"]);

    // Trusted desktop path is unscoped.
    expect(host.listAnalysis().map((record) => record.pluginId).sort()).toEqual(["org.a", "org.b"]);
    expect(host.getLatestAnalysis({ objectId: "org.b" })?.pluginId).toBe("org.b");
  });
});
