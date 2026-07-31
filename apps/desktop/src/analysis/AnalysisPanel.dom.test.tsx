// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AnalysisReport } from "@chemdraft/analysis-core";

import { AnalysisPanel } from "./AnalysisPanel";
import { toPanelReport } from "./analysisPanelReport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SALT_REPORT: AnalysisReport = {
  title: "Molecular properties",
  interpretations: [
    { id: "source", label: "as drawn", active: true, changesIdentity: false, ledger: [] },
    {
      id: "largest-organic-fragment",
      label: "largest organic fragment · Na removed",
      active: false,
      changesIdentity: true,
      ledger: ["largest-organic-fragment: removed Na; kept C7H5O2"]
    }
  ],
  sections: [
    {
      kind: "keyValue",
      title: "Composition",
      rows: [
        { label: "Formula", value: "C7H5NaO2" },
        { label: "Crippen logP", value: "0.05", note: "calibrated method — see Provenance" }
      ]
    },
    {
      kind: "table",
      title: "Not computed",
      columns: ["Property", "Status", "Reason"],
      rows: [["Crippen logP", "unsupported", "Crippen logP has no parameters for Na"]]
    }
  ],
  engineSummary: "rdkit-minimallib-wasm 2026.03.3 (sha256:5b1bc112)",
  fingerprint: "fnv1a64:0123456789abcdef"
};

const CONVENTIONS_SECTION: AnalysisReport["sections"][number] = {
  kind: "conventions",
  title: "Conventions",
  groups: [
    {
      appliesTo: ["Topological polar surface area (TPSA)"],
      conventions: ["Ertl 2000 fragment contributions", "sulfur and phosphorus INCLUDED (vendor patch #6)"]
    },
    { appliesTo: ["[M+H]⁺", "[M+Na]⁺"], conventions: ["m/z divides the ion mass by the magnitude of its charge"] }
  ]
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("AnalysisPanel", () => {
  it("shows which interpretation the numbers describe", () => {
    // §1: "The active interpretation is inspectable and overridable in the UI, per analysis." A number
    // whose interpretation is invisible is a transformation the user cannot catch.
    const view = render(
      <AnalysisPanel report={SALT_REPORT} onChangeInterpretation={() => {}} onCopy={() => {}} onClose={() => {}} />
    );
    expect(view.textContent).toContain("Computed on:");
    expect(view.textContent).toContain("as drawn");
  });

  it("offers the alternative interpretation and reports the change", () => {
    const onChangeInterpretation = vi.fn();
    const view = render(
      <AnalysisPanel report={SALT_REPORT} onChangeInterpretation={onChangeInterpretation} onCopy={() => {}} onClose={() => {}} />
    );

    const select = view.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "as drawn",
      "largest organic fragment · Na removed"
    ]);

    act(() => {
      select.value = "largest-organic-fragment";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChangeInterpretation).toHaveBeenCalledWith("largest-organic-fragment");
  });

  it('maps "as drawn" back to no override rather than to a literal interpretation id', () => {
    const onChangeInterpretation = vi.fn();
    const derived: AnalysisReport = {
      ...SALT_REPORT,
      interpretations: SALT_REPORT.interpretations.map((entry) => ({ ...entry, active: entry.id !== "source" }))
    };
    const view = render(
      <AnalysisPanel report={derived} onChangeInterpretation={onChangeInterpretation} onCopy={() => {}} onClose={() => {}} />
    );

    const select = view.querySelector("select")!;
    act(() => {
      select.value = "source";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChangeInterpretation).toHaveBeenCalledWith(undefined);
  });

  it("hides the change control when there is nothing to change to", () => {
    const single: AnalysisReport = { ...SALT_REPORT, interpretations: [SALT_REPORT.interpretations[0]!] };
    const view = render(
      <AnalysisPanel report={single} onChangeInterpretation={() => {}} onCopy={() => {}} onClose={() => {}} />
    );
    expect(view.querySelector("select")).toBeNull();
  });

  it("shows the ledger for a derived interpretation and flags an identity change", () => {
    const derived: AnalysisReport = {
      ...SALT_REPORT,
      interpretations: SALT_REPORT.interpretations.map((entry) => ({ ...entry, active: entry.id !== "source" }))
    };
    const view = render(
      <AnalysisPanel report={derived} onChangeInterpretation={() => {}} onCopy={() => {}} onClose={() => {}} />
    );
    expect(view.textContent).toContain("removed Na; kept C7H5O2");
    expect(view.textContent).toContain("identity changed");
  });

  it("renders the report body through the shared renderer, including declines", () => {
    const view = render(
      <AnalysisPanel report={SALT_REPORT} onChangeInterpretation={() => {}} onCopy={() => {}} onClose={() => {}} />
    );
    expect(view.querySelector(".plugin-report")).not.toBeNull();
    expect(view.textContent).toContain("C7H5NaO2");
    // The decline is on screen, not omitted.
    expect(view.textContent).toContain("Not computed");
    expect(view.textContent).toContain("no parameters for Na");
  });

  it("copies the text rendering, then the markdown one", () => {
    const onCopy = vi.fn();
    const view = render(
      <AnalysisPanel report={SALT_REPORT} onChangeInterpretation={() => {}} onCopy={onCopy} onClose={() => {}} />
    );
    const [copyText, copyMarkdown] = [...view.querySelectorAll("button")];

    act(() => copyText!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCopy.mock.calls[0]![0]).toContain("Molecular properties");
    expect(onCopy.mock.calls[0]![0]).toContain("Run fingerprint: fnv1a64:0123456789abcdef");
    expect(copyText!.textContent).toBe("Copied");

    act(() => copyMarkdown!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCopy.mock.calls[1]![0]).toContain("# Molecular properties");
    expect(onCopy.mock.calls[1]![0]).toContain("| Formula | C7H5NaO2 |");
  });

  it("closes", () => {
    const onClose = vi.fn();
    const view = render(
      <AnalysisPanel report={SALT_REPORT} onChangeInterpretation={() => {}} onCopy={() => {}} onClose={onClose} />
    );
    const close = view.querySelector('button[aria-label="Close molecular properties"]')!;
    act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClose).toHaveBeenCalled();
  });

  it("disables the change control while a recompute is in flight", () => {
    const view = render(
      <AnalysisPanel report={SALT_REPORT} busy onChangeInterpretation={() => {}} onCopy={() => {}} onClose={() => {}} />
    );
    expect(view.querySelector("select")!.disabled).toBe(true);
    expect(view.textContent).toContain("Recomputing");
  });
});

