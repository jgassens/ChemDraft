import {
  nativeTextStyleFromObjectStyle,
  type NativeTextStyle,
  type TableObject,
  type TableRichText,
  type TextSpan
} from "@chemdraft/chem-core";
import {
  elementFragment, objectAttributes, rotationTransform, textSpanLineFragments, transformPointForObject,
  type LayoutBounds, type PageSvgElementFragment
} from "./index";
import { measureTextRun } from "./textMetrics";

interface TableLine {
  baselineY: number;
  pieces: { runs: TextSpan[]; x: number; anchor: "start" | "middle" | "end" }[];
}

interface TableTextBox extends LayoutBounds {
  lines: TableLine[];
}

export interface TableLayout {
  origin: { x: number; y: number };
  width: number;
  height: number;
  captionBox?: TableTextBox;
  bodyBox: LayoutBounds;
  footnoteBoxes: TableTextBox[];
  columns: {
    x: number;
    width: number;
    decimalAnchorX?: number;
    decimalBlock?: { insetLeft: number; insetRight: number; preWidth: number; postWidth: number };
  }[];
  rows: { y: number; height: number }[];
  cells: { rowIndex: number; columnIndex: number; box: LayoutBounds; lines: TableLine[] }[];
  rules: { x1: number; y1: number; x2: number; y2: number; widthPx: number }[];
}

// Table objects are immutable snapshots. Replacements, including drag previews, get their own plans.
const layoutCache = new WeakMap<TableObject, TableLayout>();
const svgCache = new WeakMap<TableObject, Map<number, PageSvgElementFragment>>();
const boundsCache = new WeakMap<TableObject, LayoutBounds>();

export function tableCellElementId(tableId: string, rowId: string, columnId: string): string {
  return `table-cell-${encodeURIComponent(JSON.stringify([tableId, rowId, columnId]))}`;
}

function richTextLines(value: TableRichText, bold: boolean): TextSpan[][] {
  const spans = value.spans.length > 0 && value.spans.map(span => span.text).join("") === value.text
    ? value.spans : [{ text: value.text, script: "normal" as const, style: {} }];
  const lines: TextSpan[][] = [[]];
  for (const span of spans) {
    span.text.split(/\r?\n/).forEach((text, index) => {
      if (index > 0) lines.push([]);
      if (text.length > 0) lines[lines.length - 1].push({ ...span, text,
        style: bold ? { ...span.style, fontWeight: Math.max(700,
          typeof span.style.fontWeight === "number" ? span.style.fontWeight : 700) } : span.style });
    });
  }
  return lines;
}

function runWidth(runs: TextSpan[], style: NativeTextStyle): number {
  return runs.reduce((sum, run) => {
    const fontSizePx = run.script === "normal" && typeof run.style.fontSizePx === "number"
      ? run.style.fontSizePx : style.fontSizePx;
    const fontWeight = typeof run.style.fontWeight === "number" ? run.style.fontWeight : style.fontWeight;
    const spacing = typeof run.style.letterSpacingPx === "number" ? run.style.letterSpacingPx : style.letterSpacingPx;
    return sum + measureTextRun(run.text, { fontSizePx, fontWeight, script: run.script }) + [...run.text].length * spacing;
  }, 0);
}

function splitDecimal(runs: TextSpan[]): [TextSpan[], TextSpan[]] {
  const text = runs.map(run => run.text).join("");
  const index = [...text.matchAll(/\./g)].find(match => /\d/.test(text[match.index - 1] ?? "") || /\d/.test(text[match.index + 1] ?? ""))?.index;
  if (index === undefined) return [runs, []];
  const before: TextSpan[] = [], after: TextSpan[] = [];
  let offset = 0;
  for (const run of runs) {
    const cut = Math.max(0, Math.min(run.text.length, index - offset));
    if (cut > 0) before.push({ ...run, text: run.text.slice(0, cut) });
    if (cut < run.text.length) after.push({ ...run, text: run.text.slice(cut) });
    offset += run.text.length;
  }
  return [before, after];
}

