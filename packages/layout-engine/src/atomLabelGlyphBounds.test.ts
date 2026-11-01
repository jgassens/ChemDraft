// The collision box of an atom label must enclose the ink the renderer draws, for every label font.
// Ink comes from the public Adobe core-14 AFM metrics (Helvetica, Courier, regular and bold), each
// entry "char:advance,llx,lly,urx,ury" in 1/1000 em, placed as SVG text draws a run: baseline at
// run.y + 0.35 em, start/middle/end anchored by the font's own advance.

import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeAtom, type NativeDrawingStyle } from "@chemdraft/chem-core";

import { atomLabelGlyphBounds, atomLabelLayout, type AtomLabelPlan } from "./index";

const AFM_SOURCE: Record<"helvetica" | "helveticaBold" | "courier" | "courierBold", string[]> = {
  helvetica: [
    "(:333,68,-207,299,733 ):333,34,-207,265,733 +:584,39,0,545,505 ,:278,87,-147,191,106",
    "-:333,44,232,289,322 .:278,87,0,191,106 /:278,-17,-19,295,737 0:556,37,-19,519,703",
    "1:556,101,0,359,703 2:556,26,0,507,703 3:556,34,-19,522,703 4:556,25,0,523,703",
    "5:556,32,-19,514,688 6:556,38,-19,518,703 7:556,37,0,523,688 8:556,38,-19,517,703",
    "9:556,42,-19,514,703 ;:278,87,-147,191,516 A:667,14,0,654,718 B:667,74,0,627,718",
    "C:722,44,-19,681,737 D:722,81,0,674,718 E:667,86,0,616,718 F:611,86,0,583,718",
    "G:778,48,-19,704,737 H:722,77,0,646,718 I:278,91,0,188,718 J:500,17,-19,428,718",
    "K:667,76,0,663,718 L:556,76,0,537,718 M:833,73,0,761,718 N:722,76,0,646,718 O:778,39,-19,739,737",
    "P:667,86,0,622,718 Q:778,39,-56,739,737 R:722,88,0,684,718 S:667,49,-19,620,737",
    "T:611,14,0,597,718 U:722,79,-19,644,718 V:667,20,0,647,718 W:944,16,0,928,718 X:667,19,0,648,718",
    "Y:667,14,0,653,718 Z:611,23,0,588,718 [:278,63,-196,250,722 ]:278,28,-196,215,722",
    "_:556,0,-125,556,-75 a:556,36,-15,530,538 b:556,58,-15,517,718 c:500,30,-15,477,538",
    "d:556,35,-15,499,718 e:556,40,-15,516,538 f:278,14,0,262,728 g:556,40,-220,499,538",
    "h:556,65,0,491,718 i:222,67,0,155,718 j:222,-16,-210,155,718 k:500,67,0,501,718",
    "l:222,67,0,155,718 m:833,65,0,769,538 n:556,65,0,491,538 o:556,35,-14,521,538",
    "p:556,58,-207,517,538 q:556,35,-207,494,538 r:333,77,0,332,538 s:500,32,-15,464,538",
    "t:278,14,-7,257,669 u:556,68,-15,489,523 v:500,8,0,492,523 w:722,14,0,709,523 x:500,11,0,490,523",
    "y:500,11,-214,489,523 z:500,31,0,469,523 {:334,42,-196,292,722 }:334,42,-196,292,722",
  ],
  helveticaBold: [
    "(:333,35,-208,314,734 ):333,19,-208,298,734 +:584,40,0,544,506 ,:278,64,-168,214,146",
    "-:333,27,215,306,345 .:278,64,0,214,146 /:278,-33,-19,311,737 0:556,32,-19,524,710",
    "1:556,69,0,378,710 2:556,26,0,511,710 3:556,27,-19,516,710 4:556,27,0,526,710",
    "5:556,27,-19,516,698 6:556,31,-19,520,710 7:556,25,0,528,698 8:556,32,-19,524,710",
    "9:556,30,-19,522,710 ;:333,92,-168,242,512 A:722,20,0,702,718 B:722,76,0,669,718",
    "C:722,44,-19,684,737 D:722,76,0,685,718 E:667,76,0,621,718 F:611,76,0,587,718",
    "G:778,44,-19,713,737 H:722,71,0,651,718 I:278,64,0,214,718 J:556,22,-18,484,718",
    "K:722,87,0,722,718 L:611,76,0,583,718 M:833,69,0,765,718 N:722,69,0,654,718 O:778,44,-19,734,737",
    "P:667,76,0,627,718 Q:778,44,-52,737,737 R:722,76,0,677,718 S:667,39,-19,629,737",
    "T:611,14,0,598,718 U:722,72,-19,651,718 V:667,19,0,648,718 W:944,16,0,929,718 X:667,14,0,653,718",
    "Y:667,15,0,653,718 Z:611,25,0,586,718 [:333,63,-196,309,722 ]:333,24,-196,270,722",
    "_:556,0,-125,556,-75 a:556,29,-14,527,546 b:611,61,-14,578,718 c:556,34,-14,524,546",
    "d:611,34,-14,551,718 e:556,23,-14,528,546 f:333,10,0,318,727 g:611,40,-217,553,546",
    "h:611,65,0,546,718 i:278,69,0,209,725 j:278,3,-214,209,725 k:556,69,0,562,718 l:278,69,0,209,718",
    "m:889,64,0,826,546 n:611,65,0,546,546 o:611,34,-14,578,546 p:611,62,-207,578,546",
    "q:611,34,-207,552,546 r:389,64,0,373,546 s:556,30,-14,519,546 t:333,10,-6,309,676",
    "u:611,66,-14,545,532 v:556,13,0,543,532 w:778,10,0,769,532 x:556,15,0,541,532",
    "y:556,10,-214,539,532 z:500,20,0,480,532 {:389,48,-196,365,722 }:389,24,-196,341,722",
  ],
  courier: [
    "(:600,269,-108,440,622 ):600,160,-108,331,622 +:600,80,44,520,470 ,:600,181,-112,344,122",
    "-:600,103,231,497,285 .:600,229,-15,371,109 /:600,125,-80,475,629 0:600,106,-15,494,622",
    "1:600,96,0,505,622 2:600,70,0,471,622 3:600,75,-15,466,622 4:600,78,0,500,622",
    "5:600,92,-15,497,607 6:600,111,-15,497,622 7:600,82,0,483,607 8:600,102,-15,498,622",
    "9:600,96,-15,489,622 ;:600,181,-112,371,385 A:600,3,0,597,562 B:600,43,0,559,562",
    "C:600,41,-18,540,580 D:600,43,0,574,562 E:600,53,0,550,562 F:600,53,0,545,562",
    "G:600,31,-18,575,580 H:600,32,0,568,562 I:600,96,0,504,562 J:600,34,-18,566,562",
    "K:600,38,0,582,562 L:600,47,0,554,562 M:600,4,0,596,562 N:600,7,-13,593,562 O:600,43,-18,557,580",
    "P:600,79,0,558,562 Q:600,43,-138,557,580 R:600,38,0,588,562 S:600,72,-20,529,580",
    "T:600,38,0,563,562 U:600,17,-18,583,562 V:600,-4,-13,604,562 W:600,-3,-13,603,562",
    "X:600,23,0,577,562 Y:600,24,0,576,562 Z:600,86,0,514,562 [:600,269,-108,442,622",
    "]:600,158,-108,331,622 _:600,0,-125,600,-75 a:600,53,-15,559,441 b:600,14,-15,575,629",
    "c:600,66,-15,529,441 d:600,45,-15,591,629 e:600,66,-15,548,441 f:600,114,0,531,629",
    "g:600,45,-157,566,441 h:600,18,0,582,629 i:600,95,0,505,657 j:600,82,-157,410,657",
    "k:600,43,0,580,629 l:600,95,0,505,629 m:600,-5,0,605,441 n:600,26,0,575,441 o:600,62,-15,538,441",
    "p:600,9,-157,555,441 q:600,45,-157,591,441 r:600,60,0,559,441 s:600,80,-15,513,441",
    "t:600,87,-15,530,561 u:600,21,-15,562,426 v:600,10,-10,590,426 w:600,-4,-10,604,426",
    "x:600,20,0,580,426 y:600,7,-157,592,426 z:600,99,0,502,426 {:600,182,-108,437,622",
    "}:600,163,-108,418,622",
  ],
  courierBold: [
    "(:600,219,-102,461,616 ):600,139,-102,381,616 +:600,71,39,529,478 ,:600,123,-111,393,174",
    "-:600,100,203,500,313 .:600,192,-15,408,171 /:600,98,-77,502,626 0:600,87,-15,513,616",
    "1:600,81,0,539,616 2:600,61,0,499,616 3:600,63,-15,501,616 4:600,53,0,507,616",
    "5:600,70,-15,521,601 6:600,90,-15,521,616 7:600,55,0,494,601 8:600,83,-15,517,616",
    "9:600,79,-15,510,616 ;:600,123,-111,408,425 A:600,-9,0,609,562 B:600,30,0,573,562",
    "C:600,22,-18,560,580 D:600,30,0,594,562 E:600,25,0,560,562 F:600,39,0,570,562",
    "G:600,22,-18,594,580 H:600,20,0,580,562 I:600,77,0,523,562 J:600,37,-18,601,562",
    "K:600,21,0,599,562 L:600,39,0,578,562 M:600,-2,0,602,562 N:600,8,-12,610,562",
    "O:600,22,-18,578,580 P:600,48,0,559,562 Q:600,32,-138,578,580 R:600,24,0,599,562",
    "S:600,47,-22,553,582 T:600,21,0,579,562 U:600,4,-18,596,562 V:600,-13,0,613,562",
    "W:600,-18,0,618,562 X:600,12,0,588,562 Y:600,12,0,589,562 Z:600,62,0,539,562",
    "[:600,245,-102,475,616 ]:600,125,-102,355,616 _:600,0,-125,600,-75 a:600,35,-15,570,454",
    "b:600,0,-15,584,626 c:600,40,-15,545,459 d:600,20,-15,591,626 e:600,40,-15,563,454",
    "f:600,83,0,547,626 g:600,30,-146,580,454 h:600,5,0,592,626 i:600,77,0,523,658",
    "j:600,63,-146,440,658 k:600,20,0,585,626 l:600,77,0,523,626 m:600,-22,0,626,454",
    "n:600,18,0,592,454 o:600,30,-15,570,454 p:600,-1,-142,570,454 q:600,20,-142,591,454",
    "r:600,47,0,580,454 s:600,68,-17,535,459 t:600,47,-15,532,562 u:600,-1,-15,569,439",
    "v:600,-1,0,601,439 w:600,-18,0,618,439 x:600,6,0,594,439 y:600,-4,-142,601,439",
    "z:600,81,0,520,439 {:600,160,-102,464,616 }:600,136,-102,440,616",
  ]
};