describe("toPanelReport", () => {
  it("keeps a convention note attached to the value it qualifies", () => {
    // The renderer's keyValue row has no third slot, so the note folds into the value. Dropping it
    // would take the disclosure off the number — the one thing §2 asks the UI not to do.
    const panel = toPanelReport(SALT_REPORT);
    const composition = panel.sections.find((section) => section.title === "Composition")!;
    expect(composition.kind === "keyValue" && composition.rows[1]).toEqual({
      label: "Crippen logP",
      value: "0.05 · calibrated method — see Provenance"
    });
  });

  it("carries tables across unchanged", () => {
    const panel = toPanelReport(SALT_REPORT);
    const declined = panel.sections.find((section) => section.title === "Not computed")!;
    expect(declined.kind).toBe("table");
    expect(declined.kind === "table" && declined.columns).toEqual(["Property", "Status", "Reason"]);
  });

  it("flattens a conventions section to text the shared renderer can draw", () => {
    // `PluginPanelSection` is the versioned plugin SDK surface and no plugin asked for this kind, so
    // the flattening happens here rather than widening that schema. Line breaks survive because
    // `.analysis-panel` styles the renderer's text sections `white-space: pre-line`.
    const panel = toPanelReport({ ...SALT_REPORT, sections: [...SALT_REPORT.sections, CONVENTIONS_SECTION] });
    const conventions = panel.sections.find((section) => section.title === "Conventions")!;

    expect(conventions.kind).toBe("text");
    const body = conventions.kind === "text" ? conventions.body : "";
    expect(body).toContain("Topological polar surface area (TPSA)\n  • Ertl 2000 fragment contributions");
    expect(body).toContain("sulfur and phosphorus INCLUDED (vendor patch #6)");
    // A shared set names every method it applies to rather than being repeated once per method.
    expect(body).toContain("[M+H]⁺, [M+Na]⁺");
  });

  it("puts the conventions in the DOM, which is where the disclosure was missing", () => {
    // The end of the chain this whole change exists for: the panel said "convention-dependent — see
    // Conventions", and until now there was nothing under that heading to see.
    const view = render(
      <AnalysisPanel
        report={{ ...SALT_REPORT, sections: [...SALT_REPORT.sections, CONVENTIONS_SECTION] }}
        onChangeInterpretation={() => {}}
        onCopy={() => {}}
        onClose={() => {}}
      />
    );

    expect(view.textContent).toContain("Conventions");
    expect(view.textContent).toContain("sulfur and phosphorus INCLUDED (vendor patch #6)");
  });
});
