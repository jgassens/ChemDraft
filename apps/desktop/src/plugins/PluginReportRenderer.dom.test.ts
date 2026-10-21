// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PluginPanelReport } from "@chemdraft/plugin-api";
import { writeClipboardText } from "../clipboard";
import { PluginReportRenderer } from "./PluginReportRenderer";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn(async () => true) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("chemicalName report sections", () => {
  it("renders selectable name, kind, warnings, and copies exactly the name through the host", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PluginReportRenderer, { report: { title: "Name", sections: [{
        kind: "chemicalName", label: "Name", name: "(2R)-butan-2-ol", kindLabel: "Preferred IUPAC name",
        warnings: [{ code: "stereoLimitedEvidence", message: "Limited stereo evidence" }]
      }] } })));
      expect(container.querySelector("pre")?.style.userSelect).toBe("text");
      expect(container.textContent).toContain("Preferred IUPAC name");
      expect(container.textContent).toContain("Limited stereo evidence");
      await act(async () => container.querySelector("button")!.click());
      expect(writeClipboardText).toHaveBeenCalledWith("(2R)-butan-2-ol");
    } finally { act(() => root.unmount()); }
  });
  it("keeps unknown section kinds as readable text", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const report = { title: "Future", sections: [{ kind: "futureKind", body: "Retain this information" }] } as unknown as PluginPanelReport;
      await act(async () => root.render(createElement(PluginReportRenderer, { report })));
      expect(container.textContent).toContain("futureKind");
      expect(container.textContent).toContain("Retain this information");
    } finally { act(() => root.unmount()); }
  });
});
