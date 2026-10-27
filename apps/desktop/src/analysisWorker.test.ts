import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ analyzeStructure: vi.fn(), rdkit: vi.fn(), isospec: vi.fn() }));
vi.mock("@chemdraft/rdkit-adapter", () => ({ analyzeStructure: engine.analyzeStructure }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: engine.rdkit }));
vi.mock("./isospecWasmLoader", () => ({ registerIsoSpecWasmLoader: engine.isospec }));

afterEach(() => {
  for (const key of ["workerEntryEvaluations", "workerEntryProfileListener"]) {
    Reflect.deleteProperty(globalThis, Symbol.for(`org.chemdraft.${key}`));
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("receives the first analysis job before any startup suspension and keeps engine loading lazy", async () => {
  vi.resetModules();
  vi.stubEnv("CHEMDRAFT_WKPROFILE", "1");
  const endpoint = new EventTarget();
  const postMessage = vi.fn();
  vi.stubGlobal("self", { addEventListener: endpoint.addEventListener.bind(endpoint), postMessage });
  vi.stubGlobal("addEventListener", endpoint.addEventListener.bind(endpoint));
  vi.stubGlobal("postMessage", postMessage);
  const dispatch = (data: unknown) => endpoint.dispatchEvent(new MessageEvent("message", { data }));
  // This transport drops events dispatched before a listener exists, like the WebKit regression.
  dispatch({ kind: "warmup", id: -1 });
  const runtime = await import("./analysisWorkerRuntime");
  const evaluation = await import("./workers/entryEvaluation");
  expect(engine.analyzeStructure).not.toHaveBeenCalled();
  expect(engine.rdkit).not.toHaveBeenCalled();
  expect(engine.isospec).not.toHaveBeenCalled();
  let initialized!: () => void;
  engine.analyzeStructure.mockReturnValueOnce(new Promise<void>(resolve => { initialized = resolve; }));

  // Prelink static dependencies and evaluate the real entry without awaiting module completion.
  // A dynamic import or top-level await would suspend before startAnalysisWorker, losing this job.
  const entry = new URL("./analysisWorker.ts", import.meta.url);
  const source = readFileSync(entry, "utf8").replaceAll("import.meta.url", JSON.stringify(entry.href));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  });
  const modules: Record<string, unknown> = { "./analysisWorkerRuntime": runtime, "./workers/entryEvaluation": evaluation };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (require: (id: string) => unknown, exports: object) => Promise<void>;
  const evaluating = new AsyncFunction("require", "exports", outputText)(id => {
    if (!(id in modules)) throw new Error(`Unexpected entry dependency: ${id}`);
    return modules[id];
  }, {});
  dispatch({ kind: "warmup", id: 7 });
  dispatch({ kind: "chemdraft-worker-profile-request", requestId: 9 });
  expect(engine.analyzeStructure).toHaveBeenCalledOnce();
  expect(engine.rdkit).toHaveBeenCalledOnce();
  expect(engine.isospec).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "chemdraft-worker-profile", requestId: 9,
    entries: [{ worker: "analysis", entryUrl: entry.href, evaluations: 1 }] });
  await evaluating;
  initialized();
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 7, kind: "ready" }));
  expect(engine.analyzeStructure).toHaveBeenCalledOnce();
});
