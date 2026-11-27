// @vitest-environment jsdom

import { applyPatch, createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_PANEL_RERUN_DELAY_MS,
  documentContentChanged,
  liveRerunCommandIds,
  pluginPanelOutOfDate,
  useLivePanelRerun
} from "./livePanelRerun";
import type { OpenPluginPanel } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RERUN = "plugin.nmrgame.predict";

function molecule(id: string, x = 0): MoleculeObject {
  return {
    id, type: "molecule", structureFormat: "smiles", structure: "C", x, y: 0, width: 14, height: 1,
    atoms: [{ id: `${id}a1`, element: "C", x, y: 0, formalCharge: 0 }],
    bonds: []
  } as unknown as MoleculeObject;
}

function baseDocument(): ChemDraftDocument {
  return applyPatch(createEmptyDocument({ id: "doc1", pageId: "p1" }), { op: "addObject", pageId: "p1", object: molecule("m0") });
}

let editCount = 0;
function edit(document: ChemDraftDocument): ChemDraftDocument {
  editCount += 1;
  return applyPatch(document, { op: "addObject", pageId: "p1", object: molecule(`e${editCount}`, editCount * 20) });
}

function panel(report: Partial<OpenPluginPanel["report"]> = {}): OpenPluginPanel {
  return {
    pluginId: "org.test.nmrgame",
    panelId: "panel.nmrgame.live",
    title: "Live NMR",
    report: { title: "Live NMR", sections: [], rerunCommandId: RERUN, liveRerun: true, ...report },
    commandId: RERUN,
    openedAt: "2026-11-27T00:00:00.000Z"
  };
}

const OWNERS: Record<string, string> = { [RERUN]: "org.test.nmrgame", "plugin.other.live": "org.test.other" };
// Documents a plugin command committed, by plugin id (MainWindow keys its write authors the same way).
const authors = new WeakMap<ChemDraftDocument, string>();
let scheduled: ReadonlySet<string> = new Set();

