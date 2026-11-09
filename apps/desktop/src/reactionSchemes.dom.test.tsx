// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, type ChemDraftDocument } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { documentReactionSummary } from "@chemdraft/document-workflow-core";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import {
  createSelectionClipboardPayload, duplicateSelectedDocumentObjects, pasteSelectionClipboardPayload
} from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Authored synthetic two-step drawing with a shared intermediate, isotope and charge.
const molecule = (id: string, x: number, y = 60) => `<fragment id="${id}">
  <n id="${id}1" p="${x} ${y}" Element="6" Isotope="13"/>
  <n id="${id}2" p="${x + 15} ${y}" Element="8" Charge="-1"/>
  <b id="${id}3" B="${id}1" E="${id}2" Order="1"/>
</fragment>`;
const source = (arrowKind: string) => `<CDXML><page id="1"><scheme id="900">
  <step id="901" ReactionStepReactants="10" ReactionStepProducts="20" ReactionStepArrows="50"
    ReactionStepObjectsAboveArrow="40" ReactionStepObjectsBelowArrow="70" ReactionStepPlusses="90"/>
  <step id="902" ReactionStepReactants="20" ReactionStepProducts="30" ReactionStepArrows="60"
    ReactionStepObjectsBelowArrow="80" ReactionStepPlusses="100"/>
  </scheme>${molecule("10", 10)}${molecule("20", 110)}${molecule("30", 210)}${molecule("40", 60, 20)}
  <graphic id="50" GraphicType="Line" ArrowType="${arrowKind}" BoundingBox="95 60 45 60"/>
  <graphic id="60" GraphicType="Line" ArrowType="FullHead" BoundingBox="195 60 145 60"/>
  <t id="70" p="45 100"><s>25 °C, 2 h</s></t><t id="80" p="145 100"><s>heat</s></t>
  <t id="90" p="30 60"><s>+</s></t><t id="100" p="130 60"><s>+</s></t>
</page></CDXML>`;
const stripSchemes = (xml: string) => xml.replace(/<scheme\b[^>]*>[\s\S]*?<\/scheme>/g, "");
function imported(xml: string): ChemDraftDocument {
  const opened = openChemDraftPayload(xml);
  const expectedWarnings = ["cdxml.external_subset_imported", "cdxml.structure_string_not_derived"];
  expect(opened.warnings.filter(warning => !expectedWarnings.includes(warning.code))).toEqual([]);
  expect(opened.document).toBeDefined();
  return opened.document!;
}
function importPair(arrowKind = "FullHead") {
  const xml = source(arrowKind);
  return { scheme: imported(xml), stripped: imported(stripSchemes(xml)) };
}

