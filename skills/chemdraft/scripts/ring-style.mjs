#!/usr/bin/env node
// Nicolaou-style ring figures for any molecule: vivid ring fills, ring letters,
// H at ring-fusion stereocentres and Me labels, applied to a ChemDraft document.
// Plain Node (18+), no dependencies; paths go through node:path, so it runs on
// macOS, Linux and Windows. It edits document JSON only; ChemDraft itself does
// every depiction, render and chemistry check. See references/recipes.md, recipe 11.
//
//   node ring-style.mjs pubchem <dir> <name> <cid | compound name>
//   node ring-style.mjs style <dir> <name> [options.json]
//   node ring-style.mjs relayout <dir> <name>
//   node ring-style.mjs identity-jobs <dir> <name>
//   node ring-style.mjs check <dir> <name>
//
// Files in <dir>, by step:
//   pubchem       writes <name>-pubchem.json (CID, title, formula, SMILES, InChIKey,
//                 stereo counts) and <name>-job.json (the batch for `document`).
//   style         reads <name>-build.jsonl (the `document` stdout) and the document it
//                 names; writes <name>-carbon.json (true structure, methyls drawn CH3),
//                 <name>-nicolaou.json (the picture, methyls relabelled Me) and
//                 <name>-style.json (ring letters, colours, H and Me added, warnings).
//   relayout      rewrites <name>-job.json with the canonical SMILES in <name>-build.jsonl:
//                 the same molecule in another atom order, which `document` lays out anew.
//   identity-jobs reads <name>-render.jsonl (every `render-document` stdout line);
//                 writes <name>-identity-jobs.json (the batch for `analyze`).
//   check         reads <name>-pubchem.json, <name>-render.jsonl, <name>-identity.jsonl
//                 (the `analyze` stdout) and the rendered SVGs; prints and writes
//                 <name>-check.json. Exit 1 when an InChIKey or stereo count differs.
//
// Options (all optional), a JSON object:
//   convention  "walk" (default), "taxane", "steroid" or "morphinan"
//   letters     explicit letter map, {"A": selector, "B": selector, ...}, assigned in
//               the order given; overrides convention
//   start       selector for the ring a walk starts from (default: leftmost terminal ring)
//   rings       "core" (default: rings sharing atoms with another ring) or "all"
//   extra       "walk" letters core rings a convention leaves out, continuing the alphabet;
//               without it they are an error
//   rotate      [{"atom": "a54", "about": "a11", "degrees": 30}]: turn the substituent
//               that contains atom about its attachment atom (positive = clockwise on
//               the page) before styling, to clear a label collision
//   palette     ["#e53935", ...] fill colours, assigned in letter order
//   fillOpacity 0.9;  letterSizePx 20;  letterFont "Times New Roman, Times, serif"
//   fusionH     true;  methyls "ring" (default: Me on methyls bonded to lettered rings) or "none"
// A selector picks one ring by its chemistry; every given field must hold:
//   size, hetero ({"O": 1}; {} = carbocycle), aromatic, ringDoubleBonds (ring C=C/C=X
//   bonds outside aromatic rings), carbonyl (a ring carbon carries an exocyclic =O),
//   sharesBondWith / notSharesBondWith (letters already assigned), atoms (0-based SMILES
//   atom indices the ring contains), ringKey, optional (skip when nothing matches).
// A rule that matches no ring (unless optional) or several rings is an error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PALETTE = ["#e53935", "#fdd835", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa",
  "#00acc1", "#d81b60", "#7cb342", "#3949ab", "#ff7043", "#00897b"];
const DARK = "#1a1a1a";
const WHITE = "#ffffff";

// Literature ring letters, written as chemistry, not position. Rules run in order.
export const CONVENTIONS = {
  taxane: {
    A: { size: 6, hetero: {}, ringDoubleBonds: 1 },
    B: { size: 8 },
    C: { size: 6, hetero: {}, ringDoubleBonds: 0, sharesBondWith: ["B"] },
    D: { size: 4, hetero: { O: 1 }, optional: true }
  },
  steroid: {
    D: { size: 5, hetero: {} },
    C: { size: 6, sharesBondWith: ["D"] },
    B: { size: 6, sharesBondWith: ["C"], notSharesBondWith: ["D"] },
    A: { size: 6, sharesBondWith: ["B"], notSharesBondWith: ["C"] }
  },
  morphinan: {
    A: { size: 6, aromatic: true },
    B: { size: 6, hetero: {}, aromatic: false, sharesBondWith: ["A"] },
    C: { size: 6, hetero: {}, aromatic: false, notSharesBondWith: ["A"] },
    D: { size: 6, hetero: { N: 1 } },
    E: { size: 5, hetero: { O: 1 }, optional: true }
  }
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/;
const fail = (message) => { throw new Error(message); };

/** Read UTF-8 or UTF-16 text (PowerShell 5.1 redirection writes UTF-16 LE). */
export function readText(file) {
  const bytes = fs.readFileSync(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}
const readJson = (file) => JSON.parse(readText(file));
const readLines = (file) => readText(file).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line.trim()));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1));

// ---------- geometry ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function pointSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const inBox = (p, r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
const corners = (r) => [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
/** Gap between an axis-aligned box and a segment (0 when they touch). */
export function boxSegment(r, a, b) {
  if (inBox(a, r) || inBox(b, r)) return 0;
  const k = corners(r);
  for (let i = 0; i < 4; i++) if (segmentsCross(a, b, k[i], k[(i + 1) % 4])) return 0;
  return Math.min(...k.map((c) => pointSegment(c, a, b)),
    ...[a, b].map((p) => Math.hypot(Math.max(r.x0 - p.x, 0, p.x - r.x1), Math.max(r.y0 - p.y, 0, p.y - r.y1))));
}
/** Gap between two axis-aligned boxes (0 when they overlap). */
export function boxBox(r, s) {
  return Math.hypot(Math.max(s.x0 - r.x1, r.x0 - s.x1, 0), Math.max(s.y0 - r.y1, r.y0 - s.y1, 0));
}
function inPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const area = (poly) => Math.abs(poly.reduce((s, a, i) => { const b = poly[(i + 1) % poly.length]; return s + a.x * b.y - b.x * a.y; }, 0)) / 2;

// ---------- colour ----------
function luminance(hex) {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function blendOnWhite(hex, opacity) {
  const n = hex.replace("#", "");
  return "#" + [0, 2, 4].map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * opacity + 255 * (1 - opacity)).toString(16).padStart(2, "0")).join("");
}
/** White on a dark fill, near-black on a light one, judged by the fill's relative
 * luminance as drawn (blended on white at its opacity). Below 0.34 white reads better
 * on saturated colours: red, blue, green, purple and magenta take white. */
