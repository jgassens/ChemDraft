import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConformerWorkRequest, ConformerWorkResponse } from "./conformerWorker";
import type { Spin3dEnginePreference } from "./spin3dSettings";

const engines = vi.hoisted(() => ({
  ensureRdkit: vi.fn(),
  rdkitGenerate: vi.fn(),
  ensureOclResources: vi.fn(),
  oclGenerate: vi.fn()
}));

vi.mock("@chemdraft/rdkit-adapter", () => ({
  ensureRdkit: engines.ensureRdkit,
  generate3DConformerProgressive: engines.rdkitGenerate
}));
vi.mock("@chemdraft/ocl-adapter", () => ({
  ensureOclResources: engines.ensureOclResources,
  generate3DConformerProgressive: engines.oclGenerate,
  setOclResourcesUrl: vi.fn(),
  withOclConformerTrace: (_listener: unknown, run: () => Promise<unknown>) => run()
}));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("./oclResources", () => ({ oclResourcesUrl: "test:ocl-resources" }));

let receive: (event: MessageEvent<ConformerWorkRequest>) => void;
const postMessage = vi.fn<(response: ConformerWorkResponse) => void>();

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  postMessage.mockClear();
  for (const mock of Object.values(engines)) mock.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("postMessage", postMessage);
  vi.stubGlobal("addEventListener", (type: string, listener: typeof receive) => {
    if (type === "message") receive = listener;
  });
  await import("./conformerWorker");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function warmup(id: number, enginePreference: Spin3dEnginePreference): void {
  receive({ data: { kind: "warmup", id, enginePreference } } as MessageEvent<ConformerWorkRequest>);
}

describe("conformer worker warmup", () => {
  it("warms only OpenChemLib when it is the preferred engine", async () => {
    warmup(1, "openchemlib");
    await vi.runAllTimersAsync();

    expect(engines.ensureRdkit).not.toHaveBeenCalled();
    expect(engines.rdkitGenerate).not.toHaveBeenCalled();
    expect(engines.ensureOclResources).toHaveBeenCalledOnce();
    expect(engines.oclGenerate).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ id: 1, stage: "warmed" });
  });

  it.each(["auto", "rdkit"] as const)("warms RDKit and the OCL fallback for %s", async (preference) => {
    warmup(1, preference);
    await vi.runAllTimersAsync();

    expect(engines.ensureRdkit).toHaveBeenCalledOnce();
    expect(engines.rdkitGenerate).toHaveBeenCalledWith(
      { molfile: expect.any(String) }, { optimize: "none" }
    );
    expect(engines.oclGenerate).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ id: 1, stage: "warmed" });
  });

  it.each([
    ["openchemlib", "auto"],
    ["auto", "openchemlib"]
  ] as const)("keeps queued warmups for %s then %s", async (older, newer) => {
    let finishResources!: () => void;
    engines.ensureOclResources.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishResources = resolve;
    }));
    warmup(1, "openchemlib");
    await vi.waitFor(() => expect(engines.ensureOclResources).toHaveBeenCalledOnce());

    warmup(2, older);
    warmup(3, newer);
    finishResources();
    await vi.runAllTimersAsync();

    const completed = postMessage.mock.calls.map(([response]) => response)
      .filter((response) => response.stage === "warmed");
    expect(completed).toEqual([
      { id: 1, stage: "warmed" },
      { id: 2, stage: "warmed" },
      { id: 3, stage: "warmed" }
    ]);
    expect(engines.ensureRdkit).toHaveBeenCalledOnce();
    expect(engines.rdkitGenerate).toHaveBeenCalledOnce();
    expect(engines.oclGenerate).toHaveBeenCalledTimes(3);
  });
});
