// @vitest-environment jsdom

import { applyPatch, createEmptyDocument, type ChemDraftDocument, type CrossingOverride, type MoleculeObject } from "@chemdraft/chem-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_PANEL_RERUN_DELAY_MS,
  documentContentChanged,
  liveRerunCommandId,
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

const OWNERS: Record<string, string> = {
  [RERUN]: "org.test.nmrgame",
  "plugin.nmrgame.target": "org.test.nmrgame",
  "plugin.other.live": "org.test.other"
};
const ownerOf = (commandId: string): string | undefined => OWNERS[commandId];
// Documents a plugin command committed, by plugin id (MainWindow keys its write authors the same way).
const authors = new WeakMap<ChemDraftDocument, string>();
let scheduled: ReadonlySet<string> = new Set();

function Harness(props: { document: ChemDraftDocument; panels: readonly (OpenPluginPanel | undefined)[]; invoke: (id: string) => void }) {
  scheduled = useLivePanelRerun(props.document, liveRerunCommandIds(props.panels, ownerOf), props.invoke, {
    authorOf: document => authors.get(document),
    ownerOf
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
    const other = { ...panel({ rerunCommandId: "plugin.other.live" }), pluginId: "org.test.other" };
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

describe("useLivePanelRerun review fixes", () => {
  it("leaves a pending re-run's timer alone on a selection-only change", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    document = applyPatch(document, { op: "setSelection", objectIds: ["m0"] });
    render(document, [panel()], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS - 100);
    // Still 250 ms after the edit, not 250 ms after the selection change.
    expect(invoke).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("still restarts the debounce on another content edit", () => {
    const invoke = vi.fn();
    let document = baseDocument();
    render(document, [panel()], invoke);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(100);
    document = edit(document);
    render(document, [panel()], invoke);
    advance(LIVE_PANEL_RERUN_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    advance(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("counts a plugin's authorship for its commit only: undo back to its snapshot re-runs exactly once", () => {
    const invoke = vi.fn();
    const d0 = baseDocument();
    render(d0, [panel()], invoke);
    // The live plugin writes D1: no re-run.
    const d1 = edit(d0);
    authors.set(d1, "org.test.nmrgame");
    render(d1, [panel()], invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();
    // The user edits to D2: one re-run.
    const d2 = edit(d1);
    render(d2, [panel()], invoke);
    advance(1000);
    expect(invoke).toHaveBeenCalledTimes(1);
    // The user undoes to D1, the plugin-written snapshot itself: exactly one more re-run.
    render(d1, [panel()], invoke);
    advance(1000);
    expect(invoke).toHaveBeenCalledTimes(2);
    // Redo to D2 and undo again each re-run too.
    render(d2, [panel()], invoke);
    advance(1000);
    render(d1, [panel()], invoke);
    advance(1000);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("never schedules a live re-run for a command the panel's plugin does not own", () => {
    const invoke = vi.fn();
    const panels = [panel({ rerunCommandId: "edit.undo" }), panel({ rerunCommandId: "plugin.other.live" }),
      panel({ rerunCommandId: "document.closeTab" })];
    let document = baseDocument();
    render(document, panels, invoke);
    document = edit(document);
    render(document, panels, invoke);
    advance(1000);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("liveRerunCommandId", () => {
  it("names only the panel plugin's own registered, non-window command", () => {
    expect(liveRerunCommandId(panel(), ownerOf)).toBe(RERUN);
    expect(liveRerunCommandId(panel({ rerunCommandId: "plugin.other.live" }), ownerOf)).toBeUndefined();
    expect(liveRerunCommandId(panel({ rerunCommandId: "edit.undo" }), () => undefined)).toBeUndefined();
    // Even a window command that somehow resolved to the plugin is refused.
    expect(liveRerunCommandId(panel({ rerunCommandId: "document.closeTab" }), () => "org.test.nmrgame")).toBeUndefined();
    expect(liveRerunCommandId(panel({ liveRerun: undefined }), ownerOf)).toBeUndefined();
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

  it("is false for selection-only patches on a page with crossing overrides, and true when they change", () => {
    const ring = {
      ...molecule("x1"),
      atoms: [0, 1, 2, 3].map(index => ({ id: `x1a${index}`, element: "C", x: index * 10, y: index % 2 ? 10 : 0, formalCharge: 0 })),
      bonds: [
        { id: "x1b1", fromAtomId: "x1a0", toAtomId: "x1a2", order: "single" },
        { id: "x1b2", fromAtomId: "x1a1", toAtomId: "x1a3", order: "single" }
      ]
    } as unknown as MoleculeObject;
    const crossing: CrossingOverride = { bonds: [{ objectId: "x1", bondId: "x1b1" }, { objectId: "x1", bondId: "x1b2" }],
      front: { objectId: "x1", bondId: "x1b1" } };
    const withRing = applyPatch(baseDocument(), { op: "addObject", pageId: "p1", object: ring });
    const crossed = applyPatch(withRing, { op: "setCrossingOverride", pageId: "p1", crossing });
    const selected = applyPatch(crossed, { op: "setSelection", objectIds: ["m0"] });
    expect(selected.pages[0]!.crossings).toHaveLength(1);
    // chem-core re-parses the page shell, so the crossing is an equal copy, not the same object.
    expect(selected.pages[0]!.crossings![0]).not.toBe(crossed.pages[0]!.crossings![0]);
    expect(documentContentChanged(crossed, selected)).toBe(false);
    expect(documentContentChanged(selected, applyPatch(selected, { op: "setSelection", objectIds: [] }))).toBe(false);
    const flipped = applyPatch(selected, { op: "setCrossingOverride", pageId: "p1",
      crossing: { ...crossing, front: { objectId: "x1", bondId: "x1b2" } } });
    expect(documentContentChanged(selected, flipped)).toBe(true);
  });

  it("treats a different document as changed", () => {
    expect(documentContentChanged(undefined, baseDocument())).toBe(true);
    expect(documentContentChanged(baseDocument(), baseDocument())).toBe(true);
  });
});