export function letterColour(fill, opacity = 1) {
  return luminance(blendOnWhite(fill, opacity)) < 0.34 ? WHITE : DARK;
}

// ---------- molecule model ----------
const VALENCE = { C: 4, N: 3, O: 2, S: 2, P: 3, B: 3, Si: 4 };
const ORDER = { single: 1, double: 2, triple: 3, aromatic: 1.5 };

export function model(mol, buildMol) {
  const atoms = new Map(mol.atoms.map((a) => [a.id, a]));
  const input = new Map((buildMol?.atoms ?? []).map((a) => [a.id, a.inputAtomIndex]));
  const bondsOf = new Map(mol.atoms.map((a) => [a.id, []]));
  for (const b of mol.bonds) { bondsOf.get(b.fromAtomId)?.push(b); bondsOf.get(b.toAtomId)?.push(b); }
  const other = (b, id) => b.fromAtomId === id ? b.toAtomId : b.fromAtomId;
  const neighbours = (id) => (bondsOf.get(id) ?? []).map((b) => other(b, id));
  const implicitH = (id) => {
    const a = atoms.get(id), v = VALENCE[a.element];
    if (v === undefined || (a.formalCharge ?? 0) !== 0) return 0;
    const used = (bondsOf.get(id) ?? []).reduce((s, b) => s + (ORDER[b.order] ?? 1), 0);
    return Math.max(0, Math.round(v - used));
  };
  return { mol, atoms, input, bondsOf, other, neighbours, implicitH };
}

/** Order a ring's atoms around the cycle from its bonds. */
function cycle(m, ring) {
  const bonds = ring.bondIds.map((id) => m.mol.bonds.find((b) => b.id === id));
  const order = [ring.atomIds[0]];
  while (order.length < ring.atomIds.length) {
    const last = order[order.length - 1], prev = order[order.length - 2];
    const next = bonds.map((b) => b.fromAtomId === last ? b.toAtomId : b.toAtomId === last ? b.fromAtomId : null)
      .find((id) => id && id !== prev && !order.includes(id));
    if (!next) break;
    order.push(next);
  }
  return order;
}

export function describeRings(m, buildRings) {
  const rings = buildRings.map((r) => ({ ...r }));
  for (const r of rings) {
    r.order = cycle(m, r);
    r.poly = r.order.map((id) => ({ x: m.atoms.get(id).x, y: m.atoms.get(id).y }));
    r.center = { x: r.poly.reduce((s, p) => s + p.x, 0) / r.poly.length, y: r.poly.reduce((s, p) => s + p.y, 0) / r.poly.length };
    r.area = area(r.poly);
    r.hetero = {};
    for (const id of r.atomIds) { const e = m.atoms.get(id).element; if (e !== "C") r.hetero[e] = (r.hetero[e] ?? 0) + 1; }
    r.inputAtoms = r.atomIds.map((id) => m.input.get(id)).filter((i) => i !== undefined);
  }
  const ringAtoms = new Set(rings.flatMap((r) => r.atomIds));
  for (const r of rings) {
    const bonds = r.bondIds.map((id) => m.mol.bonds.find((b) => b.id === id));
    r.aromatic = bonds.every((b) => b.order === "aromatic") || (r.size === 6 && r.atomIds.every((id) => {
      const doubles = m.bondsOf.get(id).filter((b) => b.order === "double" || b.order === "aromatic");
      return doubles.length === 1 && ringAtoms.has(m.other(doubles[0], id));
    }));
  }
  const aromaticBonds = new Set(rings.filter((r) => r.aromatic).flatMap((r) => r.bondIds));
  for (const r of rings) {
    r.ringDoubleBonds = r.bondIds.filter((id) => !aromaticBonds.has(id) &&
      ["double", "triple"].includes(m.mol.bonds.find((b) => b.id === id).order)).length;
    r.carbonyl = r.atomIds.some((id) => m.atoms.get(id).element === "C" && m.bondsOf.get(id).some((b) =>
      b.order === "double" && m.atoms.get(m.other(b, id)).element === "O" && !ringAtoms.has(m.other(b, id))));
  }
  for (const r of rings) {
    r.touching = rings.filter((s) => s !== r && s.atomIds.some((id) => r.atomIds.includes(id)));
    r.fused = rings.filter((s) => s !== r && s.bondIds.some((id) => r.bondIds.includes(id)));
  }
  return rings;
}

const label = (r) => `${r.size}-ring${Object.keys(r.hetero).length ? " (" + Object.entries(r.hetero).map(([e, n]) => e + n).join(" ") + ")" : " (carbocycle)"}` +
  `${r.aromatic ? ", aromatic" : ""}, ${r.ringDoubleBonds} ring double bond(s)${r.carbonyl ? ", carbonyl" : ""}` +
  `, centre (${r.center.x.toFixed(0)}, ${r.center.y.toFixed(0)}), SMILES atoms [${r.inputAtoms.join(",")}]`;

function matches(r, sel, letterOf) {
  if (sel.size !== undefined && r.size !== sel.size) return false;
  if (sel.ringKey !== undefined && r.ringKey !== sel.ringKey) return false;
  if (sel.aromatic !== undefined && r.aromatic !== sel.aromatic) return false;
  if (sel.carbonyl !== undefined && r.carbonyl !== sel.carbonyl) return false;
  if (sel.ringDoubleBonds !== undefined && r.ringDoubleBonds !== sel.ringDoubleBonds) return false;
  if (sel.hetero !== undefined) {
    const want = Object.entries(sel.hetero), have = Object.entries(r.hetero);
    if (want.length !== have.length || want.some(([e, n]) => r.hetero[e] !== n)) return false;
  }
  if (sel.atoms && !sel.atoms.every((i) => r.inputAtoms.includes(i))) return false;
  const fusedTo = (L) => { const s = letterOf.get(L); if (!s) fail(`Selector refers to ring ${L}, which has no letter yet`); return r.fused.includes(s); };
  if (sel.sharesBondWith && !sel.sharesBondWith.every(fusedTo)) return false;
  if (sel.notSharesBondWith && sel.notSharesBondWith.some(fusedTo)) return false;
  return true;
}

