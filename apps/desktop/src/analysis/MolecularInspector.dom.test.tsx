// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AnalysisReport } from "@chemdraft/analysis-core";

import { MolecularInspector } from "./MolecularInspector";

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

function inspector(overrides: Partial<React.ComponentProps<typeof MolecularInspector>> = {}) {
  return render(
    <MolecularInspector
      report={REPORT}
      onChangeInterpretation={() => {}}
      onCopy={() => {}}
      onClose={() => {}}
      {...overrides}
    />
  );
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

describe("MolecularInspector", () => {
  it("lists one category per section, named without the disclosure and counted", () => {
    const view = inspector();
    const labels = [...view.querySelectorAll(".molecular-inspector-category-label")].map((e) => e.textContent);

    expect(labels).toEqual(["All analyses", "Composition", "Descriptors", "Isotope envelope"]);
    // The count makes an empty category obviously empty rather than looking merely collapsed.
    expect(categoryButton(view, "Descriptors").textContent).toContain("1");
    // The §2 disclosure travels with the category rather than being dropped from the left list.
    expect(categoryButton(view, "Descriptors").textContent).toContain("convention-dependent");
    // A computed detail is shown but is not part of the name.
    expect(categoryButton(view, "Isotope envelope").textContent).toContain("2 peaks");
  });

  it("shows everything until a category is picked, then only that category", () => {
    const view = inspector();
    const viewport = () => view.querySelector(".molecular-inspector-viewport")!.textContent ?? "";

    expect(viewport()).toContain("C9H8O4");
    expect(viewport()).toContain("63.60 Å²");

    act(() => {
      categoryButton(view, "Descriptors").click();
    });

    expect(viewport()).toContain("63.60 Å²");
    expect(viewport()).not.toContain("C9H8O4");
  });

  it("copies only what is on screen, and always says which build produced it", () => {
    // The guarantee the whole window rests on: the viewport and the clipboard take the same narrowed
    // report, so a pasted fragment cannot disagree with what was visible.
    const onCopy = vi.fn();
    const view = inspector({ onCopy });

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
    const view = inspector({ onCopy });
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

  it("floats free of the drawing viewport, positioned rather than laid out", () => {
    const view = inspector({ initialPosition: { x: 240, y: 160 } });
    const frame = view.querySelector<HTMLElement>(".molecular-inspector")!;
    expect(frame.style.left).toBe("240px");
    expect(frame.style.top).toBe("160px");
    expect(frame.getAttribute("role")).toBe("dialog");
  });

  it("drops a selection whose category a recomputation removed, and keeps one it did not", () => {
    const view = inspector();
    act(() => {
      categoryButton(view, "Descriptors").click();
    });
    expect(categoryButton(view, "Descriptors").className).toContain("is-selected");

    // Re-render with a report that no longer has Descriptors: the reader should land back on
    // everything rather than on a blank viewport for a category that is gone.
    act(() => {
      root!.render(
        <MolecularInspector
          report={{ ...REPORT, sections: [REPORT.sections[0]!] }}
          onChangeInterpretation={() => {}}
          onCopy={() => {}}
          onClose={() => {}}
        />
      );
    });

    expect(categoryButton(view, "All analyses").className).toContain("is-selected");
    expect(view.querySelector(".molecular-inspector-viewport")!.textContent).toContain("C9H8O4");
  });
});
