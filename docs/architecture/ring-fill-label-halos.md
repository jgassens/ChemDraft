# Ring fills and atom labels

Ring fills use the original atom-centre polygon for every paint and visual effect. They have no
label cutouts, compound subpaths or evenodd fill rule. Label colours and molecular data are unchanged.

For a default label halo overlapping a fill, layout-engine creates one SVG pattern containing paper
and the overlapping ring paints in underlay order. Each ring paint is clipped to its polygon. The
pattern contents transform back to page coordinates, reusing the original user-space gradients and
fill opacities. Its explicit viewBox preserves the tile origin. The glyph stroke samples this already
composited background once, avoiding the white antialias fringe produced by painting paper and colour
as separate glyph copies. Shadow, glow and sketch effects are excluded from the halo paint. Transparent
background overrides opt out; other explicit background colours retain the existing solid halo.

SVG and PNG consume that same plan. svg2pdf.js 2.7.0 ignores SVG paint servers on text, and patterned
PDF text strokes do not render consistently across consumers. The PDF writer therefore renders the
same SVG composite paint into a tiling pattern and paints it through a luminosity soft mask made from
the original stroked text. The mask retains its font, text matrix and scaled stroke width. These PDFs
use PDF 1.4 transparency. Unfilled documents keep their existing conversion path.

The PDF adapter deliberately uses jsPDF 4.2.1 stream/resource hooks. Its tests check actual polygon
operators, clipping, font-backed glyph masks, stream lengths, balanced graphics state and pattern
resources. Recheck these when upgrading either PDF dependency.

Fixtures come from real CLI documents for pyridinium, CBPQT4+ (the blue box), 1,3,5-oxathiazinane and
toluene. Tests cover light, solid and vivid fills; shared-ring label junctions; linear and radial
gradients; background overrides; effects; PNG halo fringes; and byte-identical unfilled/toluene plans.
The skill applies luminance-based text colours to ring labels too and rejects non-polygon ring fills.

On macOS, the solid pyridinium and oxathiazinane 800 px CLI PNGs were inspected, plus the blue box and
solid/gradient PDFs rasterized with pdftoppm. Fills reach bonds, labels have no white outline or box,
and bond ends remain clear. Windows native canvas/export inspection remains to be run.