/** Components of rings that share atoms, ordered left to right. */
function systems(rings) {
  const seen = new Set(), out = [];
  for (const r of rings) {
    if (seen.has(r)) continue;
    const group = [r]; seen.add(r);
    for (let i = 0; i < group.length; i++) for (const s of group[i].touching) if (!seen.has(s)) { seen.add(s); group.push(s); }
    out.push(group);
  }
  return out.sort((a, b) => Math.min(...a.map((r) => r.center.x)) - Math.min(...b.map((r) => r.center.x)));
}
const byPosition = (a, b) => a.center.x - b.center.x || a.center.y - b.center.y;

/** Breadth-first walk over rings sharing atoms, from a start ring; ties broken left to right, then top to bottom. */
function walk(pool, start) {
  const order = [];
  for (const group of systems(pool)) {
    let first = start && group.includes(start) ? start : null;
    if (!first) {
      const terminals = group.filter((r) => r.touching.filter((s) => group.includes(s)).length === 1);
      first = [...(terminals.length ? terminals : group)].sort(byPosition)[0];
    }
    const queue = [first], seen = new Set([first]);
    while (queue.length) {
      const r = queue.shift(); order.push(r);
      for (const s of r.touching.filter((s) => group.includes(s) && !seen.has(s)).sort(byPosition)) { seen.add(s); queue.push(s); }
    }
  }
  return order;
}

/** Decide which rings get letters and which letter each gets. */
export function assignLetters(rings, options = {}) {
  const notes = [];
  const core = systems(rings).filter((g) => g.length > 1).flat();
  let pool = options.rings === "all" ? rings : core;
  if (!pool.length) { pool = rings; notes.push("No fused, bridged or spiro ring system: every ring is lettered."); }
  const letterOf = new Map();
  const rules = options.letters ?? (options.convention && options.convention !== "walk" ? CONVENTIONS[options.convention] : null);
  if (options.convention && options.convention !== "walk" && !options.letters && !rules) {
    fail(`Unknown convention "${options.convention}"; use walk, ${Object.keys(CONVENTIONS).join(", ")} or an explicit letters map`);
  }
  if (rules) {
    for (const [L, sel] of Object.entries(rules)) {
      if (!/^[A-Z]$/.test(L)) fail(`Ring letter "${L}" must be one capital letter`);
      const hits = pool.filter((r) => ![...letterOf.values()].includes(r) && matches(r, sel, letterOf));
      if (hits.length === 1) { letterOf.set(L, hits[0]); continue; }
      if (!hits.length && sel.optional) { notes.push(`Ring ${L}: no ring matches ${JSON.stringify(sel)}; skipped (optional).`); continue; }
      fail(`Ring ${L}: ${hits.length ? "several rings match" : "no ring matches"} ${JSON.stringify(sel)}.\n` +
        (hits.length ? hits : pool.filter((r) => ![...letterOf.values()].includes(r))).map((r) => `  candidate: ${label(r)}`).join("\n") +
        "\nGive an explicit letters map (the atoms field takes SMILES atom indices) or a narrower selector.");
    }
    const left = pool.filter((r) => ![...letterOf.values()].includes(r) && core.includes(r));
    if (left.length && options.extra !== "walk") {
      fail(`The letter rules leave ${left.length} core ring(s) unlettered:\n${left.map((r) => `  ${label(r)}`).join("\n")}\n` +
        'Add rules for them, or set "extra": "walk" to letter them after the convention by walk order.');
    }
    if (left.length) {
      let code = Math.max(...[...letterOf.keys()].map((L) => L.charCodeAt(0)), 64);
      for (const r of walk(left, null)) letterOf.set(String.fromCharCode(++code), r);
      notes.push(`${left.length} ring(s) outside the convention were lettered by walk order; check the literature.`);
    }
  } else {
    let start = null;
    if (options.start) {
      const hits = pool.filter((r) => matches(r, options.start, letterOf));
      if (hits.length !== 1) fail(`start: ${hits.length} rings match ${JSON.stringify(options.start)}; it must match exactly one.\n` +
        pool.map((r) => `  candidate: ${label(r)}`).join("\n"));
      start = hits[0];
    }
    const order = walk(pool, start);
    if (order.length > 26) fail(`${order.length} rings to letter; give an explicit letters map for more than 26`);
    order.forEach((r, i) => letterOf.set(String.fromCharCode(65 + i), r));
    notes.push(`Letters follow a breadth-first walk over rings sharing atoms, from ${start ? "the start ring" : "the leftmost terminal ring"}; ties go left to right, then top to bottom.`);
  }
  return { letters: [...letterOf.entries()].sort((a, b) => a[0].localeCompare(b[0])), notes };
}

/** Palette colours in letter order; a ring never shares a colour with a ring it touches. */
export function assignColours(letters, palette = PALETTE) {
  const colour = new Map(), used = new Map();
  for (const [, r] of letters) {
    const banned = new Set(r.touching.map((s) => colour.get(s)).filter(Boolean));
    const free = palette.filter((c) => !banned.has(c));
    if (!free.length) fail("The palette is too small to keep touching rings apart");
    const pick = free.find((c) => !used.has(c)) ?? [...free].sort((a, b) => used.get(a) - used.get(b))[0];
    colour.set(r, pick); used.set(pick, (used.get(pick) ?? 0) + 1);
  }
  return colour;
}