interface Glyph { advance: number; llx: number; lly: number; urx: number; ury: number }
const AFM = Object.fromEntries(Object.entries(AFM_SOURCE).map(([font, lines]) => [font,
  new Map(lines.flatMap(line => line.split(" ")).map((line): [string, Glyph] => {
    const split = line.indexOf(":");
    const [advance, llx, lly, urx, ury] = line.slice(split + 1).split(",").map(Number);
    return [line.slice(0, split), { advance: advance!, llx: llx!, lly: lly!, urx: urx!, ury: ury! }];
  }))])) as Record<keyof typeof AFM_SOURCE, Map<string, Glyph>>;

const SANS_STACKS = ["Arial, Helvetica, sans-serif", "Helvetica", "Arial", "'Helvetica', sans-serif", "sans-serif"];
const MONO_STACKS = ["Courier New, Courier, monospace", "Courier", "monospace", "'Courier New', monospace"];
const FOREIGN_STACKS = ["Times New Roman, Times, serif", "Georgia, serif", "Menlo", "Arial, Georgia, serif",
  "Courier New, Arial, sans-serif", "system-ui", ""];

const atom: MoleculeAtom = { id: "a", element: "C", x: 0, y: 0, formalCharge: 0 };

function planFor(label: string, style: Partial<NativeDrawingStyle>, anchor?: { side: "start" | "end"; length: number }): AtomLabelPlan {
  const drawingStyle: NativeDrawingStyle = { ...DefaultNativeDrawingStyle, ...style };
  const layout = atomLabelLayout(label, drawingStyle, anchor);
  return { atom, label, ...(anchor ? { labelAnchor: anchor } : {}), anchor: { x: 0, y: 0 }, anchorOffset: { x: 0, y: 0 },
    layout, drawingStyle, color: drawingStyle.atomLabelColor, backgroundColor: drawingStyle.atomLabelBackgroundColor,
    backgroundVisible: false, fontFamily: drawingStyle.atomLabelFontFamily, fontSizePx: drawingStyle.atomLabelFontSizePx,
    fontWeight: drawingStyle.atomLabelFontWeight, fontStyle: drawingStyle.atomLabelFontStyle };
}

