// @vitest-environment jsdom

import type { PluginProvidedImage, PluginRecognitionResult } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecognitionProgressIndicator, formatElapsed, recognitionStageText } from "./RecognitionProgressIndicator";
import { StructureRecognitionController } from "./StructureRecognitionController";
import type {
  StructureRecognitionEngine,
  StructureRecognitionOutcome,
  StructureRecognitionProgress
} from "./structureRecognitionEngine";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const image: PluginProvidedImage = {
  mediaType: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 640,
  height: 480,
  source: "file",
  fileName: "structure.png"
};

const recognized: Extract<StructureRecognitionOutcome, { status: "recognized" }> = {
  status: "recognized",
  smiles: "C",
  molfile: "mol",
  confidence: 0.92,
  atoms: [],
  bonds: [],
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 120,
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
};

const prepared: PluginRecognitionResult = {
  status: "recognized",
  result: {
    sourceImageRef: "data:image/png;base64,iVBORw==",
    proposedMolfile: "mol",
    confidence: 0.92,
    atomConfidence: [],
    bondConfidence: [],
    warnings: []
  }
};

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** A real controller over an engine the test drives: progress, then the answer. */
function setup() {
  let report: ((progress: StructureRecognitionProgress) => void) | undefined;
  let answer: ((outcome: StructureRecognitionOutcome) => void) | undefined;
  let finishPreparing: ((result: PluginRecognitionResult) => void) | undefined;
  const engine: StructureRecognitionEngine = {
    status: vi.fn(async () => ({ state: "installed" as const, requiredDiskBytes: 0, freeDiskBytes: 0 })),
    install: vi.fn(),
    cancelInstall: vi.fn(async () => undefined),
    uninstall: vi.fn(),
    recognizeImage: vi.fn(
      (_input, onProgress) =>
        new Promise<StructureRecognitionOutcome>((resolve) => {
          report = onProgress;
          answer = resolve;
        })
    ),
    cancelRecognition: vi.fn(async () => answer?.({ status: "cancelled" }))
  };
  const controller = new StructureRecognitionController(
    engine,
    () =>
      new Promise<PluginRecognitionResult>((resolve) => {
        finishPreparing = resolve;
      })
  );
  controller.attachInstallPresenter();

  container = document.createElement("div");
  document.body.append(container);
  // Stands in for the drawing canvas: something the user keeps using while recognition runs.
  const canvas = document.createElement("button");
  canvas.textContent = "canvas";
  document.body.append(canvas);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(RecognitionProgressIndicator, {
        source: controller,
        onCancel: (id: number) => controller.cancelRecognition(id)
      })
    )
  );
  return {
    controller,
    engine,
    canvas,
    start: () => controller.recognize({ id: "org.chemdraft.ocsr.molscribe", name: "MolScribe OCSR" }, image, new AbortController().signal),
    report: (progress: StructureRecognitionProgress) => act(() => report!(progress)),
    answer: (outcome: StructureRecognitionOutcome) => answer!(outcome),
    finishPreparing: (result: PluginRecognitionResult) => finishPreparing!(result)
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) await Promise.resolve();
  });
}

const card = () => container!.querySelector<HTMLElement>(".recognition-progress");
const stage = () => card()?.querySelector(".recognition-progress-stage")?.textContent;
const bar = () => card()?.querySelector<HTMLProgressElement>("progress");
const elapsed = () => card()?.querySelector(".recognition-progress-elapsed time")?.textContent;