// ---------- predicted label boxes (letter placement only; check uses the real SVG) ----------
// The renderer centres symbol+H on the atom ("OH", "CH" then a subscript 3), or, when
// the bonds leave to the right, centres the symbol and writes H to its left ("HO").
function labelBox(m, a, meIds, carbonLabels, size) {
  const me = meIds.has(a.id);
  if (!me && a.element === "C" && !carbonLabels.has(a.id)) return null;
  const symbol = me ? "Me" : a.element, h = me ? 0 : m.implicitH(a.id);
  const w = (text, f = size) => [...text].reduce((s, ch) => s + charWidth(ch) * f, 0);
  const digits = h > 1 ? w(String(h), 0.72 * size) : 0;
  const right = m.neighbours(a.id).reduce((s, id) => s + m.atoms.get(id).x - a.x, 0) > 0;
  const box = { y0: a.y - 0.4 * size, y1: a.y + (digits ? 0.62 : 0.4) * size };
  if (h && right) Object.assign(box, { x0: a.x - w(symbol) / 2 - w("H") - digits, x1: a.x + w(symbol) / 2 });
  else { const main = w(symbol + (h ? "H" : "")); Object.assign(box, { x0: a.x - main / 2, x1: a.x + main / 2 + digits }); }
  return box;
}
const letterHalfWidth = (L, f) => ("MW".includes(L) ? 0.47 : "IJ".includes(L) ? 0.25 : 0.38) * f;

function placeLetters(m, letters, opts, meIds, carbonLabels) {
  const bondLength = m.mol.style?.bondLengthPx ?? 28;
  const gap = m.mol.style?.multipleBondGapPx ?? 4.8;
  const labelSize = m.mol.style?.atomLabelFontSizePx ?? 15;
  const segments = m.mol.bonds.map((b) => ({
    a: m.atoms.get(b.fromAtomId), b: m.atoms.get(b.toAtomId),
    r: b.order === "double" || b.order === "triple" ? gap + 1.5 : b.display?.bondStyle ? 3 : 1.5
  }));
  const labels = m.mol.atoms.map((a) => labelBox(m, a, meIds, carbonLabels, labelSize)).filter(Boolean);
  const placed = [], out = [];
  for (const [L, r] of letters) {
    const smaller = letters.map(([, s]) => s).filter((s) => s !== r && s.area < r.area);
    const xs = r.poly.map((p) => p.x), ys = r.poly.map((p) => p.y);
    const near = { x0: Math.min(...xs) - bondLength, x1: Math.max(...xs) + bondLength, y0: Math.min(...ys) - bondLength, y1: Math.max(...ys) + bondLength };
    const segs = segments.filter((s) => boxSegment(near, s.a, s.b) === 0);
    const boxes = [...labels, ...placed].filter((b) => boxBox(near, b) === 0);
    // Inside the ring and outside any smaller ring drawn over it; a bridged ring squeezed
    // under others falls back to anywhere inside its own outline.
    const search = (excludeSmaller) => {
      let best = null;
      for (let f = opts.letterSizePx; f >= 10 && !(best && best.clear >= 1.5); f--) {
        best = null;
        const hw = letterHalfWidth(L, f), hh = 0.36 * f;
        for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
          const p = { x, y };
          if (!inPolygon(p, r.poly) || (excludeSmaller && smaller.some((s) => inPolygon(p, s.poly)))) continue;
          const box = { x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
          if (!corners(box).every((c) => inPolygon(c, r.poly))) continue;
          let clear = Infinity;
          for (const s of segs) clear = Math.min(clear, boxSegment(box, s.a, s.b) - s.r);
          for (const b of boxes) clear = Math.min(clear, boxBox(box, b));
          const score = Math.min(clear, 4), off = dist(p, r.center);
          if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && off < best.off)) best = { x, y, f, clear, score, off, box };
        }
      }
      return best;
    };
    let best = search(true);
    if (!best || best.clear < 0) {
      const loose = search(false);
      if (loose && (!best || loose.clear > best.clear)) best = { ...loose, overlapping: true };
    }
    if (!best) fail(`Ring ${L} is drawn too small or too crowded for a letter inside it; see recipe 11 for a different layout`);
    placed.push({ x0: best.box.x0 - 2, x1: best.box.x1 + 2, y0: best.box.y0 - 2, y1: best.box.y1 + 2 });
    out.push({ letter: L, ring: r, x: best.x, y: best.y, size: best.f, clearancePx: Number(best.clear.toFixed(1)), overlapping: !!best.overlapping });
  }
  return out;
}

// ---------- edits ----------
function rotateGroups(m, rotations = []) {
  for (const { atom, about, degrees } of rotations) {
    if (!m.atoms.has(atom) || !m.atoms.has(about) || !m.neighbours(about).includes(atom)) fail(`rotate: ${about} and ${atom} are not bonded atoms`);
    const group = new Set([atom]), queue = [atom];
    while (queue.length) for (const n of m.neighbours(queue.shift())) {
      if (n !== about && !group.has(n)) { group.add(n); queue.push(n); }
    }
    // A ring through `about` would pull it in via another path.
    if ([...group].some((id) => id !== atom && m.neighbours(id).includes(about))) fail(`rotate: ${atom} is in a ring with ${about}; only a substituent can be turned`);
    const c = m.atoms.get(about), t = degrees * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    for (const id of group) {
      const a = m.atoms.get(id), dx = a.x - c.x, dy = a.y - c.y;
      a.x = c.x + dx * cos - dy * sin; a.y = c.y + dx * sin + dy * cos;
    }
  }
}

