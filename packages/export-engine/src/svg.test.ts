import {
  applyPatch,
  createEmptyDocument,
  type GraphicObject,
  type MoleculeObject,
  type TextObject,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { planNativeArtVisual } from "@chemdraft/layout-engine";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "./svg";

const timestamp = "2026-05-29T00:00:00.000Z";

function nativeBondMolecule(): MoleculeObject {
  return {
    id: "mol_svg_hardened",
    type: "molecule",
    x: 100,
    y: 120,
    width: 90,
    height: 40,
    rotation: 0,
    style: { source: "chemdraft-native-drawing" },
    structureFormat: "smiles",
    structure: "CO",
    atoms: [
      { id: "atom_001", element: "C", x: 120, y: 140, formalCharge: 0 },
      { id: "atom_002", element: "O", x: 160, y: 140, formalCharge: 0 }
    ],
    bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
    chemistry: {
      atomCount: 2,
      bondCount: 1,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: []
  };
}

describe("SVG export serialization", () => {
  it("exports a blank page as a stable white page without workspace guides", () => {
    const document = createEmptyDocument({ title: "Blank SVG", now: timestamp });
    const result = exportDocumentToSvg(document);

    expect(result.format).toBe("svg");
    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(result.contents).toContain('width="8.5in" height="11in"');
    expect(result.contents).toContain('viewBox="0 0 816 1056"');
    expect(result.contents).toContain('<rect width="816" height="1056" fill="#ffffff" />');
    expect(result.contents).not.toContain('data-chemdraft-page-guide="margin"');
    expect(result.contents).not.toContain('stroke="#9fc9bd"');
    expect(result.contents).not.toContain("data-object-id=");
  });

  it("omits the page background rect for a transparent export", () => {
    const document = createEmptyDocument({ title: "Transparent SVG", now: timestamp });
    const result = exportDocumentToSvg(document, { background: "transparent" });

    expect(result.contents).not.toContain('fill="#ffffff"');
    expect(result.contents).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  it("uses a custom page background fill when provided", () => {
    const document = createEmptyDocument({ title: "Tinted SVG", now: timestamp });
    const result = exportDocumentToSvg(document, { background: "#102030" });

    expect(result.contents).toContain('<rect width="816" height="1056" fill="#102030" />');
  });

  it("can include page guide geometry when explicitly requested", () => {
    const document = createEmptyDocument({ title: "Guide SVG", now: timestamp });
    const result = exportDocumentToSvg(document, { includePageGuides: true });

    expect(result.contents).toContain('data-chemdraft-page-guide="margin"');
    expect(result.contents).toContain('x="72" y="72" width="672" height="912"');
    expect(result.contents).toContain('stroke="#9fc9bd"');
  });

  it("escapes document titles, text content, and object metadata for XML safety", () => {
    const textObject = {
      id: "text_escape_001",
      type: "text",
      x: 100,
      y: 120,
      width: 260,
      height: 40,
      rotation: 0,
      style: {},
      text: "MeOH & <base> \"quote\" 'prime'",
      spans: []
    } satisfies TextObject;
    const document = applyPatch(
      createEmptyDocument({ title: "A&B <svg> \"quote\" 'prime'", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: textObject },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('aria-label="A&amp;B &lt;svg&gt; &quot;quote&quot; &apos;prime&apos;"');
    expect(result.contents).toContain('data-object-id="text_escape_001"');
    expect(result.contents).toContain("MeOH &amp; &lt;base&gt; &quot;quote&quot; &apos;prime&apos;");
    expect(result.contents).not.toContain("MeOH & <base>");
  });

  it("omits interactive hit-target fragments while keeping visible molecule geometry", () => {
    const document = applyPatch(
      createEmptyDocument({ title: "No Hit Targets", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: nativeBondMolecule() },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('data-object-id="mol_svg_hardened"');
    expect(result.contents.match(/data-bond-id="bond_001"/g) ?? []).toHaveLength(1);
    expect(result.contents).toContain('data-atom-label="OH"');
    expect(result.contents).not.toContain("native-bond-hit-target");
    expect(result.contents).not.toContain("native-bond-hover-decorator");
    expect(result.contents).not.toContain("native-atom-hit-target");
    expect(result.contents).not.toContain("native-crossing-hit-target");
  });

  it("exports shared visual effect SVG for native molecules", () => {
    const molecule = {
      ...nativeBondMolecule(),
      id: "mol_svg_effects",
      style: {
        source: "chemdraft-native-drawing",
        visualEffects: [
          { kind: "shadow", color: "#52616b", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 },
          { kind: "glow", color: "#fdd835", opacity: 0.42, blurPx: 7, spreadPx: 1.2 },
          { kind: "sketch", color: "#111111", seed: 713, roughness: 1.25, bowing: 0.8, strokeWidth: 1.5 }
        ]
      }
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ title: "Molecule SVG Effects", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: molecule },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('id="molecule-effects-mol_svg_effects"');
    expect(result.contents).toContain('filterUnits="userSpaceOnUse"');
    expect(result.contents).not.toContain('x="-40%"');
    expect(result.contents).toContain('flood-color="#fdd835"');
    expect(result.contents).toContain('data-molecule-effect-source="true" filter="url(#molecule-effects-mol_svg_effects)"');
    expect(result.contents).toContain('data-molecule-effect="sketch"');
    expect(result.contents).toContain('data-object-id="mol_svg_effects"');
    expect(result.contents).not.toContain("native-bond-hit-target");
  });

  it("returns fallback warnings and can embed warning metadata on request", () => {
    const unknownObject = {
      id: "unknown_svg_001",
      type: "unknown-compatibility-object",
      x: 96,
      y: 144,
      width: 128,
      height: 48,
      rotation: 0,
      style: {},
      sourceFormat: "synthetic",
      sourceObjectType: "unsupported-shape",
      warning: "Synthetic unsupported object for SVG warning coverage."
    } satisfies UnknownCompatibilityObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Warning Metadata", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: unknownObject },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.warnings).toEqual([
      {
        code: "export.svg.object_fallback",
        message: 'SVG export used a labeled fallback for object type "unknown-compatibility-object".',
        severity: "warning",
        objectId: "unknown_svg_001"
      }
    ]);
    expect(result.contents).toContain('data-object-id="unknown_svg_001"');
    expect(result.contents).toContain('data-chemdraft-warnings="');
    expect(result.contents).toContain("export.svg.object_fallback");
    expect(result.contents).toContain("&quot;objectId&quot;:&quot;unknown_svg_001&quot;");
  });

  it("exports supported native graphic gloss, tilt, and shadow while warning for unsupported effects", () => {
    const graphic = {
      id: "art_svg_effects",
      type: "graphic",
      x: 120,
      y: 140,
      width: 72,
      height: 40,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        fillColor: "#1d7f68",
        fillOpacity: 0.48,
        fillMode: "gloss",
        effect: "shadow",
        tiltXDegrees: 20,
        tiltYDegrees: -10
      },
      graphicKind: "rect",
      data: { cornerRadiusPx: 7 }
    } satisfies GraphicObject;
    const reflection = {
      ...graphic,
      id: "art_svg_reflection",
      x: 220,
      style: {
        ...graphic.style,
        fillMode: "solid",
        fillOpacity: 1,
        effect: "reflection",
        tiltXDegrees: 0,
        tiltYDegrees: 0
      }
    } satisfies GraphicObject;
    const base = applyPatch(
      createEmptyDocument({ title: "SVG Graphic Effects", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );
    const document = applyPatch(
      base,
      { op: "addObject", pageId: "page_001", object: reflection },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.contents).toContain('data-object-id="art_svg_effects"');
    expect(result.contents).toContain('data-object-id="art_svg_reflection"');
    expect(result.contents).toContain('id="graphic-gloss-art_svg_effects"');
    expect(result.contents).toContain('gradientUnits="userSpaceOnUse"');
    expect(result.contents).toContain('gradientTransform="matrix(');
    expect(result.contents).toContain('data-graphic-effect="shadow"');
    expect(result.contents).toContain('fill="#52616b"');
    expect(result.contents).toContain('stroke="#52616b"');
    expect(result.contents).toContain('transform="translate(6 6)"');
    expect(result.contents).not.toContain('filter="url(#graphic-effects-art_svg_effects)"');
    expect(result.contents).not.toContain('data-graphic-effect-source="true"');
    expect(result.contents).not.toContain('in="SourceGraphic"');
    expect(result.contents).toContain('stop-color="#e4f0ed"');
    expect(result.contents).toContain('stop-color="#0d382e"');
    expect(result.contents.match(/stop-opacity="0.48"/g)).toHaveLength(4);
    expect(result.contents).not.toContain('fill-opacity="0.48"');
    expect(result.contents).not.toContain('stop-opacity="0.92"');
    expect(result.contents).not.toContain('stop-opacity="0.42"');
    expect(result.contents).not.toContain('stop-opacity="0.78"');
    expect(result.warnings.map((warning) => warning.code)).toEqual(["export.svg.graphic_effect_approximation"]);
    expect(result.warnings.map((warning) => warning.message)).toContain(
      "SVG export omitted the native reflection graphic effect."
    );
    expect(result.contents).not.toContain("export.svg.graphic_gloss_approximation");
    expect(result.contents).not.toContain("export.svg.graphic_tilt_approximation");
  });

  it("exports native glow and sketch effects as stable SVG effect geometry", () => {
    const graphic = {
      id: "art_svg_glow_sketch",
      type: "graphic",
      x: 90,
      y: 120,
      width: 84,
      height: 46,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        fillColor: "#f8faf9",
        strokeWidth: 2,
        effects: [
          { kind: "glow", color: "#1d7f68", opacity: 0.5, blurPx: 9, spreadPx: 2 },
          { kind: "sketch", color: "#111111", seed: 2468, roughness: 1.3, bowing: 0.7 }
        ]
      },
      graphicKind: "ellipse",
      data: {}
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Graphic Effects", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );

    const first = exportDocumentToSvg(document, { includeWarnings: true });
    const second = exportDocumentToSvg(document, { includeWarnings: true });

    expect(first.contents).toBe(second.contents);
    expect(first.contents).toContain('data-graphic-effect="glow"');
    expect(first.contents).toContain('data-graphic-effect="sketch"');
    expect(first.contents).toContain('stroke="#1d7f68"');
    expect(first.contents).toContain('stroke-opacity="0.16"');
    expect(first.contents).not.toContain('filter="url(#graphic-effects-art_svg_glow_sketch)"');
    expect(first.contents).not.toContain('data-graphic-effect-source="true"');
    expect(first.warnings).toEqual([]);
  });

  it("exports sketch as the visible stroke for open art paths", () => {
    const graphic = {
      id: "art_svg_sketch_line",
      type: "graphic",
      x: 96,
      y: 120,
      width: 140,
      height: 80,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        strokeWidth: 5,
        effects: [
          { kind: "shadow", color: "#52616b", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 },
          { kind: "glow", color: "#fdd835", opacity: 0.42, blurPx: 7, spreadPx: 1.2 },
          { kind: "sketch", color: "#111111", seed: 1357, roughness: 1.25, bowing: 0.8 }
        ]
      },
      graphicKind: "line",
      data: {
        lineStart: { x: 0, y: 70 },
        lineEnd: { x: 140, y: 0 }
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Sketch Line", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );

    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('data-graphic-effect="shadow"');
    expect(result.contents).toContain('data-graphic-effect="glow"');
    expect(result.contents).toContain('data-graphic-effect="sketch"');
    expect(result.contents).toMatch(/data-graphic-effect="sketch"[^>]*stroke-width="5"/);
    expect(result.contents).toMatch(/<line[^>]*data-object-id="art_svg_sketch_line"[^>]*stroke="none"/);
    expect(result.contents).not.toMatch(/<line[^>]*data-object-id="art_svg_sketch_line"[^>]*stroke="#111111"/);
    expect(result.contents).not.toContain('filter="url(#graphic-effects-art_svg_sketch_line)"');
    expect(result.warnings).toEqual([]);
  });

  it("exports native graphic arrowheads as Illustrator-safe SVG geometry", () => {
    const arrow = {
      id: "art_svg_arrow",
      type: "graphic",
      x: 120,
      y: 140,
      width: 82,
      height: 46,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        strokeWidth: 2,
        strokeLineCap: "butt"
      },
      graphicKind: "path",
      data: {
        artPathKind: "line",
        markerEnd: { kind: "filled-arrow", sizePx: 10 }
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Graphic Arrow", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: arrow },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="art_svg_arrow"');
    expect(result.contents).toContain('d="M 123 143 L');
    expect(result.contents).not.toContain('d="M 123 143 L 199 183"');
    expect(result.contents).toContain('id="graphic-marker-end-art_svg_arrow"');
    expect(result.contents).toContain('data-graphic-marker="end"');
    expect(result.contents).not.toContain("data-graphic-marker-connector");
    expect(result.contents).toMatch(/id="graphic-marker-end-art_svg_arrow" data-graphic-marker="end" d="M 199 183 L [^"]+ Z" fill="#111111" stroke="none"/);
    expect(result.contents).not.toContain("<marker");
    expect(result.contents).not.toContain("marker-end=");
  });

  it("exports closed native path-node polylines as fillable SVG paths", () => {
    const polyline = {
      id: "art_svg_polyline",
      type: "graphic",
      x: 120,
      y: 140,
      width: 96,
      height: 72,
      rotation: 0,
      style: {
        strokeColor: "#111111",
        fillColor: "#1d7f68",
        strokeWidth: 2
      },
      graphicKind: "path",
      data: {
        artPathKind: "polyline",
        pathClosed: true,
        pathNodes: [
          { point: { x: 132, y: 152 } },
          { point: { x: 204, y: 164 } },
          { point: { x: 168, y: 204 } }
        ]
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Graphic Polyline", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: polyline },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="art_svg_polyline"');
    expect(result.contents).toContain('d="M 132 152 L 204 164 L 168 204 Z"');
    expect(result.contents).toContain('fill="#1d7f68"');
  });

  it("exports native freehand strokes with the same outline path as the editor plan", () => {
    const freehand = {
      id: "art_svg_freehand",
      type: "graphic",
      x: 116,
      y: 134,
      width: 112,
      height: 74,
      rotation: 0,
      style: {
        strokeColor: "#1d7f68",
        fillColor: "none"
      },
      graphicKind: "path",
      data: {
        artPathKind: "freehand",
        freehandOptions: {
          size: 14,
          thinning: 0.65,
          smoothing: 0.5,
          streamline: 0.35,
          simulatePressure: false
        },
        freehandPoints: [
          { x: 132, y: 152, pressure: 0.2 },
          { x: 168, y: 178, pressure: 0.9 },
          { x: 212, y: 158, pressure: 0.5 }
        ]
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Freehand Stroke", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: freehand },
      { now: timestamp }
    );
    const plan = planNativeArtVisual(freehand, { coordinateSpace: "page" });
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('data-object-id="art_svg_freehand"');
    expect(plan.pathD).toBeDefined();
    expect(result.contents).toContain(`d="${plan.pathD}"`);
    expect(result.contents).toContain('fill="#1d7f68"');
    expect(result.contents).toContain('stroke="none"');
  });
});
