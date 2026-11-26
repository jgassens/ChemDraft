// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppHandoffForm, retryNotice } from "./AppHandoffForm";
import { AppHandoffDialogSnapshotSchema } from "./dialogTypes";
import confirm from "./__fixtures__/wire/dialog-confirm.json";
import confirmRetry from "./__fixtures__/wire/dialog-confirm-retry.json";

// Rust writes these snapshots (wire_tests.rs); the form must render them as sent.
const fixtures: Record<string, unknown> = { "dialog-confirm": confirm, "dialog-confirm-retry": confirmRetry };
const wire = (name: string): unknown => structuredClone(fixtures[name]);

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (name: string) => {
  const snapshot = AppHandoffDialogSnapshotSchema.parse(wire(name));
  act(() => root.render(<AppHandoffForm snapshot={snapshot} onReady={() => {}} onAction={() => {}} busy={false}
    platform="macos" />));
  return container.textContent ?? "";
};

it("states the bounded retry in plain words in the one build confirmation (API 0.1.29)", () => {
  const expected = "This confirmation covers up to 3 builds. If the build step reports “Joint twist left” as a " +
    "number other than 0, ChemDraft builds again without asking, using the plugin's next input: the same atoms " +
    "and bonds at slightly different positions. A build that fails, times out, or reports no such number ends " +
    "the run. Only the last build is kept.";
  expect(render("dialog-confirm-retry")).toContain(expected);
  expect(retryNotice({ attempts: 2, step: "build", label: "Twist", notEqual: -0.5 }))
    .toMatch(/^This confirmation covers up to 2 builds\. If the build step reports “Twist” as a number other than -0\.5,/u);
});

it("shows no retry text without a retry", () => {
  expect(render("dialog-confirm")).not.toContain("confirmation covers");
});

it("refuses retry notices outside the bounds", () => {
  const snapshot = wire("dialog-confirm-retry") as { retry: Record<string, unknown> };
  const parse = (retry: Record<string, unknown>) =>
    AppHandoffDialogSnapshotSchema.safeParse({ ...snapshot, retry: { ...snapshot.retry, ...retry } }).success;
  expect(parse({})).toBe(true);
  for (const invalid of [{ attempts: 1 }, { attempts: 4 }, { label: "a\nb" }, { label: "x".repeat(81) },
    { step: "../build" }, { notEqual: "0" }, { extra: true }]) {
    expect(parse(invalid)).toBe(false);
  }
});
