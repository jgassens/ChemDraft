import { afterEach, expect, it, vi } from "vitest";
import * as rdkit from "@chemdraft/rdkit-adapter";
import * as ocl from "@chemdraft/ocl-adapter";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { checkedSmilesPaste } from "../smilesPasteIdentity";
import { createIdentityWorkerClient } from "./identityWorkerClient";
import type { IdentityRequest, IdentityWorkerPort } from "./identityProtocol";
import { depictSmilesForPaste } from "../smilesListPaste";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("paste dispatches a module worker without running RDKit or OCL synchronously on the UI thread", async () => {
  const generate = vi.spyOn(rdkit, "generateSmiles2DMolfile").mockImplementation(() => { throw new Error("UI-thread RDKit"); });
  const fallback = vi.spyOn(ocl, "depictSmiles2D").mockImplementation(() => { throw new Error("UI-thread OCL"); });
  const requests: unknown[] = [];
  const constructor = vi.fn();
  const workerResult = { depiction: { atoms: [{ element: "C", x: 0, y: 0 }], bonds: [] }, stereoCount: 0 };
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    constructor(url: URL, options: WorkerOptions) {
      constructor(url, options);
      queueMicrotask(() => this.onmessage?.({ data: { id: 0, stage: "ready" } }));
    }
    postMessage(request: { id: number; smiles: string }) {
      requests.push(request);
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, stage: "result", result: workerResult } }));
    }
    terminate() {}
  });
  await expect(depictSmilesForPaste("C")).resolves.toEqual(workerResult);
  expect(constructor).toHaveBeenCalledWith(expect.any(URL), { type: "module" });
  expect(requests).toEqual([{ id: 1, smiles: "C" }]);
  expect(generate).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});

it("verifies a normal paste in a module worker without loading RDKit on the window thread", async () => {
  const ensure = vi.spyOn(rdkit, "ensureRdkit").mockRejectedValue(new Error("UI-thread RDKit"));
  const requests: IdentityRequest[] = [];
  const constructor = vi.fn();
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    onmessageerror = null;
    constructor(url: URL, options: WorkerOptions) {
      constructor(url, options);
      queueMicrotask(() => this.onmessage?.({ data: { id: 0, stage: "ready" } }));
    }
    postMessage(request: IdentityRequest) {
      requests.push(request);
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, stage: "result", result: {
        valid: true, canonicalSmiles: "C", identitySmiles: "C", formula: "CH4", heavyAtoms: 1, warnings: []
      } } }));
    }
    terminate() {}
  });
  const pasted = await checkedSmilesPaste(createEmptyDocument(), { x: 100, y: 100 }, {
    atoms: [{ element: "C", x: 0, y: 0, charge: 0 }], bonds: []
  }, "C");
  expect(pasted.pages[0]!.objects).toHaveLength(1);
  expect(constructor).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: expect.stringContaining("identityWorker.ts") }), { type: "module" });
  expect(requests.map(({ format, stereoReference }) => [format, stereoReference]))
    .toEqual([["smiles", undefined], ["molfile", "C"]]);
  expect(ensure).not.toHaveBeenCalled();
});

it("kills a timed-out worker and runs queued verification in a fresh worker", async () => {
  const workers: IdentityWorkerPort[] = [];
  const terminated = vi.fn();
  const client = createIdentityWorkerClient(() => {
    const port: IdentityWorkerPort = {
      onmessage: null, onerror: null, onmessageerror: null, terminate: terminated,
      postMessage: request => {
        if (workers.length === 1) return;
        queueMicrotask(() => port.onmessage?.({ data: { id: request.id, stage: "result", result: {
          valid: true, canonicalSmiles: "C", identitySmiles: "C", formula: "CH4", heavyAtoms: 1, warnings: []
        } } }));
      }
    };
    workers.push(port);
    queueMicrotask(() => port.onmessage?.({ data: { id: 0, stage: "ready" } }));
    return port;
  }, 5);
  const refused = client("smiles", "CCO");
  const queued = client("smiles", "C");
  await expect(refused).rejects.toThrow("within 0.005 s; nothing was inserted");
  await expect(queued).resolves.toMatchObject({ valid: true, identitySmiles: "C" });
  expect(terminated).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  expect(workers[0]!.onmessage).toBeNull();
});
