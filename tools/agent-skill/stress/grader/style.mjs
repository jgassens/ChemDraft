import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
}
function attributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1]] = match[2] ?? match[3];
  for (const rule of (attrs.style ?? '').split(';')) {
    const colon = rule.indexOf(':');
    if (colon !== -1) attrs[rule.slice(0, colon).trim()] = rule.slice(colon + 1).trim();
  }
  return attrs;
}
const numbers = (text) => (text?.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
const identity = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function transform(text = '') {
  let matrix = identity;
  for (const match of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const p = numbers(match[2]);
    let next = identity;
    if (match[1] === 'matrix') next = p;
    if (match[1] === 'translate') next = [1, 0, 0, 1, p[0], p[1] ?? 0];
    if (match[1] === 'scale') next = [p[0], 0, 0, p[1] ?? p[0], 0, 0];
    if (match[1] === 'rotate') {
      const a = p[0] * Math.PI / 180;
      next = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    }
    if (match[1] === 'skewX') next = [1, 0, Math.tan(p[0] * Math.PI/180), 1, 0, 0];
    if (match[1] === 'skewY') next = [1, Math.tan(p[0] * Math.PI/180), 0, 1, 0, 0];
    matrix = multiply(matrix, next);
  }
  return matrix;
}
function length(x, y, matrix) { return Math.hypot(matrix[0]*x + matrix[2]*y, matrix[1]*x + matrix[3]*y); }
function point(x, y, matrix) { return [matrix[0]*x + matrix[2]*y + matrix[4], matrix[1]*x + matrix[3]*y + matrix[5]]; }
function nearest([x, y], atoms) {
  let found, distance = Infinity;
  for (const atom of atoms) {
    const next = Math.hypot(x - atom[0], y - atom[1]);
    if (next < distance) { found = atom; distance = next; }
  }
  return found;
}

function drawnBondLength(segment, atoms) {
  const from = nearest(segment.slice(0, 2), atoms), to = nearest(segment.slice(2), atoms);
  return from && to && from !== to ? Math.hypot(from[0] - to[0], from[1] - to[1]) : null;
}
function groupFor(groups, object) {
  let group = groups.get(object);
  if (!group) {
    group = { lengths: [], primarySegments: [], atoms: [], widths: [] };
    groups.set(object, group);
  }
  return group;
}

/** SVG exporter marks bonds with data-bond-id and native-bond-line, including paths in
 * sketch mode. Exclude text glyphs, arrow shafts, atom halos, hit targets and effect copies.
 * Report each molecule separately so inconsistent scales within one grid are detectable. */
export function measureSvg(svg) {
  const stack = [{ matrix: identity, width: 1, stroke: 'none', object: 'image', ignored: false }], groups = new Map();
  for (const match of svg.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    const tag = match[0], name = tag.match(/^<\/?([\w:-]+)/)[1];
    if (tag.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = attributes(tag), parent = stack.at(-1);
    const frame = { matrix: multiply(parent.matrix, transform(attrs.transform)),
      width: attrs['stroke-width'] === undefined ? parent.width : Number.parseFloat(attrs['stroke-width']),
      stroke: attrs.stroke ?? parent.stroke,
      object: attrs['data-object-id'] ?? parent.object,
      ignored: parent.ignored || ['defs', 'clipPath', 'mask', 'filter', 'metadata'].includes(name) ||
        attrs['data-molecule-effect-source'] === 'true' || attrs['data-molecule-effect'] !== undefined };
    if (attrs['data-object-type'] === 'molecule' && !frame.ignored) groupFor(groups, frame.object);
    if (!frame.ignored && attrs['data-atom-id'] !== undefined && Number.isFinite(Number(attrs.cx)) && Number.isFinite(Number(attrs.cy))) {
      groupFor(groups, frame.object).atoms.push(point(Number(attrs.cx), Number(attrs.cy), frame.matrix));
    }
    // Labeled atoms have no circle marker; their group transform is their atom center.
    if (!frame.ignored && attrs['data-atom-label'] !== undefined) {
      groupFor(groups, frame.object).atoms.push(point(0, 0, frame.matrix));
    }
    const isBond = attrs['data-bond-id'] !== undefined || /\bnative-bond-line\b/.test(attrs.class ?? '');
    if (isBond && !frame.ignored && ['line', 'path'].includes(name) &&
        !/hit-target|hover-decorator|bond-hash/.test(attrs.class ?? '') && frame.stroke !== 'none') {
      const segments = [];
      if (name === 'line') segments.push([Number(attrs.x1), Number(attrs.y1), Number(attrs.x2), Number(attrs.y2)]);
      else {
        // Native bond paths use M/L (or relative m/l/h/v) straight segments. Curves are
        // unmeasurable rather than approximated as bonds.
        let x = 0, y = 0, command = '';
        const tokens = attrs.d?.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
        for (let i = 0; i < tokens.length;) {
          if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];
          if (!/[MmLlHhVv]/.test(command) || i >= tokens.length) break;
          const relative = command === command.toLowerCase();
          const oldX = x, oldY = y;
          if (/[Hh]/.test(command)) x = Number(tokens[i++]) + (relative ? x : 0);
          else if (/[Vv]/.test(command)) y = Number(tokens[i++]) + (relative ? y : 0);
          else { x = Number(tokens[i++]) + (relative ? x : 0); y = Number(tokens[i++]) + (relative ? y : 0); }
          if (!/[Mm]/.test(command)) segments.push([oldX, oldY, x, y]);
          else command = relative ? 'l' : 'L';
        }
      }
      const group = groupFor(groups, frame.object);
      for (const [x1, y1, x2, y2] of segments) {
        const size = length(x2-x1, y2-y1, frame.matrix);
        if (Number.isFinite(size) && size > 0) {
          group.lengths.push(size);
          // Secondary double-bond strokes are intentionally short. Primary ink can
          // also end at a label halo, so defer measuring it to atom centers below.
          if (attrs['data-bond-segment'] !== 'secondary') {
            const from = point(x1, y1, frame.matrix), to = point(x2, y2, frame.matrix);
            group.primarySegments.push([...from, ...to]);
          }
        }
      }
      const scaleX = length(1, 0, frame.matrix), scaleY = length(0, 1, frame.matrix);
      // Anisotropic scaling makes effective line width depend on orientation.
      if (Math.abs(scaleX-scaleY) > 0.001 || Math.abs(frame.matrix[0]*frame.matrix[2]+frame.matrix[1]*frame.matrix[3]) > 0.001) {
        group.unmeasurable = 'non-uniform SVG transform';
      }
      if (frame.width > 0) group.widths.push(frame.width * (attrs['vector-effect'] === 'non-scaling-stroke' ? 1 : scaleX));
      groups.set(frame.object, group);
    }
    if (!tag.endsWith('/>')) stack.push(frame);
  }
  return [...groups].map(([object, group]) => {
    // Exported atom circles and label transforms identify true atom positions. Use
    // primary bond endpoints snapped to those positions, not visible ink lengths:
    // label knockouts shorten N/O/NH bonds and secondary double lines by design.
    const corrected = group.primarySegments.map((segment) => drawnBondLength(segment, group.atoms)).filter((value) => value !== null);
    return { object, bondLength: median(corrected.length ? corrected : group.primarySegments.map((segment) => Math.hypot(segment[2] - segment[0], segment[3] - segment[1]))), strokeWidth: median(group.widths),
      segments: group.lengths.length, ...(group.unmeasurable ? { unmeasurable: group.unmeasurable } : {}) };
  });
}

export async function checkStyle(images) {
  const measurements = [], unmeasurable = [];
  const svgs = images.filter((file) => /\.svg$/i.test(file));
  for (const file of svgs) {
    const groups = measureSvg(await readFile(file, 'utf8'));
    if (!groups.length) unmeasurable.push({ file, reason: 'SVG has no measurable bond segments' });
    for (const group of groups) {
      if (!group.bondLength || !group.strokeWidth || group.unmeasurable) unmeasurable.push({ file, reason: group.unmeasurable ?? 'Missing bond length/stroke width' });
      else measurements.push({ file, ...group });
    }
  }
  // Retained SVG/PNG pairs share their basename in runner outputs. Do not guess which
  // options produced an unmatched PNG, including spectra or unrelated raster images.
  for (const file of images.filter((file) => /\.png$/i.test(file))) {
    if (!svgs.some((svg) => basename(svg, '.svg') === basename(file, '.png'))) {
      unmeasurable.push({ file, reason: 'PNG has no matching retained SVG; unmeasurable' });
    }
  }
  const spread = (key) => measurements.length ? Math.max(...measurements.map((m) => m[key])) / Math.min(...measurements.map((m) => m[key])) - 1 : null;
  const bondLengthDifference = spread('bondLength'), strokeWidthDifference = spread('strokeWidth');
  return { pass: measurements.length > 0 && unmeasurable.length === 0 && bondLengthDifference <= 0.05 + 1e-10 && strokeWidthDifference <= 0.05 + 1e-10,
    detail: { measurements, unmeasurable, bondLengthDifference, strokeWidthDifference, tolerance: 0.05 } };
}
