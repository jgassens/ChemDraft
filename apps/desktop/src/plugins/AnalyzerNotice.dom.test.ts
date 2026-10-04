// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyzerNoticeBanner, analyzerNoticeDurationMs, type AnalyzerNotice } from "./AnalyzerNotice";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
});

function render(notice: AnalyzerNotice | undefined, onDismiss: (id: number) => void): void {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(createElement(AnalyzerNoticeBanner, { notice, onDismiss })));
}

const refusal: AnalyzerNotice = {
  id: 1,
  pluginId: "org.chemdraft.mass",
  pluginName: "Mass / m/z Analyzer",
  message: "Select exactly one molecule."
};

describe("AnalyzerNoticeBanner", () => {
  it("names the analyzer and its reason as an alert", () => {
    render(refusal, vi.fn());
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.getAttribute("data-analyzer-notice")).toBe("org.chemdraft.mass");
    expect(alert?.textContent).toContain("Mass / m/z Analyzer");
    expect(alert?.textContent).toContain("Select exactly one molecule.");
  });

  it("renders nothing without a notice", () => {
    render(undefined, vi.fn());
    expect(container!.innerHTML).toBe("");
  });

  it("dismisses by its close button", () => {
    const onDismiss = vi.fn();
    render(refusal, onDismiss);
    act(() => container!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("dismisses itself after its duration, and a repeat refusal restarts the timer", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const duration = analyzerNoticeDurationMs(refusal.message);
    render(refusal, onDismiss);

    act(() => vi.advanceTimersByTime(duration - 1));
    expect(onDismiss).not.toHaveBeenCalled();

    // The same refusal again (a new id) starts over rather than inheriting the old deadline.
    render({ ...refusal, id: 2 }, onDismiss);
    act(() => vi.advanceTimersByTime(duration - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("does not restart the timer when the parent merely re-renders", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const duration = analyzerNoticeDurationMs(refusal.message);
    render(refusal, onDismiss);
    act(() => vi.advanceTimersByTime(duration - 1));
    render({ ...refusal }, () => onDismiss(-1)); // fresh object and callback, same notice
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(-1);
  });
});

describe("analyzerNoticeDurationMs", () => {
  it("gives every message a finite, readable duration that does not shrink as the message grows", () => {
    const short = analyzerNoticeDurationMs("No.");
    const long = analyzerNoticeDurationMs("Select one molecule before analyzing its mass. ".repeat(6));
    expect(Number.isFinite(short)).toBe(true);
    expect(short).toBeGreaterThanOrEqual(3000);
    expect(long).toBeGreaterThanOrEqual(short);
    expect(Number.isFinite(long)).toBe(true);
  });
});
