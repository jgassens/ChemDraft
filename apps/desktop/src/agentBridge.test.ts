// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { createPhase4Document } from "./documentWorkflow";
import {
  AGENT_BRIDGE_GLOBAL_NAME,
  agentBridgeRequestedFromLocation,
  createChemDraftAgentBridge,
  dispatchAgentPointerEvent,
  type AgentBridgeHost,
  type ChemDraftAgentBridge,
  type AgentPointTarget,
  type AgentPointerEventType,
  type AgentSnapshot
} from "./agentBridge";
import { MainWindow } from "./MainWindow";

function snapshot(): AgentSnapshot {
  const document = createPhase4Document("agent-bridge-test");
  const page = document.pages[0];
  return {
    bridgeVersion: 1,
    build: "test",
    runtime: { desktop: true, source: "test" },
    document,
    activeToolCommandId: "tool.select",
    selection: document.selection,
    viewport: { scale: 1 },
    page: {
      id: page.id,
      width: page.width,
      height: page.height,
      objectCount: page.objects.length
    },
    file: { dirty: false },
    objects: []
  };
}

function pageTarget(target: AgentPointTarget) {
  if (!("page" in target)) {
    throw new Error("Expected page target.");
  }
  return target.page;
}

function installPointerCaptureMocks() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
  window.requestAnimationFrame ??= frame;
  window.cancelAnimationFrame ??= (handle: number) => window.clearTimeout(handle);
  class TestResizeObserver {
    observe() {
      // jsdom layout is static in these bridge tests.
    }
    unobserve() {
      // jsdom layout is static in these bridge tests.
    }
    disconnect() {
      // jsdom layout is static in these bridge tests.
    }
  }
  window.ResizeObserver ??= TestResizeObserver;
  globalThis.ResizeObserver ??= TestResizeObserver;
  const prototype = window.HTMLElement.prototype as HTMLElement & {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
  };

  prototype.setPointerCapture ??= vi.fn();
  prototype.releasePointerCapture ??= vi.fn();
  prototype.hasPointerCapture ??= vi.fn(() => true);
}

async function waitForInstalledBridge(): Promise<ChemDraftAgentBridge> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bridge = window[AGENT_BRIDGE_GLOBAL_NAME];
    if (bridge) {
      return bridge;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  throw new Error("Expected ChemDraft agent bridge to be installed.");
}

afterEach(() => {
  delete window[AGENT_BRIDGE_GLOBAL_NAME];
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});

describe("agent bridge permission flags", () => {
  it("accepts explicit URL and local-storage gates", () => {
    expect(agentBridgeRequestedFromLocation("?agentBridge=1")).toMatchObject({
      enabled: true,
      source: "url"
    });
    expect(agentBridgeRequestedFromLocation("", "enabled")).toMatchObject({
      enabled: true,
      source: "local-storage"
    });
    expect(agentBridgeRequestedFromLocation("?agentBridge=0", "false")).toBeUndefined();
  });
});

describe("createChemDraftAgentBridge", () => {
  it("routes commands through the host and waits for an idle snapshot", async () => {
    const commands: string[] = [];
    const bridge = createChemDraftAgentBridge({
      snapshot,
      command: (commandId) => {
        commands.push(commandId);
      },
      resolvePoint: (target) => ({ page: pageTarget(target), client: pageTarget(target), target, source: "page" }),
      hitTest: (target) => ({
        point: { page: pageTarget(target), client: pageTarget(target), target, source: "page" }
      }),
      pointer: () => {
        throw new Error("pointer should not be called");
      },
      waitForIdle: async () => snapshot()
    });

    await expect(bridge.command("tool.bond")).resolves.toMatchObject({
      activeToolCommandId: "tool.select"
    });
    expect(commands).toEqual(["tool.bond"]);
  });

  it("interpolates page-coordinate drags into pointer events", async () => {
    const pointerCalls: Array<{ type: AgentPointerEventType; x: number; y: number; pointerId: number }> = [];
    const host: AgentBridgeHost = {
      snapshot,
      command: () => undefined,
      resolvePoint: (target) => ({ page: pageTarget(target), client: pageTarget(target), target, source: "page" }),
      hitTest: (target) => ({
        point: { page: pageTarget(target), client: pageTarget(target), target, source: "page" }
      }),
      pointer(type, target, options) {
        const point = pageTarget(target);
        pointerCalls.push({ type, x: point.x, y: point.y, pointerId: options?.pointerId ?? 1 });
        return {
          type,
          point: { page: point, client: point, target, source: "page" },
          targetLabel: "page",
          defaultPrevented: false
        };
      },
      waitForIdle: async () => snapshot()
    };
    const bridge = createChemDraftAgentBridge(host);

    await bridge.drag({
      from: { page: { x: 0, y: 0 } },
      to: { page: { x: 12, y: 6 } },
      pointerId: 7,
      steps: 3
    });

    expect(pointerCalls).toEqual([
      { type: "pointerdown", x: 0, y: 0, pointerId: 7 },
      { type: "pointermove", x: 4, y: 2, pointerId: 7 },
      { type: "pointermove", x: 8, y: 4, pointerId: 7 },
      { type: "pointermove", x: 12, y: 6, pointerId: 7 },
      { type: "pointerup", x: 12, y: 6, pointerId: 7 }
    ]);
  });
});