describe("reaction schemes preserve the visible drawing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderKey = 0;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function drawing(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      key: ++renderKey, initialDocument: document, initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden", nativePalette: true, initialCrosshairsVisible: false, initialRulersVisible: false
    })));
    const visuals = [...container.querySelectorAll(
      "[data-native-molecule-overlay-visual], [data-page-svg-object-visual]"
    )];
    expect(container.querySelector('[id^="fallback-box-"], [id^="fallback-label-"]')).toBeNull();
    expect(visuals.some(element => element.getAttribute("data-object-type") === "reaction")).toBe(false);
    expect(container.querySelectorAll("[data-native-molecule-overlay-visual]")).toHaveLength(4);
    expect(container.querySelectorAll('[data-page-svg-object-visual][data-object-type="graphic"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-page-svg-object-visual][data-object-type="text"]')).toHaveLength(4);
    return visuals.map(element => element.outerHTML);
  }

  it.each(["FullHead", "Equilibrium"])("draws identical canvas molecules, arrows, pluses and text for %s", async arrowKind => {
    const { scheme, stripped } = importPair(arrowKind);
    const visibleState = (document: ChemDraftDocument) => document.pages[0].objects
      .filter(object => object.type !== "reaction").map(({ compatibility: _sourceMetadata, ...object }) => object);
    expect(visibleState(scheme)).toEqual(visibleState(stripped));
    expect(documentReactionSummary(scheme)).toHaveLength(2);
    expect(planPageSvgRender(scheme.pages[0])).toEqual(planPageSvgRender(stripped.pages[0]));
    expect(await drawing(scheme)).toEqual(await drawing(stripped));
  });

  it.each(["FullHead", "Equilibrium"])("exports identical SVG element counts and geometry for %s", arrowKind => {
    const { scheme, stripped } = importPair(arrowKind);
    const exported = exportDocumentToSvg(scheme);
    expect(exported.warnings).toEqual([]);
    expect(exported).toEqual(exportDocumentToSvg(stripped));
    const svg = new DOMParser().parseFromString(exported.contents, "image/svg+xml");
    expect(svg.querySelector('[id^="fallback-box-"], [data-object-type="reaction"]')).toBeNull();
    const count = (type: string) => new Set([...svg.querySelectorAll(`[data-object-type="${type}"]`)]
      .map(element => element.getAttribute("data-object-id"))).size;
    expect({ molecules: count("molecule"), arrows: count("graphic"), text: count("text") })
      .toEqual({ molecules: 4, arrows: 2, text: 4 });
    expect([...svg.querySelectorAll('text[data-object-type="text"]')].filter(element => element.textContent === "+")).toHaveLength(2);
  });

  it("keeps the visible CDXML re-export identical after removing scheme metadata", () => {
    const { scheme, stripped: sourceWithoutSchemes } = importPair();
    const exported = exportDocumentToCdxml(scheme);
    expect(exported.warnings).toEqual([]);
    // Force a visible import, bypassing the embedded native document.
    const visible = exported.contents.replace(/<objecttag\b[^>]*\/>/g, "");
    const reopened = imported(visible);
    const stripped = imported(stripSchemes(visible));
    expect(exportDocumentToSvg(reopened)).toEqual(exportDocumentToSvg(stripped));
    const baselineExport = exportDocumentToCdxml(sourceWithoutSchemes);
    expect(baselineExport.warnings).toEqual([]);
    const baselineReopened = imported(baselineExport.contents.replace(/<objecttag\b[^>]*\/>/g, ""));
    expect(exportDocumentToSvg(reopened)).toEqual(exportDocumentToSvg(baselineReopened));
    expect(documentReactionSummary(reopened).map(step => step.components.map(component => component.role)))
      .toEqual(documentReactionSummary(scheme).map(step => step.components.map(component => component.role)));
  });

  it.each(["duplicate", "paste"])("remaps every reaction reference on %s, retaining the shared intermediate", operation => {
    const { scheme } = importPair();
    const page = scheme.pages[0];
    scheme.selection = { pageId: page.id, objectIds: page.objects.map(object => object.id) };
    const originalIds = new Set(page.objects.map(object => object.id));
    const payload = createSelectionClipboardPayload(scheme)!;
    const copied = operation === "duplicate"
      ? duplicateSelectedDocumentObjects(scheme)
      : pasteSelectionClipboardPayload(createEmptyDocument(), payload, { x: 300, y: 300 });
    const copies = copied.pages[0].objects.filter(object => operation === "paste" || !originalIds.has(object.id));
    const newIds = new Set(copies.map(object => object.id));
    const originalSteps = documentReactionSummary(scheme);
    const steps = documentReactionSummary({ ...copied, pages: [{ ...copied.pages[0], objects: copies }] });
    expect(steps).toHaveLength(2);
    for (const [index, step] of steps.entries()) {
      expect(step.components.map(component => component.role)).toEqual(originalSteps[index].components.map(component => component.role));
      expect(step.conditions.map(condition => condition.text)).toEqual(originalSteps[index].conditions.map(condition => condition.text));
      const refs = [...step.components.map(component => component.objectId), ...step.arrowObjectIds, ...step.plusObjectIds,
        ...step.conditions.map(condition => condition.objectId)];
      for (const id of refs) expect(newIds.has(id), `copied reference ${id}`).toBe(true);
      expect(step.arrowObjectIds).toHaveLength(1);
      expect(step.plusObjectIds).toHaveLength(1);
    }
    expect(steps[0].components.find(component => component.role === "product")?.objectId)
      .toBe(steps[1].components.find(component => component.role === "reactant")?.objectId);
    const chemistry = (objects: ChemDraftDocument["pages"][number]["objects"]) => objects
      .filter(object => object.type === "molecule").map(object => ({
        atoms: object.atoms.map(({ x: _x, y: _y, ...atom }) => atom), bonds: object.bonds
      }));
    expect(chemistry(copies)).toEqual(chemistry(page.objects));
    expect(planPageSvgRender({ ...copied.pages[0], objects: copies }).warnings).toEqual([]);
  });
});