/** All positions are unrotated page coordinates; the stored frame does not constrain content. */
export function planTableLayout(table: TableObject): TableLayout {
  const cached = layoutCache.get(table);
  if (cached) return cached;
  const style = nativeTextStyleFromObjectStyle(table.style);
  const noteStyle = { ...style, fontSizePx: style.fontSizePx * 0.9 };
  const padding = table.tableStyle.cellPaddingPx;
  const cellLines = table.rows.map((row, index) => row.cells.map(cell =>
    richTextLines(cell, index < table.headerRowCount && table.tableStyle.headerBold)));
  let y = table.y;
  const textBox = (value: TableRichText, top: number): TableTextBox => {
    const lines = richTextLines(value, false);
    const height = lines.length * noteStyle.fontSizePx * noteStyle.lineHeight;
    return { x: table.x, y: top, width: Math.max(0, ...lines.map(line => runWidth(line, noteStyle))), height,
      lines: lines.map((runs, index) => ({ baselineY: top + noteStyle.fontSizePx + index * noteStyle.fontSizePx * noteStyle.lineHeight,
        pieces: [{ runs, x: table.x, anchor: "start" as const }] })) };
  };
  const captionBox = table.caption ? textBox(table.caption, y) : undefined;
  if (captionBox) y += captionBox.height + 4;
  const bodyY = y;
  let x = table.x;
  const columns = table.columns.map((column, columnIndex) => {
    let widest = 0, pre = 0, post = 0;
    cellLines.forEach((row, rowIndex) => row[columnIndex].forEach(runs => {
      if (column.align === "decimal" && rowIndex >= table.headerRowCount) {
        const [before, after] = splitDecimal(runs);
        pre = Math.max(pre, runWidth(before, style));
        post = Math.max(post, runWidth(after, style));
      } else {
        widest = Math.max(widest, runWidth(runs, style));
      }
    }));
    const width = column.width.mode === "fixed" ? column.width.px
      : Math.ceil((Math.max(widest, pre + post) * 1.04 + 2 * padding.x) * 2) / 2;
    const inset = Math.max(0, (width - 2 * padding.x - pre - post) / 2);
    const result = { x, width, ...(column.align === "decimal" ? {
      decimalAnchorX: x + padding.x + inset + pre,
      decimalBlock: { insetLeft: inset, insetRight: inset, preWidth: pre, postWidth: post }
    } : {}) };
    x += width;
    return result;
  });
  const rows = cellLines.map(row => {
    const height = Math.max(...row.map(lines => lines.length)) * style.fontSizePx * style.lineHeight + 2 * padding.y;
    const result = { y, height };
    y += height;
    return result;
  });
  const bodyBox = { x: table.x, y: bodyY, width: x - table.x, height: y - bodyY };
  const cells = cellLines.flatMap((row, rowIndex) => row.map((lines, columnIndex) => {
    const column = columns[columnIndex];
    const align = table.columns[columnIndex].align;
    const box = { x: column.x, y: rows[rowIndex].y, width: column.width, height: rows[rowIndex].height };
    return { rowIndex, columnIndex, box, lines: lines.map((runs, lineIndex): TableLine => {
      const baselineY = box.y + padding.y + style.fontSizePx + lineIndex * style.fontSizePx * style.lineHeight;
      if (align === "decimal" && rowIndex >= table.headerRowCount) {
        const [before, after] = splitDecimal(runs);
        const pieces: TableLine["pieces"] = [{ runs: before, x: column.decimalAnchorX!, anchor: "end" }];
        if (after.length > 0) pieces.push({ runs: after, x: column.decimalAnchorX!, anchor: "start" });
        return { baselineY, pieces };
      }
      const centered = align === "center" || align === "decimal";
      return { baselineY, pieces: [{ runs,
        x: centered ? box.x + box.width / 2 : align === "right" ? box.x + box.width - padding.x : box.x + padding.x,
        anchor: centered ? "middle" : align === "right" ? "end" : "start" }] };
    }) };
  }));
  const rules: TableLayout["rules"] = [];
  const horizontalRule = (ruleY: number, pt: number) => rules.push({
    x1: bodyBox.x, y1: ruleY, x2: bodyBox.x + bodyBox.width, y2: ruleY, widthPx: pt * 4 / 3
  });
  if (table.tableStyle.preset === "grid") {
    for (const ruleY of [bodyY, ...rows.map(row => row.y + row.height)]) horizontalRule(ruleY, table.tableStyle.gridRulePt);
    for (const ruleX of [table.x, ...columns.map(column => column.x + column.width)]) {
      rules.push({ x1: ruleX, y1: bodyY, x2: ruleX, y2: y, widthPx: table.tableStyle.gridRulePt * 4 / 3 });
    }
  } else {
    horizontalRule(bodyY, table.tableStyle.topRulePt);
    if (table.headerRowCount > 0) {
      const header = rows[table.headerRowCount - 1];
      horizontalRule(header.y + header.height, table.tableStyle.headerRulePt);
    }
    horizontalRule(y, table.tableStyle.bottomRulePt);
  }
  const footnoteBoxes = table.footnotes.map(note => {
    const box = textBox(note, y + 4);
    y = box.y + box.height;
    return box;
  });
  const layout = { origin: { x: table.x, y: table.y },
    width: Math.max(bodyBox.width, captionBox?.width ?? 0, ...footnoteBoxes.map(box => box.width)),
    height: y - table.y, captionBox, bodyBox, footnoteBoxes, columns, rows, cells, rules };
  layoutCache.set(table, layout);
  return layout;
}