function Harness(props: { document: ChemDraftDocument; panels: readonly (OpenPluginPanel | undefined)[]; invoke: (id: string) => void }) {
  scheduled = useLivePanelRerun(props.document, liveRerunCommandIds(props.panels), props.invoke, {
    authorOf: document => authors.get(document),
    ownerOf: commandId => OWNERS[commandId]
  });
  return null;
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function render(document: ChemDraftDocument, panels: readonly (OpenPluginPanel | undefined)[], invoke: (id: string) => void) {
  act(() => {
    root!.render(createElement(Harness, { document, panels, invoke }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

describe("useLivePanelRerun", () => {
  it("turns 5 edits within 100 ms into exactly one re-run, 250 ms after the last edit", () => {
    const invoke = vi.fn();
    const panels = [panel()];
    let document = baseDocument();
    render(document, panels, invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled(); // Opening a live panel is not an edit.

    for (let index = 0; index < 5; index += 1) {
      document = edit(document);
      render(document, panels, invoke);
      if (index < 4) advance(25);
    }
    advance(LIVE_PANEL_RERUN_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    advance(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(RERUN);
    advance(5000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not re-run after the panel closes, even with an edit still pending", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    render(document, [undefined], invoke); // closed
    advance(1000);
    document = edit(document);
    render(document, [], invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not re-run for a report without liveRerun, or once such a report replaces a live one", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel({ liveRerun: undefined })], invoke);
    document = edit(document);
    render(document, [panel({ liveRerun: undefined })], invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();

    render(document, [panel()], invoke);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    render(document, [panel({ liveRerun: false })], invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores selection-only changes, and the plugin's own report update does not cancel or add a run", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    document = applyPatch(document, { op: "setSelection", objectIds: ["m0"] });
    render(document, [panel()], invoke);
    document = applyPatch(document, { op: "setSelection", objectIds: [] });
    render(document, [panel()], invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();

    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    render(document, [panel({ title: "Running…" })], invoke); // the plugin's own pending report
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
    render(document, [panel({ title: "Result" })], invoke); // its result report
    advance(1000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-runs detached live panels too, once per distinct command", () => {
    const invoke = vi.fn();
    const other = { ...panel({ rerunCommandId: "plugin.nmrgame.target" }), panelId: "panel.nmrgame.target" };
    let document = baseDocument();
    const panels = [panel(), panel(), other];
    render(document, panels, invoke);
    document = edit(document);
    render(document, panels, invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke.mock.calls).toEqual([[RERUN], ["plugin.nmrgame.target"]]);
  });

  it("reports a re-run as scheduled from the render that sees the edit until it is invoked", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    expect([...scheduled]).toEqual([]);
    document = edit(document);
    render(document, [panel()], invoke);
    expect([...scheduled]).toEqual([RERUN]);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect([...scheduled]).toEqual([]);
  });

  it("does not re-run a live command for a document its own plugin committed, but does for others' and the user's", () => {
    const invoke = vi.fn();
    const other = panel({ rerunCommandId: "plugin.other.live" });
    let document = baseDocument();
    render(document, [panel(), other], invoke);

    // The plugin's own document.write during its run: its live command stays quiet, the other
    // plugin's live command still re-runs.
    document = edit(document);
    authors.set(document, "org.test.nmrgame");
    render(document, [panel(), other], invoke);
    expect([...scheduled]).toEqual(["plugin.other.live"]);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke.mock.calls).toEqual([["plugin.other.live"]]);

    // Another plugin's write re-runs this plugin's live command (and not the writer's).
    invoke.mockClear();
    document = edit(document);
    authors.set(document, "org.test.other");
    render(document, [panel(), other], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke.mock.calls).toEqual([[RERUN]]);

    // A user edit re-runs both.
    invoke.mockClear();
    document = edit(document);
    render(document, [panel(), other], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke.mock.calls).toEqual([[RERUN], ["plugin.other.live"]]);

    // Nothing more: the plugin's own write never re-arms itself into a loop.
    invoke.mockClear();
    document = edit(document);
    authors.set(document, "org.test.nmrgame");
    render(document, [panel()], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS * 4);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps a user edit's pending re-run when the plugin's own write lands before it fires", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    document = edit(document);
    authors.set(document, "org.test.nmrgame");
    render(document, [panel()], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("pluginPanelOutOfDate", () => {
  it("flags a non-live panel by its source fingerprint only", () => {
    expect(pluginPanelOutOfDate({ sourceStale: true, live: false, lastRunFailed: false, rerunPending: true })).toBe(true);
    expect(pluginPanelOutOfDate({ sourceStale: false, live: false, lastRunFailed: true, rerunPending: false })).toBe(false);
  });

  it("flags a live panel whose last re-run failed, or whose result is stale with no re-run pending", () => {
    expect(pluginPanelOutOfDate({ sourceStale: false, live: true, lastRunFailed: true, rerunPending: false })).toBe(true);
    expect(pluginPanelOutOfDate({ sourceStale: true, live: true, lastRunFailed: false, rerunPending: false })).toBe(true);
    expect(pluginPanelOutOfDate({ sourceStale: false, live: true, lastRunFailed: false, rerunPending: false })).toBe(false);
  });

  it("holds the banner back only while a live re-run is pending or running", () => {
    expect(pluginPanelOutOfDate({ sourceStale: true, live: true, lastRunFailed: true, rerunPending: true })).toBe(false);
  });
});

describe("documentContentChanged", () => {
  it("is false for selection-only patches and true for edits", () => {
    const document = baseDocument();
    const selected = applyPatch(document, { op: "setSelection", objectIds: ["m0"] });
    expect(selected).not.toBe(document);
    expect(documentContentChanged(document, selected)).toBe(false);
    expect(documentContentChanged(document, document)).toBe(false);
    expect(documentContentChanged(selected, edit(selected))).toBe(true);
    expect(documentContentChanged(document, applyPatch(document, { op: "removeObject", objectId: "m0" }))).toBe(true);
  });

  it("treats a different document as changed", () => {
    expect(documentContentChanged(undefined, baseDocument())).toBe(true);
    expect(documentContentChanged(baseDocument(), baseDocument())).toBe(true);
  });
});