describe("RecognitionProgressIndicator", () => {
  it("names the plugin and says, in plain words, what each stage is doing", async () => {
    const view = setup();
    expect(card()).toBeNull();

    const pending = view.start();
    await act(async () => undefined);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("MolScribe OCSR");
    expect(stage()).toBe("Checking the recognition engine…");
    expect(bar()!.hasAttribute("value")).toBe(false);

    await settle();
    view.report({ stage: "starting" });
    expect(stage()).toBe("Starting the recognition engine…");
    expect(bar()!.hasAttribute("value")).toBe(false);

    view.report({ stage: "reading", run: 2, runsPlanned: 5 });
    expect(stage()).toBe("Reading the structure… (reading 2 of 5)");
    expect(bar()!.getAttribute("max")).toBe("5");
    expect(bar()!.value).toBe(1);

    view.report({ stage: "reading", run: 6, runsPlanned: 15 });
    expect(stage()).toBe("Reading the structure… (reading 6 of 15)");
    expect(bar()!.getAttribute("max")).toBe("15");

    view.answer(recognized);
    await settle();
    expect(stage()).toBe("Checking the result…");
    expect(bar()!.hasAttribute("value")).toBe(false);

    view.finishPreparing(prepared);
    await settle();
    await expect(pending).resolves.toEqual(prepared);
    expect(card()).toBeNull();
  });

  it("counts the elapsed time every second", async () => {
    const view = setup();
    void view.start();
    await settle();
    expect(elapsed()).toBe("0:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(elapsed()).toBe("0:01");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(64_000);
    });
    expect(elapsed()).toBe("1:05");
  });

  it("Cancel stops the recognition, the plugin gets cancelled, and the card goes", async () => {
    const view = setup();
    const pending = view.start();
    await settle();
    view.report({ stage: "reading", run: 1, runsPlanned: 5 });

    const cancel = [...card()!.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    expect(cancel).toBeDefined();
    act(() => cancel!.click());
    expect(card()).toBeNull();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(view.engine.cancelRecognition).toHaveBeenCalledOnce();
  });

  it("goes away when recognition fails", async () => {
    const view = setup();
    const pending = view.start();
    await settle();
    view.answer({ status: "failed", code: "invalidImage", message: "Not an image." });
    await settle();
    await expect(pending).resolves.toMatchObject({ status: "failed" });
    expect(card()).toBeNull();
  });

  it("is not modal: it takes no focus, traps nothing, and leaves the canvas usable", async () => {
    const view = setup();
    view.canvas.focus();
    void view.start();
    await settle();
    view.report({ stage: "reading", run: 1, runsPlanned: 5 });

    // Showing it moved no focus, and it is not announced as a dialog.
    expect(document.activeElement).toBe(view.canvas);
    expect(card()!.getAttribute("role")).not.toBe("dialog");
    expect(container!.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal]')).toBeNull();
    expect(document.body.querySelector("[inert]")).toBeNull();

    // The canvas still takes clicks and keys while it is shown.
    const onClick = vi.fn();
    view.canvas.addEventListener("click", onClick);
    view.canvas.click();
    expect(onClick).toHaveBeenCalledOnce();
    const key = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    view.canvas.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);

    // Its one control is an ordinary button in the tab order, and Escape on it is left alone.
    const cancel = card()!.querySelector("button")!;
    expect(cancel.tabIndex).toBe(0);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    cancel.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(card()).not.toBeNull();
  });

  it("announces only the stage politely, not the ticking clock", async () => {
    const view = setup();
    void view.start();
    await settle();
    const live = card()!.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute("aria-live")).toBe("polite");
    expect(live[0].getAttribute("role")).toBe("status");
    expect(live[0].contains(card()!.querySelector(".recognition-progress-elapsed"))).toBe(false);
    expect(card()!.getAttribute("aria-labelledby")).toBeTruthy();
  });
});

describe("recognition progress text", () => {
  it("never goes blank, whatever the engine reported", () => {
    expect(recognitionStageText({ stage: "checking" })).toBe("Checking the recognition engine…");
    expect(recognitionStageText({ stage: "starting" })).toBe("Starting the recognition engine…");
    expect(recognitionStageText({ stage: "reading" })).toBe("Reading the structure…");
    expect(recognitionStageText({ stage: "reading", reading: { run: 3, runsPlanned: 15 } })).toBe(
      "Reading the structure… (reading 3 of 15)"
    );
    expect(recognitionStageText({ stage: "validating" })).toBe("Checking the result…");
  });

  it("formats elapsed time as m:ss, and h:mm:ss past an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_999)).toBe("0:09");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});