function addFusionH(m, letters, carbonLabels, warnings) {
  const lettered = letters.map(([, r]) => r);
  const added = [];
  const bondLength = m.mol.style?.bondLengthPx ?? 28, size = m.mol.style?.atomLabelFontSizePx ?? 15;
  // Obstacles use the wider CH3 labels of the carbon copy, so the H clears both copies.
  const boxes = m.mol.atoms.map((a) => labelBox(m, a, new Set(), carbonLabels, size)).filter(Boolean);
  const angle = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
  const apart = (s, t) => Math.abs(Math.atan2(Math.sin(s - t), Math.cos(s - t)));
  const sites = [];
  for (const a of [...m.mol.atoms]) {
    const mine = lettered.filter((r) => r.atomIds.includes(a.id));
    if (a.element !== "C" || mine.length < 2 || m.implicitH(a.id) !== 1 || m.neighbours(a.id).length !== 3) continue;
    const stereo = m.bondsOf.get(a.id).filter((b) => b.fromAtomId === a.id && (b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed"));
    if (stereo.length !== 1) {
      warnings.push(`Fusion CH ${a.id}: ${stereo.length} stereo bonds start there, so no H was drawn; look at it.`);
      continue;
    }
    // Start along the fused bond, away from the neighbour that shares both rings (else the
    // widest gap), then turn up to 37.5 degrees either way, staying 35 degrees clear of every
    // bond at the atom, to the direction and length whose H label is furthest from labels and bonds.
    const nbs = m.neighbours(a.id).map((id) => m.atoms.get(id));
    const partners = nbs.filter((n) => mine.filter((r) => r.atomIds.includes(n.id)).length >= 2);
    let base;
    if (partners.length === 1) base = angle(partners[0], a);
    else {
      const angles = nbs.map((n) => angle(a, n)).sort((x, y) => x - y);
      let widest = -1;
      angles.forEach((t, i) => { const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI; if (next - t > widest) { widest = next - t; base = t + widest / 2; } });
    }
    const segs = m.mol.bonds.filter((b) => b.fromAtomId !== a.id && b.toAtomId !== a.id).map((b) => [m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId)]);
    const candidates = [];
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) for (const length of [0.8, 0.68]) {
      const t = base + k * Math.PI / 24;
      if (nbs.some((n) => apart(t, angle(a, n)) < (35 * Math.PI) / 180)) continue;
      const p = { x: a.x + Math.cos(t) * length * bondLength, y: a.y + Math.sin(t) * length * bondLength };
      if (lettered.some((r) => inPolygon(p, r.poly))) continue;
      candidates.push({ p, box: { x0: p.x - 0.36 * size, x1: p.x + 0.36 * size, y0: p.y - 0.42 * size, y1: p.y + 0.42 * size } });
    }
    if (!candidates.length) { warnings.push(`Fusion CH ${a.id}: no room for an H, so none was drawn; look at it.`); continue; }
    sites.push({ a, stereo: stereo[0], segs, candidates });
  }
  // Two passes: the second re-places every H knowing where all the others went.
  const score = (site, c, others) => {
    let clear = Infinity;
    for (const b of [...boxes, ...others]) clear = Math.min(clear, boxBox(c.box, b), boxSegment(b, site.a, c.p));
    for (const [u, v] of site.segs) clear = Math.min(clear, boxSegment(c.box, u, v));
    return Math.min(clear, 3);
  };
  for (let pass = 0; pass < 2; pass++) for (const site of sites) {
    const others = sites.filter((o) => o !== site && o.best).map((o) => o.best.box);
    let best = null, bestScore = -Infinity;
    for (const c of site.candidates) { const v = score(site, c, others); if (v > bestScore + 1e-9) { best = c; bestScore = v; } }
    site.best = best;
  }
  for (const { a, stereo, best } of sites) {
    const h = { id: `h_${a.id}`, element: "H", x: best.p.x, y: best.p.y, formalCharge: 0 };
    const style = stereo.display.bondStyle === "wedge" ? "hashed" : "wedge";
    const bond = { id: `b_h_${a.id}`, fromAtomId: a.id, toAtomId: h.id, order: "single", display: { bondStyle: style } };
    m.mol.atoms.push(h); m.mol.bonds.push(bond);
    m.atoms.set(h.id, h); m.bondsOf.set(h.id, [bond]); m.bondsOf.get(a.id).push(bond);
    const moved = stereo.display.bondStyle;
    delete stereo.display.bondStyle;
    added.push({ atom: a.id, smilesAtom: m.input.get(a.id), h: h.id, style, movedFrom: `${moved} ${stereo.id}` });
  }
  return added;
}

function ringMethyls(m, letters) {
  const ringAtoms = new Set(letters.flatMap(([, r]) => r.atomIds));
  return m.mol.atoms.filter((a) => {
    const bonds = m.bondsOf.get(a.id);
    return a.element === "C" && (a.formalCharge ?? 0) === 0 && bonds.length === 1 && bonds[0].order === "single" &&
      ringAtoms.has(m.other(bonds[0], a.id));
  });
}