export function planTableObjectSvg(table: TableObject, layerIndex: number): PageSvgElementFragment {
  let layers = svgCache.get(table);
  const cached = layers?.get(layerIndex);
  if (cached) return cached;
  if (!layers) {
    layers = new Map();
    svgCache.set(table, layers);
  }
  // Only the root attributes depend on the layer; share the expensive cell fragments across layers.
  const existing = layers.values().next().value;
  if (existing) {
    const fragment = { ...existing, attrs: { ...existing.attrs, "data-layer-index": layerIndex } };
    layers.set(layerIndex, fragment);
    return fragment;
  }
  const layout = planTableLayout(table);
  const style = nativeTextStyleFromObjectStyle(table.style);
  const textElements = (lines: TableLine[], id: string, fontSizePx: number) => lines.flatMap((line, lineIndex) =>
    line.pieces.map((piece, pieceIndex) => {
      const key = `${id}-line-${lineIndex}-piece-${pieceIndex}`;
      const spans = textSpanLineFragments(piece.runs, 0, piece.x, 0).map((span, index) => ({
        ...span, key: `${key}-span-${index}`, attrs: { ...span.attrs, id: `${key}-span-${index}` },
        children: span.children.map((child, childIndex) => ({ ...child, key: `${key}-span-${index}-${childIndex}` }))
      }));
      return elementFragment("text", key, {
        id: key, x: piece.x, y: line.baselineY, "text-anchor": piece.anchor,
        "font-family": style.fontFamily, "font-size": fontSizePx, "font-weight": style.fontWeight,
        "font-style": style.fontStyle, "text-decoration": style.textDecoration,
        "letter-spacing": style.letterSpacingPx, fill: style.color
      }, spans);
    }));
  const fragment = elementFragment("g", `object-${table.id}`, objectAttributes(table, layerIndex, {
    id: `object-${table.id}`, transform: rotationTransform(table)
  }), [
    ...layout.rules.map((rule, index) => elementFragment("line", `${table.id}-rule-${index}`, {
      id: `${table.id}-rule-${index}`,
      x1: rule.x1, y1: rule.y1, x2: rule.x2, y2: rule.y2, stroke: style.color, "stroke-width": rule.widthPx, fill: "none"
    })),
    ...(layout.captionBox ? textElements(layout.captionBox.lines, `${table.id}-caption`, style.fontSizePx * 0.9) : []),
    ...layout.cells.flatMap(cell => textElements(cell.lines,
      tableCellElementId(table.id, table.rows[cell.rowIndex].id, table.columns[cell.columnIndex].id),
      style.fontSizePx)),
    ...layout.footnoteBoxes.flatMap((box, index) => textElements(box.lines, `${table.id}-footnote-${index}`, style.fontSizePx * 0.9))
  ]);
  layers.set(layerIndex, fragment);
  return fragment;
}

/** Includes fixed-column overflow and rule strokes, rotated around the SVG object's stored pivot. */
export function tableVisualBoundsForArrangement(table: TableObject): LayoutBounds {
  const cached = boundsCache.get(table);
  if (cached) return cached;
  const layout = planTableLayout(table);
  const style = nativeTextStyleFromObjectStyle(table.style);
  const boxes: LayoutBounds[] = [layout.bodyBox];
  const addLines = (lines: TableLine[], textStyle: NativeTextStyle) => {
    for (const line of lines) for (const piece of line.pieces) {
      const width = runWidth(piece.runs, textStyle);
      boxes.push({ x: piece.x - (piece.anchor === "end" ? width : piece.anchor === "middle" ? width / 2 : 0),
        y: line.baselineY - textStyle.fontSizePx, width, height: textStyle.fontSizePx * textStyle.lineHeight });
    }
  };
  layout.cells.forEach(cell => addLines(cell.lines, style));
  for (const box of [layout.captionBox, ...layout.footnoteBoxes]) {
    if (box) { boxes.push(box); addLines(box.lines, { ...style, fontSizePx: style.fontSizePx * 0.9 }); }
  }
  for (const rule of layout.rules) boxes.push({ x: rule.x1 - rule.widthPx / 2, y: rule.y1 - rule.widthPx / 2,
    width: rule.x2 - rule.x1 + rule.widthPx, height: rule.y2 - rule.y1 + rule.widthPx });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of boxes) for (const corner of [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
  ]) {
    const point = transformPointForObject(table, corner);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  boundsCache.set(table, bounds);
  return bounds;
}
