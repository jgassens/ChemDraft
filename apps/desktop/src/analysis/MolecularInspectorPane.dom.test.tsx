// @vitest-environment jsdom

/**
 * The Molecular Inspector's contents. The window around them is the toolset machinery's — same native
 * frame and drag as any other palette — so what is worth testing here is the pane's own behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AnalysisReport } from "@chemdraft/analysis-core";

import { MolecularInspectorPane } from "./MolecularInspectorPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPORT: AnalysisReport = {
  title: "Molecular properties",
  interpretations: [{ id: "source", label: "as drawn", active: true, changesIdentity: false, ledger: [] }],
  sections: [
    {
      kind: "keyValue",
      title: "Composition",
      rows: [
        { label: "Formula", value: "C9H8O4" },
        { label: "Average mass", value: "180.159 g/mol", note: "convention-dependent — see Conventions" }
      ]
    },
    {
      kind: "keyValue",
      title: "Descriptors — convention-dependent — see Conventions",
      rows: [{ label: "TPSA", value: "63.60 Å²" }]
    },
    {
      kind: "table",
      title: "Isotope envelope (2 peaks, 99.98% of the distribution)",
      columns: ["Mass (Da)", "Intensity (%)"],
      rows: [
        ["180.04226", "100.00"],
        ["181.04561", "9.87"]
      ]
    }
  ],
  engineSummary: "rdkit-minimallib-wasm 2026.03.3 (sha256:48b725a2)",
  fingerprint: "fnv1a64:0123456789abcdef"
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function categoryButton(view: HTMLDivElement, label: string): HTMLButtonElement {
  const found = [...view.querySelectorAll<HTMLButtonElement>(".molecular-inspector-categories button")].find(
    (button) => button.textContent?.startsWith(label)
  );
  if (!found) throw new Error(`no "${label}" category`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("MolecularInspectorPane", () => {
  it("says what to do when nothing has been analysed yet", () => {
    // The palette can be opened before anything is selected; an empty frame would look broken.
    const view = render(<MolecularInspectorPane />);
    expect(view.textContent).toContain("Select a molecule");
  });

  it("lists one category per section, named without the disclosure and counted", () => {
    const view = render(<MolecularInspectorPane report={REPORT} />);
    const labels = [...view.querySelectorAll(".molecular-inspector-category-label")].map((e) => e.textContent);

    expect(labels).toEqual(["All analyses", "Composition", "Descriptors", "Isotope envelope"]);
    expect(categoryButton(view, "Descriptors").textContent).toContain("convention-dependent");
    // A computed detail is shown but is not part of the name — otherwise the id would change with
    // the peak count and no selection could survive a recomputation.
    expect(categoryButton(view, "Isotope envelope").textContent).toContain("2 peaks");
  });

  it("shows everything until a category is picked, then only that category", () => {
    const view = render(<MolecularInspectorPane report={REPORT} />);
    const viewport = () => view.querySelector(".molecular-inspector-viewport")!.textContent ?? "";

    expect(viewport()).toContain("C9H8O4");
    act(() => {
      categoryButton(view, "Descriptors").click();
    });
    expect(viewport()).toContain("63.60 Å²");
    expect(viewport()).not.toContain("C9H8O4");
  });

  it("copies only what is on screen, and always says which build produced it", () => {
    const onCopy = vi.fn();
    const view = render(<MolecularInspectorPane report={REPORT} onCopy={onCopy} />);

    act(() => {
      categoryButton(view, "Descriptors").click();
    });
    act(() => {
      [...view.querySelectorAll("button")].find((b) => b.textContent === "Copy")!.click();
    });

    const copied = onCopy.mock.calls[0]![0] as string;
    expect(copied).toContain("63.60 Å²");
    expect(copied).not.toContain("C9H8O4");
    expect(copied).toContain("Engine: rdkit-minimallib-wasm");
    expect(copied).toMatch(/Run fingerprint: fnv1a64:/);
  });

  it("copies Markdown when asked, scoped the same way", () => {
    const onCopy = vi.fn();
    const view = render(<MolecularInspectorPane report={REPORT} onCopy={onCopy} />);
    act(() => {
      categoryButton(view, "Isotope envelope").click();
    });
    act(() => {
      [...view.querySelectorAll("button")].find((b) => b.textContent === "Copy as Markdown")!.click();
    });

    const copied = onCopy.mock.calls[0]![0] as string;
    expect(copied).toContain("| Mass (Da) |");
    expect(copied).not.toContain("## Composition");
  });

  it("drops a selection whose category a recomputation removed", () => {
    const view = render(<MolecularInspectorPane report={REPORT} />);
    act(() => {
      categoryButton(view, "Descriptors").click();
    });
    expect(categoryButton(view, "Descriptors").className).toContain("is-selected");

    act(() => {
      root!.render(<MolecularInspectorPane report={{ ...REPORT, sections: [REPORT.sections[0]!] }} />);
    });

    expect(categoryButton(view, "All analyses").className).toContain("is-selected");
    expect(view.querySelector(".molecular-inspector-viewport")!.textContent).toContain("C9H8O4");
  });
});