export function style(doc, buildMol, options = {}) {
  const opts = { fillOpacity: 0.9, letterSizePx: 20, letterFont: "Times New Roman, Times, serif", fusionH: true, methyls: "ring", ...options };
  const page = doc.pages.find((p) => p.objects.some((o) => o.id === buildMol.objectId)) ?? doc.pages[0];
  const mol = page.objects.find((o) => o.id === buildMol.objectId) ?? page.objects.find((o) => o.type === "molecule");
  if (!mol) fail("No molecule in the document");
  mol.style ??= {};
  const m = model(mol, buildMol);
  rotateGroups(m, opts.rotate);
  const rings = describeRings(m, buildMol.rings ?? fail("The build output has no rings"));
  if (!rings.length) fail("The molecule has no rings to style");
  const { letters, notes } = assignLetters(rings, opts);
  const colours = assignColours(letters, opts.palette);
  const warnings = [];
  const methyls = opts.methyls === "none" ? [] : ringMethyls(m, letters);
  const carbonLabels = new Set(methyls.map((a) => a.id));
  const hydrogens = opts.fusionH ? addFusionH(m, letters, carbonLabels, warnings) : [];
  mol.style.atomLabelBackgroundColor = "transparent";
  mol.style.ringStyles = { ...(mol.style.ringStyles ?? {}) };
  for (const [, r] of letters) mol.style.ringStyles[r.ringKey] = { fillColor: colours.get(r), fillOpacity: opts.fillOpacity };
  // A bridged ring can be drawn around another lettered ring (morphine's B around D). Ring
  // fills are painted in an order the document cannot set, so the outer ring's fill becomes a
  // closed path under the molecule, and the inner ring's own fill shows on top of it.
  const outer = letters.filter(([, r]) => letters.some(([, s]) => s !== r && s.area < r.area && inPolygon(s.center, r.poly)));
  for (const [L, r] of outer) {
    mol.style.ringStyles[r.ringKey] = { fillColor: "none" };
    const xs = r.poly.map((p) => p.x), ys = r.poly.map((p) => p.y);
    page.objects.splice(page.objects.indexOf(mol), 0, { id: `ring-fill-${L}`, type: "graphic", graphicKind: "path", rotation: 0,
      x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      style: { fillColor: colours.get(r), fillOpacity: opts.fillOpacity, strokeColor: colours.get(r), strokeWidth: 0.5, strokeOpacity: 0 },
      data: { artPathKind: "polyline", pathClosed: true, pathNodes: r.poly.map((p) => ({ point: { x: p.x, y: p.y } })) } });
    notes.push(`Ring ${L} is drawn around another lettered ring, so its fill is a path object under the molecule (ring-fill-${L}); it does not follow the atoms if they are moved in the app.`);
  }
  mol.style.atomLabelShowTerminalCarbonsByAtomId = { ...(mol.style.atomLabelShowTerminalCarbonsByAtomId ?? {}), ...Object.fromEntries(methyls.map((a) => [a.id, true])) };

  const variant = (meIds, carbon) => {
    const copy = structuredClone(doc);
    const cpage = copy.pages[doc.pages.indexOf(page)];
    const cmol = cpage.objects.find((o) => o.id === mol.id);
    const placed = placeLetters(model(cmol, buildMol), letters.map(([L, r]) => [L, r]), opts, meIds, carbon);
    for (const p of placed) {
      const fill = colours.get(p.ring), w = 1.4 * p.size;
      cpage.objects.push({ id: `ring-letter-${p.letter}`, type: "text", text: p.letter, spans: [], rotation: 0,
        x: p.x - w / 2, y: p.y - 0.64 * p.size, width: w, height: 1.25 * p.size,
        style: { fontSizePx: p.size, fontWeight: 700, fontStyle: "italic", textAlign: "center", fontFamily: opts.letterFont, color: letterColour(fill, opts.fillOpacity) } });
    }
    for (const a of cmol.atoms) if (meIds.has(a.id)) a.element = "Me";
    return { copy, placed };
  };
  const carbon = variant(new Set(), carbonLabels);
  const picture = variant(new Set(methyls.map((a) => a.id)), new Set());
  for (const p of [...carbon.placed, ...picture.placed]) {
    if (p.size < 14) warnings.push(`Ring ${p.letter}: letter shrunk to ${p.size}px to fit; check it reads.`);
    if (p.clearancePx < 0) warnings.push(`Ring ${p.letter}: the letter touches a bond or label even at ${p.size}px; look at it.`);
    if (p.overlapping) warnings.push(`Ring ${p.letter}: the ring is drawn under another ring, so its letter sits where the two overlap; check it reads as ${p.letter}'s.`);
  }
  const report = {
    letters: letters.map(([L, r]) => ({ letter: L, ringKey: r.ringKey, ring: label(r), fill: colours.get(r), letterColour: letterColour(colours.get(r), opts.fillOpacity),
      letterAt: picture.placed.find((p) => p.letter === L) && (({ x, y, size, clearancePx }) => ({ x, y, size, clearancePx }))(picture.placed.find((p) => p.letter === L)) })),
    unlettered: rings.filter((r) => !letters.some(([, s]) => s === r)).map(label),
    fusionHydrogens: hydrogens,
    methyls: methyls.map((a) => ({ atom: a.id, smilesAtom: m.input.get(a.id) })),
    notes, warnings: [...new Set(warnings)]
  };
  return { carbon: carbon.copy, picture: picture.copy, report };
}

