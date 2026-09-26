// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginProposalReviewItem } from "./panelBridge";
import { PatchReviewList } from "./PatchReviewTray";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function render(proposals: readonly PluginProposalReviewItem[]): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(PatchReviewList, {
        proposals,
        onAccept: vi.fn(),
        onReject: vi.fn()
      })
    )
  );
}

function recognitionProposal(overrides: Partial<PluginProposalReviewItem> = {}): PluginProposalReviewItem {
  return {
    id: "proposal-1",
    pluginId: "org.chemdraft.ocsr.molscribe",
    pluginName: "MolScribe OCSR",
    reason: "Recognized structure from the selected image.",
    warnings: [],
    recognition: {
      sourceImageRef: "data:image/png;base64,AAAA",
      proposedMolfile: "mock molfile",
      confidenceTier: "medium"
    },
    ...overrides
  };
}

function nonRecognitionProposal(overrides: Partial<PluginProposalReviewItem> = {}): PluginProposalReviewItem {
  return {
    id: "proposal-2",
    pluginId: "org.chemdraft.nmr.predictor",
    pluginName: "NMR Shift Predictor",
    reason: "Predicted shifts for the selected molecule.",
    warnings: [],
    ...overrides
  };
}

describe("PatchReviewList experimental recognition notice", () => {
  it("shows the experimental notice on a recognition proposal", () => {
    render([recognitionProposal()]);
    const item = document.querySelector('[data-proposal-id="proposal-1"]');
    const notice = item?.querySelector('[data-testid="recognition-experimental-note"]');
    expect(notice?.textContent).toContain("Experimental recognition");
    expect(notice?.textContent).toContain("check every atom and bond");
  });

  it("does not show the notice on a non-recognition proposal", () => {
    render([nonRecognitionProposal()]);
    const item = document.querySelector('[data-proposal-id="proposal-2"]');
    expect(item?.querySelector('[data-testid="recognition-experimental-note"]')).toBeNull();
  });

  it("does not add a click before Accept/Reject remain reachable", () => {
    const onAccept = vi.fn();
    render([recognitionProposal()]);
    act(() =>
      root!.render(
        createElement(PatchReviewList, {
          proposals: [recognitionProposal()],
          onAccept,
          onReject: vi.fn()
        })
      )
    );
    const acceptButton = document.querySelector<HTMLButtonElement>(
      '[data-proposal-id="proposal-1"] button'
    );
    act(() => acceptButton!.click());
    expect(onAccept).toHaveBeenCalledWith("proposal-1");
  });
});
