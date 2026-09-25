// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingProposalsBadge } from "./PatchReviewTray";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function render(props: { count: number; windowOpen: boolean; onReview: () => void }): void {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(createElement(PendingProposalsBadge, props)));
}

describe("PendingProposalsBadge", () => {
  it("offers a way back to proposals after their window is closed, and reopens it", () => {
    const onReview = vi.fn();
    render({ count: 2, windowOpen: true, onReview });
    expect(container!.querySelector("button")).toBeNull();

    // The user closes the Plugin Proposals window with two proposals still pending.
    render({ count: 2, windowOpen: false, onReview });
    const badge = container!.querySelector<HTMLButtonElement>("[data-pending-proposals-badge] button");
    expect(badge?.textContent).toBe("2 plugin proposals");
    act(() => badge!.click());
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("is absent when nothing is pending", () => {
    render({ count: 0, windowOpen: false, onReview: vi.fn() });
    expect(container!.innerHTML).toBe("");
  });

  it("uses the singular for one proposal", () => {
    render({ count: 1, windowOpen: false, onReview: vi.fn() });
    expect(container!.textContent).toBe("1 plugin proposal");
  });
});