/** The union of the ink every run draws, in the label's own coordinates (y down), from the AFM boxes. */
function drawnInk(plan: AtomLabelPlan, font: keyof typeof AFM_SOURCE, shear = 0): { left: number; right: number; top: number; bottom: number } {
  const glyphs = AFM[font];
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const run of plan.layout.runs) {
    const size = atomLabelRunSize(plan, run.script);
    const total = [...run.text].reduce((sum, ch) => sum + glyphs.get(ch)!.advance, 0) / 1000 * size;
    let pen = run.x - (run.textAnchor === "middle" ? total / 2 : run.textAnchor === "end" ? total : 0);
    const baseline = run.y + 0.35 * size;
    for (const ch of run.text) {
      const glyph = glyphs.get(ch);
      if (!glyph) throw new Error(`no AFM metrics for ${JSON.stringify(ch)}`);
      const yUp = [glyph.lly, glyph.ury].map(v => v / 1000 * size);
      // A slanted glyph leans right above its baseline and left below it.
      for (const [x, up] of [[glyph.llx, yUp[0]!], [glyph.llx, yUp[1]!], [glyph.urx, yUp[0]!], [glyph.urx, yUp[1]!]] as const) {
        const px = pen + x / 1000 * size + shear * up;
        left = Math.min(left, px); right = Math.max(right, px);
      }
      top = Math.min(top, baseline - yUp[1]!); bottom = Math.max(bottom, baseline - yUp[0]!);
      pen += glyph.advance / 1000 * size;
    }
  }
  return { left, right, top, bottom };
}

