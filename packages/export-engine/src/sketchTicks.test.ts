import { createEmptyDocument } from "@chemdraft/chem-core";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { describe, expect, it } from "vitest";
import { sketchRegressionMolecule } from "../../layout-engine/src/sketchRegression.fixture";
import { exportDocumentToSvg } from "./svg";

describe("sketch tick export parity", () => {
  it("serializes the canvas's exact tapered paths, including effect opacity, for SVG/PNG input", () => {
    const document = createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" });
    const molecule = sketchRegressionMolecule(true);
    molecule.style.visualEffects = [{ kind: "sketch", seed: 7, roughness: 1.25, bowing: 1, opacity: 0.6 }];
    document.pages[0]!.objects = [molecule];
    const sketch = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)
      .filter((fragment) => fragment.attrs.class === "native-molecule-sketch");
    const svg = exportDocumentToSvg(document).contents;
    expect(sketch.length).toBeGreaterThan(2);
    for (const fragment of sketch) {
      expect(svg).toContain(`d="${fragment.attrs.d}"`);
      expect(svg).toContain(`fill="${fragment.attrs.fill}"`);
      if (fragment.attrs.fill !== "none") expect(fragment.attrs["fill-opacity"]).toBe(0.6);
    }
    expect(svg).not.toContain("stroke-dasharray=");
    expect(svg).not.toContain("data-bond-hash-index=");
  });
});
