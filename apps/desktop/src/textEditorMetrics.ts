import type { NativeTextStyle } from "@chemdraft/chem-core";
import type { NativeTextCssMetrics } from "@chemdraft/layout-engine";

/** Read the actual SVG page-to-CSS transform relative to the chrome layer. The
 * page's border-box and SVG's default xMidYMid meet make nominal zoom insufficient.
 * The page only translates outside this SVG; its CTM therefore has a uniform scale. */
export function measureTextEditorViewport(layer: HTMLElement | null | undefined) {
  const svg = layer?.closest(".page")?.querySelector<SVGSVGElement>(".page-svg-visual-layer");
  const matrix = svg?.getScreenCTM?.();
  if (!matrix || !layer || matrix.a <= 0) return undefined;
  const rect = layer.getBoundingClientRect();
  return { scale: matrix.a, offset: { x: matrix.e - rect.left, y: matrix.f - rect.top } };
}

/** Measure the browser's CSS baseline, not glyph ink or a guessed Arial ascent.
 * WKWebView and WebView2 choose/round font metrics differently. A zero-size inline
 * block sits on the alphabetic baseline. Measuring at the actual scaled size and
 * requested line height also captures each engine's subpixel layout rounding.
 * Returned extents include half-leading on both sides, which cancels in the shared
 * layout engine's ascent + (lineHeight - ascent - descent) / 2 calculation. */
export function measureTextEditorMetrics(style: NativeTextStyle, scale: number, lineHeightPx: number): NativeTextCssMetrics | undefined {
  const probe = document.createElement("span");
  Object.assign(probe.style, {
    position: "fixed", visibility: "hidden", pointerEvents: "none",
    left: "0", top: "0", display: "inline-block", whiteSpace: "pre",
    margin: "0", padding: "0", border: "0",
    fontFamily: style.fontFamily, fontSize: `${style.fontSizePx * scale}px`,
    fontWeight: String(style.fontWeight), fontStyle: style.fontStyle,
    lineHeight: `${lineHeightPx}px`
  });
  const baseline = document.createElement("span");
  Object.assign(baseline.style, {
    display: "inline-block", verticalAlign: "baseline", width: "0", height: "0",
    margin: "0", padding: "0", border: "0"
  });
  probe.append(document.createTextNode("Hg"), baseline);
  document.body.append(probe);
  try {
    const rect = probe.getBoundingClientRect();
    const baselineY = baseline.getBoundingClientRect().top;
    if (rect.height === 0) return undefined; // No layout engine (jsdom).
    return { ascentPx: baselineY - rect.top, descentPx: rect.bottom - baselineY };
  } finally {
    probe.remove();
  }
}
