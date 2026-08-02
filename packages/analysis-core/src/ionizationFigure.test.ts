/**
 * The figure is the first thing a reader looks at, so its failure modes are the expensive kind: a
 * clipped number is a *wrong* number, and a colour that does not track the calibration is a confidence
 * claim nobody measured. These pin both.
 */
import { describe, expect, it } from "vitest";

import { ionizationBand, ionizationFigureSvg, type IonizationFigureStructure } from "./ionizationFigure";

const PHENOL: IonizationFigureStructure = {
  atoms: [
    { index: 0, x: 0, y: 0, element: "O", charge: 0, hydrogens: 1 },
    { index: 1, x: 1, y: 0, element: "C", charge: 0, hydrogens: 0 },
    { index: 2, x: 1.5, y: 0.87, element: "C", charge: 0, hydrogens: 1 },
    { index: 3, x: 2.5, y: 0.87, element: "C", charge: 0, hydrogens: 1 },
    { index: 4, x: 3, y: 0, element: "C", charge: 0, hydrogens: 1 },
    { index: 5, x: 2.5, y: -0.87, element: "C", charge: 0, hydrogens: 1 },
    { index: 6, x: 1.5, y: -0.87, element: "C", charge: 0, hydrogens: 1 }
  ],
  bonds: [
    { from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 2 }, { from: 2, to: 3, order: 1 },
    { from: 3, to: 4, order: 2 }, { from: 4, to: 5, order: 1 }, { from: 5, to: 6, order: 2 },
    { from: 6, to: 1, order: 1 }
  ]
};

const viewBox = (svg: string): { width: number; height: number } => {
  const match = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (!match) throw new Error("no viewBox");
  return { width: Number(match[1]), height: Number(match[2]) };
};

const textPositions = (svg: string): { x: number; y: number; text: string }[] =>
  [...svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
    x: Number(m[1]), y: Number(m[2]), text: m[3]!
  }));

describe("what the figure draws", () => {
  it("puts the value on the structure, next to its own atom", () => {
    const svg = ionizationFigureSvg({
      structure: PHENOL,
      annotations: [{ atomIndex: 0, text: "9.95 ± 0.44", band: "good", transition: "acidic" }],
      title: "phenol"
    })!;
    const label = textPositions(svg).find((entry) => entry.text.includes("9.95"));
    expect(label, "the value is not in the figure").toBeDefined();
    const oxygen = textPositions(svg).find((entry) => entry.text.startsWith("OH"));
    expect(oxygen, "the site atom is not labelled").toBeDefined();
    // Near its atom, not floating: within about one bond length.
    expect(Math.hypot(label!.x - oxygen!.x, label!.y - oxygen!.y)).toBeLessThan(46);
  });

  it("draws the acidic hydrogen, because that is what the value is about", () => {
    // The disclosure the whole figure exists for. An unlabelled O would leave the reader guessing
    // which transition was scored — exactly the amine confusion the contract has to shout about.
    const svg = ionizationFigureSvg({
      structure: PHENOL,
      annotations: [{ atomIndex: 0, text: "9.95", band: "good", transition: "acidic" }],
      title: "phenol"
    })!;
    expect(svg).toContain(">OH<");
  });

  it("shows a neutral amine as NH₂ rather than hiding its protons", () => {
    const amine: IonizationFigureStructure = {
      atoms: [
        { index: 0, x: 0, y: 0, element: "N", charge: 0, hydrogens: 2 },
        { index: 1, x: 1, y: 0, element: "C", charge: 0, hydrogens: 3 }
      ],
      bonds: [{ from: 0, to: 1, order: 1 }]
    };
    const svg = ionizationFigureSvg({
      structure: amine,
      annotations: [{ atomIndex: 0, text: "9.03 ± 4.76", band: "poor", transition: "acidic" }],
      title: "amine"
    })!;
    expect(svg).toContain(">NH₂<");
  });

  it("writes a charge as a superscript, not as a formula character", () => {
    const nitro: IonizationFigureStructure = {
      atoms: [
        { index: 0, x: 0, y: 0, element: "O", charge: 0, hydrogens: 1 },
        { index: 1, x: 1, y: 0, element: "N", charge: 1, hydrogens: 0 },
        { index: 2, x: 2, y: 0, element: "O", charge: -1, hydrogens: 0 }
      ],
      bonds: [{ from: 0, to: 1, order: 1 }, { from: 1, to: 2, order: 1 }]
    };
    const svg = ionizationFigureSvg({
      structure: nitro,
      annotations: [{ atomIndex: 0, text: "7.17", band: "good", transition: "acidic" }],
      title: "nitro"
    })!;
    expect(svg).toContain(">N⁺<");
    expect(svg).toContain(">O⁻<");
  });
});

describe("nothing drawn is cut off", () => {
  it("frames the labels, not just the atoms", () => {
    // The bug this catches produced ".59 ± 5.15" from "7.59 ± 5.15" — a plausible, wrong number. A
    // label offset outward from an edge atom extends half its own width further still, so the frame
    // has to be sized from the text, not from the structure.
    const svg = ionizationFigureSvg({
      structure: PHENOL,
      annotations: [{ atomIndex: 0, text: "12.34 ± 56.78", band: "poor", transition: "acidic" }],
      title: "phenol"
    })!;
    const { width, height } = viewBox(svg);
    for (const entry of textPositions(svg)) {
      const halfWidth = (entry.text.length * 6.9) / 2;
      expect(entry.x - halfWidth, `"${entry.text}" runs off the left`).toBeGreaterThanOrEqual(0);
      expect(entry.x + halfWidth, `"${entry.text}" runs off the right`).toBeLessThanOrEqual(width);
      expect(entry.y, `"${entry.text}" runs off the top`).toBeGreaterThanOrEqual(0);
      expect(entry.y, `"${entry.text}" runs off the bottom`).toBeLessThanOrEqual(height);
    }
  });

  it("keeps an intrinsic size so it can be scaled down rather than cropped", () => {
    const svg = ionizationFigureSvg({
      structure: PHENOL,
      annotations: [{ atomIndex: 0, text: "9.95", band: "good", transition: "acidic" }],
      title: "phenol"
    })!;
    const { width, height } = viewBox(svg);
    expect(svg).toContain(`width="${width}"`);
    expect(svg).toContain(`height="${height}"`);
  });

  it("declines to draw an empty frame when no site carries a value", () => {
    // An empty picture reads as a broken analysis. No picture reads as what it is.
    expect(ionizationFigureSvg({ structure: PHENOL, annotations: [], title: "phenol" })).toBeUndefined();
  });
});

describe("colour is the measured band", () => {
  const bands = { good: 0.996, poor: 2.647 };

  it("maps an interval to the quartile its accuracy was measured in", () => {
    expect(ionizationBand(0.45, bands)).toBe("good");
    expect(ionizationBand(0.996, bands)).toBe("good");
    expect(ionizationBand(1.63, bands)).toBe("fair");
    expect(ionizationBand(4.76, bands)).toBe("poor");
  });

  it("says nothing rather than guessing when there is no interval", () => {
    expect(ionizationBand(undefined, bands)).toBe("unknown");
  });

  it("colours the site and its value the same, so the pair reads as one statement", () => {
    const svg = ionizationFigureSvg({
      structure: PHENOL,
      annotations: [{ atomIndex: 0, text: "9.03 ± 4.76", band: "poor", transition: "acidic" }],
      title: "phenol"
    })!;
    // Red on both the atom and the number; a coloured number beside a black atom would read as two
    // unrelated facts.
    expect(svg.match(/#cf222e/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