function atomLabelRunSize(plan: AtomLabelPlan, script: "normal" | "subscript" | "superscript"): number {
  const base = plan.drawingStyle.atomLabelFontSizePx;
  return script === "normal" ? base : base * (script === "superscript" ? 0.88 : 0.72);
}

function expectEncloses(plan: AtomLabelPlan, font: keyof typeof AFM_SOURCE, shear = 0): void {
  const box = atomLabelGlyphBounds(plan), ink = drawnInk(plan, font, shear), eps = 1e-9;
  const where = JSON.stringify({ label: plan.label, font, box, ink });
  expect(box.x, where).toBeLessThanOrEqual(ink.left + eps);
  expect(box.x + box.width, where).toBeGreaterThanOrEqual(ink.right - eps);
  expect(box.y, where).toBeLessThanOrEqual(ink.top + eps);
  expect(box.y + box.height, where).toBeGreaterThanOrEqual(ink.bottom - eps);
}

// Labels cover parentheses and brackets, a Q, a lowercase descender, commas, charges, isotopes,
// subscripts and superscripts. Upper-case/digit labels also run in bold, whose advance the layout
// scales from the regular one.
const LABELS = ["OH", "NH2", "I", "Q", "O", "H", "N(CH3)2", "(CH2)3", "[Fe]", "[Cu(NH3)4]2+", "C(O)Q", "CH3,", "S;O",
  "O-", "NH4+", "N2+", "O2-", "Mg2+", "13C", "2H", "Cl-", "OMe", "tBu", "Cp", "Pyg", "Q-", "P{O}", "C/O", "C_6"];
const CAPS_LABELS = LABELS.filter(label => !/[a-z]/.test(label.replace(/^\d+/, "")) || /^\[Fe\]$/.test(label));
const ANCHORS = [undefined, { side: "start" as const, length: 1 }, { side: "end" as const, length: 1 }];