describe("MainWindow agent bridge integration", () => {
  it("drives a lasso over one atom into a native fragment selection and hands off to the select tool", async () => {
    installPointerCaptureMocks();
    window.history.replaceState({}, "", "/?agentBridge=1");
    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | undefined;

    await act(async () => {
      root = createRoot(container);
      root.render(createElement(MainWindow, {
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: true
      }));
    });

    try {
      const bridge = await waitForInstalledBridge();
      expect(bridge.snapshot()).toMatchObject({
        runtime: { source: "url" },
        activeToolCommandId: "tool.select"
      });

      await act(async () => {
        await bridge.command("tool.bond");
      });
      expect(bridge.snapshot().activeToolCommandId).toBe("tool.bond");

      await act(async () => {
        await bridge.click({ page: { x: 300, y: 300 } }, { pointerId: 21 });
      });
      const afterInsert = bridge.snapshot();
      const molecule = afterInsert!.document.pages[0].objects.find((object): object is MoleculeObject =>
        object.type === "molecule"
      );
      if (!molecule) {
        throw new Error("Expected bridge to insert a native molecule.");
      }
      // Lasso only the leftmost atom: a genuine fragment. (Enclosing every atom is
      // now a whole-molecule selection by contract, and the lasso hands off to the
      // select tool on completion so the transform box is immediately usable.)
      const firstAtom = [...molecule.atoms].sort((a, b) => a.x - b.x)[0];
      if (!firstAtom) {
        throw new Error("Expected inserted molecule atoms.");
      }
      const lassoPoints = [
        { x: firstAtom.x - 5, y: firstAtom.y - 5 },
        { x: firstAtom.x + 5, y: firstAtom.y - 5 },
        { x: firstAtom.x + 5, y: firstAtom.y + 5 },
        { x: firstAtom.x - 5, y: firstAtom.y + 5 },
        { x: firstAtom.x - 5, y: firstAtom.y - 5 }
      ];

      await act(async () => {
        await bridge.command("tool.lasso");
      });
      expect(bridge.snapshot().activeToolCommandId).toBe("tool.lasso");

      await act(async () => {
        bridge.pointerDown({ page: lassoPoints[0] }, { pointerId: 31, buttons: 1 });
        for (const point of lassoPoints.slice(1)) {
          bridge.pointerMove({ page: point }, { pointerId: 31, buttons: 1 });
        }
        bridge.pointerUp({ page: lassoPoints.at(-1) ?? lassoPoints[0] }, { pointerId: 31, buttons: 0 });
        await bridge.waitForIdle();
      });
      const afterLasso = bridge.snapshot();

      // A completed non-empty lasso hands off to the select tool so the
      // resize/rotate transform box is available on the captured fragment.
      expect(afterLasso.activeToolCommandId).toBe("tool.select");
      expect(afterLasso.selection.objectIds).toEqual([]);
      expect(afterLasso.selectedNativeMoleculePart).toEqual({
        objectId: molecule.id,
        kind: "parts",
        atomIds: [firstAtom.id],
        bondIds: molecule.bonds
          .filter((bond) => bond.fromAtomId === firstAtom.id || bond.toAtomId === firstAtom.id)
          .map((bond) => bond.id)
      });
    } finally {
      await act(async () => {
        root?.unmount();
      });
    }
  });
});

describe("dispatchAgentPointerEvent", () => {
  it("dispatches through the DOM and keeps the pointerdown target for move/up", () => {
    const page = document.createElement("div");
    page.className = "page";
    const object = document.createElement("div");
    object.dataset.objectId = "mol_agent";
    page.append(object);
    document.body.append(page);
    const activePointerTargets = new Map<number, EventTarget>();
    const received: string[] = [];
    object.addEventListener("pointerdown", () => received.push("object:down"));
    object.addEventListener("pointermove", () => received.push("object:move"));
    object.addEventListener("pointerup", () => received.push("object:up"));
    const elementFromPoint = vi.fn()
      .mockReturnValueOnce(object)
      .mockReturnValue(page);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint
    });

    const point = {
      page: { x: 10, y: 10 },
      client: { x: 10, y: 10 },
      target: { page: { x: 10, y: 10 } },
      source: "page" as const
    };

    expect(dispatchAgentPointerEvent({
      activePointerTargets,
      ownerDocument: document,
      pageElement: page,
      resolvedPoint: point,
      type: "pointerdown",
      options: { pointerId: 11 }
    })).toMatchObject({ targetLabel: "mol_agent" });
    dispatchAgentPointerEvent({
      activePointerTargets,
      ownerDocument: document,
      pageElement: page,
      resolvedPoint: point,
      type: "pointermove",
      options: { pointerId: 11 }
    });
    dispatchAgentPointerEvent({
      activePointerTargets,
      ownerDocument: document,
      pageElement: page,
      resolvedPoint: point,
      type: "pointerup",
      options: { pointerId: 11 }
    });

    expect(received).toEqual(["object:down", "object:move", "object:up"]);
    expect(activePointerTargets.size).toBe(0);
  });
});