// ---------- SVG check ----------
const attr = (tag, name) => { const v = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return v ? v[1] : undefined; };
const charWidth = (ch) => /[A-Z]/.test(ch) ? ("MW".includes(ch) ? 0.83 : "I".includes(ch) ? 0.28 : 0.67) : /[0-9]/.test(ch) ? 0.56 : "il".includes(ch) ? 0.22 : 0.5;
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Approximate boxes of every atom label and text object, plus bond strokes, from a rendered SVG. */
export function svgGeometry(svg) {
  const labels = [], texts = [], strokes = [];
  const groupRe = /<g\s((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/g>/g;
  for (const g of svg.matchAll(groupRe)) {
    const open = " " + g[1];
    const atomLabel = attr(open, "data-atom-label");
    const t = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/.exec(attr(open, "transform") ?? "");
    if (atomLabel === undefined || !t) continue;
    const ox = Number(t[1]), oy = Number(t[2]), size = Number(attr(open, "font-size") ?? 15);
    const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const run of g[2].matchAll(/<text\s((?:[^>"]|"[^"]*")*)>([^<]*)<\/text>/g)) {
      const tag = " " + run[1];
      if (attr(tag, "aria-hidden") === "true") continue;
      const fs_ = Number(attr(tag, "font-size") ?? size), text = decode(run[2]);
      const w = [...text].reduce((s, ch) => s + charWidth(ch) * fs_, 0);
      const x = ox + Number(attr(tag, "x") ?? 0), anchor = attr(tag, "text-anchor") ?? "start";
      const dyRaw = attr(tag, "dy") ?? "0", dy = dyRaw.endsWith("em") ? parseFloat(dyRaw) * fs_ : Number(dyRaw);
      const base = oy + Number(attr(tag, "y") ?? 0) + dy;
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      box.x0 = Math.min(box.x0, x0); box.x1 = Math.max(box.x1, x0 + w);
      box.y0 = Math.min(box.y0, base - 0.72 * fs_); box.y1 = Math.max(box.y1, base + 0.02 * fs_);
    }
    if (box.x0 < Infinity) labels.push({ text: atomLabel, x: ox, y: oy, box });
  }
  // Text objects (ring letters, captions): <text data-object-type="text" x y font-size text-anchor>.
  for (const t of svg.matchAll(/<text\s((?:[^>"]|"[^"]*")*data-object-type="text"(?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/text>/g)) {
    const tag = " " + t[1], text = decode(t[2].replace(/<[^>]*>/g, "")).trim();
    if (!text) continue;
    const size = Number(attr(tag, "font-size") ?? 16), x = Number(attr(tag, "x") ?? 0), y = Number(attr(tag, "y") ?? 0);
    const anchor = attr(tag, "text-anchor") ?? "start";
    const w = [...text].reduce((s, ch) => s + charWidth(ch) * size, 0) * 0.92;
    const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    texts.push({ text, id: attr(tag, "data-object-id"), box: { x0, x1: x0 + w, y0: y - 0.66 * size, y1: y } });
  }
  for (const l of svg.matchAll(/<line\s((?:[^>"]|"[^"]*")*)\/?>/g)) {
    const tag = " " + l[1], id = attr(tag, "data-bond-id");
    if (!id) continue;
    strokes.push({ bond: id, a: { x: Number(attr(tag, "x1")), y: Number(attr(tag, "y1")) }, b: { x: Number(attr(tag, "x2")), y: Number(attr(tag, "y2")) }, w: Number(attr(tag, "stroke-width") ?? 2) });
  }
  for (const p of svg.matchAll(/<polygon\s((?:[^>"]|"[^"]*")*)\/?>/g)) {
    const tag = " " + p[1], id = attr(tag, "data-bond-id");
    const pts = (attr(tag, "points") ?? "").trim().split(/\s+/).map((xy) => xy.split(",").map(Number)).map(([x, y]) => ({ x, y }));
    for (let i = 0; i + 1 < pts.length; i++) strokes.push({ bond: id ?? "stereo", a: pts[i], b: pts[i + 1], w: 0 });
  }
  return { labels, texts, strokes };
}

/** Label pairs that nearly touch, and text objects that sit on a label or a bond. */
export function collisions(svg, nearPx = 1.5) {
  const { labels, texts, strokes } = svgGeometry(svg);
  const out = [];
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const g = boxBox(labels[i].box, labels[j].box);
    if (g < nearPx) out.push({ kind: "label-label", a: labels[i], b: labels[j], gapPx: Number(g.toFixed(1)) });
  }
  for (const t of texts) {
    for (const l of labels) { const g = boxBox(t.box, l.box); if (g < nearPx) out.push({ kind: "text-label", a: t, b: l, gapPx: Number(g.toFixed(1)) }); }
    let worst = null;
    for (const s of strokes) { const g = boxSegment(t.box, s.a, s.b) - s.w / 2; if (g < 1 && (!worst || g < worst.g)) worst = { s, g }; }
    if (worst) out.push({ kind: "text-bond", a: t, b: { text: `bond ${worst.s.bond}` }, gapPx: Number(Math.max(0, worst.g).toFixed(1)) });
  }
  return out;
}

// ---------- commands ----------
async function pubchem(dir, name, query) {
  const props = "Title,MolecularFormula,SMILES,InChIKey,DefinedAtomStereoCount,UndefinedAtomStereoCount,DefinedBondStereoCount,UndefinedBondStereoCount";
  const where = /^\d+$/.test(query) ? `cid/${query}` : `name/${encodeURIComponent(query)}`;
  const response = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${where}/property/${props}/JSON`);
  if (!response.ok) fail(`PubChem lookup of "${query}" failed: HTTP ${response.status} ${await response.text()}`);
  const records = (await response.json()).PropertyTable?.Properties ?? [];
  if (!records.length) fail(`PubChem has no compound for "${query}"`);
  const p = records[0];
  if (!p.SMILES || !p.InChIKey) fail(`PubChem record ${p.CID} lacks SMILES or InChIKey`);
  if (records.length > 1) console.log(`PubChem returned ${records.length} compounds for "${query}" (CIDs ${records.map((r) => r.CID).join(", ")}); using the first. Confirm it is the one meant.`);
  writeJson(path.join(dir, `${name}-pubchem.json`), p);
  writeJson(path.join(dir, `${name}-job.json`), [{ name, smiles: p.SMILES }]);
  console.log(JSON.stringify({ cid: p.CID, title: p.Title, formula: p.MolecularFormula, inchiKey: p.InChIKey,
    definedAtomStereo: p.DefinedAtomStereoCount, undefinedAtomStereo: p.UndefinedAtomStereoCount, smiles: p.SMILES }));
}

function runStyle(dir, name, optionsFile) {
  const lines = readLines(path.join(dir, `${name}-build.jsonl`));
  const build = lines.find((l) => l.name === name) ?? lines[0] ?? fail(`No build output in ${name}-build.jsonl`);
  if (!build.ok) fail(`The document build failed: ${JSON.stringify(build.error ?? build.warnings)}`);
  const docFile = build.document && fs.existsSync(build.document) ? build.document : path.join(dir, `${name}.json`);
  const options = optionsFile ? readJson(optionsFile) : {};
  const { carbon, picture, report } = style(readJson(docFile), build.molecules[0], options);
  writeJson(path.join(dir, `${name}-carbon.json`), carbon);
  writeJson(path.join(dir, `${name}-nicolaou.json`), picture);
  writeJson(path.join(dir, `${name}-style.json`), report);
  for (const l of report.letters) console.log(`${l.letter}  ${l.fill} (${l.letterColour === WHITE ? "white" : "dark"} letter, ${l.letterAt.size}px)  ${l.ring}`);
  if (report.unlettered.length) console.log(`Not lettered or filled: ${report.unlettered.length} ring(s) outside the core`);
  console.log(`Fusion H added: ${report.fusionHydrogens.length}; ring methyls (Me in the picture, CH3 in -carbon): ${report.methyls.length}`);
  for (const n of [...report.notes, ...report.warnings]) console.log(n);
  console.log(`Wrote ${name}-carbon.json, ${name}-nicolaou.json and ${name}-style.json`);
}

function relayout(dir, name) {
  const lines = readLines(path.join(dir, `${name}-build.jsonl`));
  const build = lines.find((l) => l.name === name) ?? lines[0] ?? fail(`No build output in ${name}-build.jsonl`);
  if (!build.canonicalSmiles) fail("The build output has no canonicalSmiles");
  writeJson(path.join(dir, `${name}-job.json`), [{ name, smiles: build.canonicalSmiles }]);
  console.log(`Wrote ${name}-job.json with ChemDraft's canonical SMILES (same molecule, new atom order): ${build.canonicalSmiles}`);
}

function renderLines(dir, name) {
  const lines = readLines(path.join(dir, `${name}-render.jsonl`));
  if (!lines.length) fail(`No render-document output in ${name}-render.jsonl`);
  return lines.map((l, i) => ({ ...l, picture: /-nicolaou\.json$/i.test(l.document ?? ""), job: `${i + 1}-${String(l.name ?? "render").replace(/[^A-Za-z0-9 _-]/g, "-")}`.slice(0, 100) }));
}

function identityJobs(dir, name) {
  const jobs = [];
  for (const l of renderLines(dir, name)) {
    if (!l.ok) fail(`render-document failed for ${l.document}: ${JSON.stringify(l.error ?? l.warnings)}`);
    l.molecules.forEach((mol, k) => jobs.push({ name: `${l.job}${l.molecules.length > 1 ? "-" + k : ""}`,
      // In the picture each Me is a placeholder atom (*); put the carbon back to compare.
      smiles: l.picture ? mol.canonicalSmiles.replace(/\[\*\]|\*/g, "C") : mol.canonicalSmiles }));
  }
  writeJson(path.join(dir, `${name}-identity-jobs.json`), jobs);
  console.log(`Wrote ${name}-identity-jobs.json with ${jobs.length} job(s)`);
}

function check(dir, name) {
  const ref = readJson(path.join(dir, `${name}-pubchem.json`));
  const renders = renderLines(dir, name);
  const analyses = new Map(readLines(path.join(dir, `${name}-identity.jsonl`)).map((r) => [r.name, r]));
  const failures = [], result = { cid: ref.CID, title: ref.Title, pubchemInChIKey: ref.InChIKey, renders: [], collisions: [] };
  for (const l of renders) {
    l.molecules.forEach((mol, k) => {
      const job = `${l.job}${l.molecules.length > 1 ? "-" + k : ""}`, a = analyses.get(job);
      const key = a?.summary?.inchiKey?.value ?? null;
      const row = { document: path.basename(l.document ?? ""), files: (l.files ?? []).map((f) => path.basename(f)), picture: l.picture,
        inchiKey: key, inchiKeyMatches: key === ref.InChIKey, formula: a?.summary?.formula?.value ?? null };
      if (!l.picture) Object.assign(row, { stereoCenters: mol.stereoCenters, unspecifiedStereoCenters: mol.unspecifiedStereoCenters, unspecifiedDoubleBonds: mol.unspecifiedDoubleBonds });
      result.renders.push(row);
      if (!a) failures.push(`${job}: no analyze result; run identity-jobs and analyze again`);
      else if (key !== ref.InChIKey) failures.push(`${row.document} -> ${row.files.join(", ")}: InChIKey ${key} differs from PubChem ${ref.InChIKey}`);
      if (!l.picture && ref.DefinedAtomStereoCount !== undefined && (mol.stereoCenters !== ref.DefinedAtomStereoCount || mol.unspecifiedStereoCenters !== ref.UndefinedAtomStereoCount)) {
        failures.push(`${row.files.join(", ")}: stereocentres ${mol.stereoCenters} specified / ${mol.unspecifiedStereoCenters} unspecified; PubChem ${ref.DefinedAtomStereoCount} / ${ref.UndefinedAtomStereoCount}`);
      }
    });
    // Name each label by its atom id and the atom it hangs from, ready for options.rotate.
    const doc = l.document && fs.existsSync(l.document) ? readJson(l.document) : null;
    const mol = doc?.pages.flatMap((p) => p.objects).find((o) => o.type === "molecule");
    const atomAt = (x, y) => mol?.atoms.find((a) => Math.hypot(a.x - x, a.y - y) < 1);
    const bondedTo = (id) => mol.bonds.flatMap((b) => b.fromAtomId === id ? [b.toAtomId] : b.toAtomId === id ? [b.fromAtomId] : []);
    for (const file of (l.files ?? []).filter((f) => f.toLowerCase().endsWith(".svg"))) {
      for (const c of collisions(readText(file))) {
        const where = (x) => {
          if (x.x === undefined) return x.id ?? x.text;
          const a = atomAt(x.x, x.y);
          return `${x.text}${a ? ` ${a.id} (bonded to ${bondedTo(a.id).join(", ")})` : ""} at (${x.x.toFixed(0)}, ${x.y.toFixed(0)})`;
        };
        result.collisions.push({ svg: path.basename(file), kind: c.kind, a: where(c.a), b: where(c.b), gapPx: c.gapPx });
      }
    }
  }
  writeJson(path.join(dir, `${name}-check.json`), { ...result, failures });
  console.log(`PubChem CID ${ref.CID} ${ref.Title}: InChIKey ${ref.InChIKey}, stereocentres ${ref.DefinedAtomStereoCount} defined / ${ref.UndefinedAtomStereoCount} undefined`);
  for (const r of result.renders) {
    console.log(`${r.inchiKeyMatches ? "same" : "DIFFERENT"} InChIKey  ${r.files.join(", ")}${r.picture ? " (picture; Me read as C)" : `  stereo ${r.stereoCenters} specified / ${r.unspecifiedStereoCenters} unspecified, ${r.unspecifiedDoubleBonds} unspecified double bonds`}`);
  }
  for (const c of result.collisions) console.log(`near-touch ${c.kind} in ${c.svg}: ${c.a} vs ${c.b}, gap ${c.gapPx}px`);
  if (result.collisions.length) console.log("Fix a label pair by turning one substituent about its attachment atom (options.rotate), restyle, render and check again; move a ring letter with letterSizePx or by fixing the label it meets.");
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length ? "Identity check FAILED: do not deliver." : "Identity check passed. Now look at the PNGs at full size.");
  if (failures.length) process.exitCode = 1;
}

// Compare real paths: the skill is usually reached through a symlink or junction, and
// Windows paths differ in case.
const realPath = (file) => {
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* keep the given path */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
};
const isMain = process.argv[1] && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));
if (isMain) {
  const [command, dir, name, extra] = process.argv.slice(2);
  try {
    if (!command || !dir || !name) fail("Usage: node ring-style.mjs <pubchem|style|relayout|identity-jobs|check> <dir> <name> [cid-or-name | options.json]");
    if (!NAME.test(name)) fail(`Name "${name}" must match ${NAME}`);
    if (!fs.existsSync(dir)) fail(`No directory ${dir}`);
    if (command === "pubchem") await pubchem(dir, name, extra ?? fail("pubchem needs a CID or a compound name"));
    else if (command === "style") runStyle(dir, name, extra);
    else if (command === "relayout") relayout(dir, name);
    else if (command === "identity-jobs") identityJobs(dir, name);
    else if (command === "check") check(dir, name);
    else fail(`Unknown command ${command}`);
  } catch (error) {
    console.error(`ring-style: ${error.message}`);
    process.exitCode = 2;
  }
}