describe("atomLabelGlyphBounds encloses the ink of the label font", () => {
  it.each(SANS_STACKS)("Helvetica/Arial stack %s: every label, anchor and size", (fontFamily) => {
    for (const label of LABELS) for (const anchor of ANCHORS) for (const atomLabelFontSizePx of [10, 15, 23]) {
      if (/^[^a-z]*$/.test(label) || anchor === undefined) {
        // An anchored layout needs the anchor characters in a normal-script run.
        expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontSizePx }, anchor), "helvetica");
      }
    }
  });

  it("covers bold Helvetica ink for upper-case labels", () => {
    for (const label of CAPS_LABELS) {
      expectEncloses(planFor(label, { atomLabelFontWeight: 700, atomLabelFontSizePx: 18 }), "helveticaBold");
    }
  });

  it("covers slanted Helvetica ink (real and synthetic italics)", () => {
    for (const label of LABELS) {
      expectEncloses(planFor(label, { atomLabelFontStyle: "italic", atomLabelFontSizePx: 16 }), "helvetica", 0.25);
    }
  });

  it.each(MONO_STACKS)("monospace stack %s: every label at Courier's 0.6 em advance", (fontFamily) => {
    for (const label of LABELS) for (const anchor of ANCHORS) for (const atomLabelFontSizePx of [10, 15, 23]) {
      if (/^[^a-z]*$/.test(label) || anchor === undefined) {
        expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontSizePx }, anchor), "courier");
      }
    }
    for (const label of CAPS_LABELS) {
      expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontWeight: 700 }), "courierBold");
    }
  });

  it("widens a monospace 'I' to its advance, where Helvetica's is under half as wide", () => {
    const courier = atomLabelGlyphBounds(planFor("I", { atomLabelFontFamily: "Courier New, Courier, monospace", atomLabelFontSizePx: 20 }));
    const helvetica = atomLabelGlyphBounds(planFor("I", { atomLabelFontSizePx: 20 }));
    expect(courier.width).toBeGreaterThanOrEqual(0.6 * 20);
    expect(helvetica.width).toBeLessThan(0.3 * 20);
  });

  it("keeps the run's text anchor when widening a monospace run", () => {
    const size = 20, family = "Courier New, Courier, monospace";
    const plan = planFor("MeO2C", { atomLabelFontFamily: family, atomLabelFontSizePx: size }, { side: "end", length: 1 });
    const box = atomLabelGlyphBounds(plan);
    const runs = plan.layout.runs;
    const anchored = runs.filter(run => run.textAnchor === "end")[0]!;
    expect(box.x + box.width).toBeGreaterThanOrEqual(anchored.x);
    expect(box.x).toBeLessThanOrEqual(anchored.x - anchored.text.length * 0.6 * size);
  });

  it("descends below the baseline for Q, brackets, parentheses and commas, and rises for brackets", () => {
    const size = 20;
    const baseline = (plan: AtomLabelPlan) => plan.layout.runs[0]!.y + 0.35 * size;
    for (const [label, descent, ascent] of [["Q", 0.138, 0.737], ["(", 0.208, 0.734], [")", 0.208, 0.734],
      ["[", 0.196, 0.722], ["]", 0.196, 0.722], ["{", 0.196, 0.722], [",", 0.168, 0.2], [";", 0.168, 0.5], ["/", 0.019, 0.737]] as const) {
      const plan = planFor(label, { atomLabelFontSizePx: size });
      const box = atomLabelGlyphBounds(plan);
      expect(box.y + box.height, label).toBeGreaterThanOrEqual(baseline(plan) + descent * size);
      expect(box.y, label).toBeLessThanOrEqual(baseline(plan) - ascent * size);
    }
  });

  it("encloses the plus and minus ink of a charge, and the isotope and subscript digits", () => {
    for (const label of ["N+", "O-", "N3+", "O2-", "13CH3", "H2O", "CO2H"]) {
      expectEncloses(planFor(label, { atomLabelFontSizePx: 20 }), "helvetica");
      expectEncloses(planFor(label, { atomLabelFontSizePx: 20, atomLabelFontFamily: "Courier" }), "courier");
    }
  });

  it("keeps the sans-serif glyph box inside the padded renderer bounds for ordinary labels", () => {
    for (const label of ["OH", "NH2", "CO2H", "O-", "NH4+", "N2+", "13C", "H2N", "I", "Cl"]) {
      for (const anchor of ANCHORS) {
        const plan = planFor(label, {}, anchor), box = atomLabelGlyphBounds(plan), bounds = plan.layout.bounds;
        expect(box.x, label).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(box.y, label).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(box.x + box.width, label).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
        expect(box.y + box.height, label).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
      }
    }
  });

  it.each(FOREIGN_STACKS)("an unknown font stack (%j) gets the padded renderer bounds", (fontFamily) => {
    for (const label of ["OH", "Q", "I", "N(CH3)2", "O2-"]) {
      const plan = planFor(label, { atomLabelFontFamily: fontFamily });
      expect(atomLabelGlyphBounds(plan)).toEqual(plan.layout.bounds);
    }
  });
});
