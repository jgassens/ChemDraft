import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossingPairKey, planPageSvgRender } from "@chemdraft/layout-engine";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

const source = readFileSync("packages/cdx-compat/src/fixtures/c5-catenane.chemdraft", "utf8");

describe("saved 30-ring catenane crossing references", () => {
  it("keeps both intersecting bond pairs through native .chemdraft import and save", () => {
    expect(source.match(/CrossingBonds=/g)).toHaveLength(4);
    const opened = openChemDraftPayload(source);
    expect(opened.source).toBe("native-payload");
    expect(opened.document).toBeDefined();
    const document = opened.document!;
    const assertCrossings = (page: typeof document.pages[number]) => {
      expect(page.crossings).toHaveLength(2);
      const intersections = planPageSvgRender(page).crossings;
      expect(intersections).toHaveLength(2);
      expect(page.crossings.map(c => crossingPairKey(c.bonds)).sort())
        .toEqual(intersections.map(c => c.key).sort());
      expect(new Set(page.crossings.map(c => c.front.objectId)).size).toBe(2);
    };
    assertCrossings(document.pages[0]!);
    const written = exportDocumentToCdxml(document);
    const reimported = openChemDraftPayload(written.contents);
    expect(reimported.document).toBeDefined();
    assertCrossings(reimported.document!.pages[0]!);
    expect(reimported.document!.pages[0]!.crossings).toEqual(document.pages[0]!.crossings);
  });
});
