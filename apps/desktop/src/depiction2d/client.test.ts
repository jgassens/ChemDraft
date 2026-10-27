import { afterEach, expect, it, vi } from "vitest";
import * as rdkit from "@chemdraft/rdkit-adapter";
import * as ocl from "@chemdraft/ocl-adapter";
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
