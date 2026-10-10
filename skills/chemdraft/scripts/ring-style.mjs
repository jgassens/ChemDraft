#!/usr/bin/env node
// Nicolaou-style ring figures for any molecule: vivid ring fills, ring letters,
// H at ring-fusion stereocentres and Me labels, applied to a ChemDraft document.
// Plain Node (18+), no dependencies; paths go through node:path, and the one child
// process (the ChemDraft CLI) is started with this Node and an argument list, never a
// shell, so it runs on macOS, Linux and Windows. It edits document JSON only; ChemDraft
// itself does every depiction, render and chemistry check. See references/recipes.md,
// recipe 11.
//
//   node ring-style.mjs pubchem <dir> <name> <cid | compound name>
//   node ring-style.mjs style <dir> <name> [options.json] --checkout <ChemDraft checkout>
//   node ring-style.mjs relayout <dir> <name>
//   node ring-style.mjs identity-jobs <dir> <name>
//   node ring-style.mjs check <dir> <name>
//   node ring-style.mjs --help
//
// Files in <dir>, by step:
//   pubchem       writes <name>-pubchem.json (CID, title, formula, SMILES, InChIKey,
//                 stereo counts), <name>-pubchem.sdf (PubChem's 2D drawing of the record)
//                 and <name>-job.json (the batch for `document`).
//   style         reads <name>-build.jsonl (the `document` stdout), the document it names and
//                 <name>-pubchem.sdf if present; writes <name>-carbon.json (true structure,
//                 methyls drawn CH3), <name>-nicolaou.json (the picture, methyls relabelled
//                 Me) and <name>-style.json (layout, moves, ring letters, colours, H and Me
//                 added, warnings). Before styling it
//                   1. compares layouts: ChemDraft's build, ChemDraft's layout of the canonical
//                      SMILES, and PubChem's 2D record (atoms matched to the document's, wedges
//                      re-drawn to keep every stereocentre), scored on bond crossings, bonds,
//                      atoms and labels on fills not their own, fill overlap, clashes and
//                      stretched bonds; the build stays unless another is clearly cleaner;
//                   2. moves every substituent off the filled rings (rule: no substituent atom,
//                      bond or label inside a filled ring), turning or mirroring it about its
//                      attachment atom with bond lengths kept, never onto an atom or across a
//                      bond;
//                   3. turns substituents up to 60 degrees where a label touches another label,
//                      a bond or a fusion H.
//                 Every new layout, every move (rotate turns included) and every fusion H must
//                 read, by render-document in the --checkout, as the same molecule (canonical
//                 SMILES; with explicit H, the standard InChIKey) with the same specified and
//                 unspecified stereocentre counts as the build's own drawing; a change that does
//                 not is undone and reported. What cannot be cleared is reported by name, and a
//                 label left on a fill is drawn white or near-black by that fill's luminance.
//   relayout      rewrites <name>-job.json with the canonical SMILES in <name>-build.jsonl:
//                 the same molecule in another atom order, which `document` lays out anew.
//   identity-jobs reads <name>-render.jsonl (every `render-document` stdout line);
//                 writes <name>-identity-jobs.json (the batch for `analyze`).
//   check         reads <name>-pubchem.json, <name>-render.jsonl, <name>-identity.jsonl
//                 (the `analyze` stdout), <name>-build.jsonl, <name>-style.json, the rendered
//                 documents and SVGs; prints and writes <name>-check.json. Lists labels that
//                 nearly touch (label, ring letter or bond), or says there are none. Exit 1 when an
//                 InChIKey or stereo count differs, or when a figure check fails with a FAILED list.
//   --help        prints this text.
//
// Figure checks (LIMITS): a figure that fails one is not finished. Each lettered ring against a
// regular polygon of its size and mean side (area ratio >= 0.75, smallest interior angle >= 0.6 of
// the regular angle, outline not crossing itself); no plain bond over 1.3x and no wedge or hash over
// 1.3x the median bond length; no ring letter under 14 px or missing; no lettered ring more than 40%
// under another lettered ring's fill; no fusion CH stereocentre left without its H.
//
// Options (all optional), a JSON object; with none, the options file may be omitted:
//   convention  "walk" (default), "taxane", "steroid" or "morphinan"
//   letters     explicit letter map, {"A": selector, "B": selector, ...}, assigned in
//               the order given; overrides convention
//   start       selector for the ring a walk starts from (default: the first terminal ring by
//               rank; a terminal ring shares atoms with exactly one other lettered ring; rank is
//               aromatic first, then larger, then more heteroatoms, then canonical atom rank)
//   rings       "core" (default: rings sharing atoms with another ring) or "all"
//   extra       "walk" letters core rings a convention leaves out, continuing the alphabet;
//               without it they are an error
//   layout      "search" (default: the build unless another scores more than 6 lower), or force
//               one: "build", "canonical" (ChemDraft's layout of the canonical SMILES) or
//               "pubchem" (PubChem's 2D record); a forced layout is still checked by render-document
//   declutter   true (default); false skips step 3
//   rotate      [{"atom": "a54", "about": "a11", "degrees": 30}]: turn the substituent
//               that contains atom about its attachment atom (positive = clockwise on
//               the page) before steps 2 and 3; checked like every move (locally, then by
//               render-document) and undone and reported if the stereochemistry changes
//   palette     ["#e53935", ...] fill colours, assigned in letter order
//   fillOpacity 0.9;  letterSizePx 20;  letterFont "Times New Roman, Times, serif"
//   fusionH     true;  methyls "ring" (default: Me on methyls bonded to lettered rings) or "none"
// A selector picks one ring by its chemistry; every given field must hold:
//   size, hetero ({"O": 1}; {} = carbocycle), aromatic, ringDoubleBonds (ring C=C/C=X
//   bonds outside aromatic rings), carbonyl (a ring carbon carries an exocyclic =O),
//   sharesBondWith / notSharesBondWith (letters already assigned), atoms (0-based SMILES
//   atom indices the ring contains), ringKey, optional (skip when nothing matches).
// A rule that matches no ring (unless optional) or several rings is an error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
/** Parse JSON, naming the file (and line) when it is not valid. */
function parseIn(text, where) {
  try { return JSON.parse(text); } catch (error) { return fail(`${where} is not valid JSON: ${error.message}`); }
}
const readJson = (file) => parseIn(readText(file), file);
const readLines = (file) => readText(file).split(/\r?\n/).map((line, i) => [line.trim(), i])
  .filter(([line]) => line.startsWith("{")).map(([line, i]) => parseIn(line, `${file} line ${i + 1}`));
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
  const ranks = canonicalRanks(m);
  for (const r of rings) {
    r.touching = rings.filter((s) => s !== r && s.atomIds.some((id) => r.atomIds.includes(id)));
    r.fused = rings.filter((s) => s !== r && s.bondIds.some((id) => r.bondIds.includes(id)));
    // Walk order, by chemistry and topology only: aromatic first, then the larger ring, then more
    // heteroatoms, then the ring's canonical atom ranks (lowest first).
    r.rank = [r.aromatic ? 0 : 1, -r.size, -Object.values(r.hetero).reduce((s, n) => s + n, 0),
      ...r.atomIds.map((id) => ranks.get(id)).sort((a, b) => a - b)];
  }
  return rings;
}

/** A canonical rank for every heavy atom from the molecular graph alone: element, charge, heavy
 * degree and hydrogen count, refined over neighbours until the classes stop splitting (extended
 * connectivity). Coordinates never enter it, so a rotated or mirrored drawing ranks the same; SMILES
 * atom order only separates atoms the graph cannot tell apart (symmetry-equivalent ones). */
export function canonicalRanks(m) {
  const isH = (id) => m.atoms.get(id).element === "H";
  const ids = m.mol.atoms.filter((a) => a.element !== "H").map((a) => a.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const nbs = ids.map((id) => m.neighbours(id).filter((n) => !isH(n)));
  const hs = ids.map((id) => m.implicitH(id) + m.neighbours(id).filter(isH).length);
  const classes = (keys) => { const u = [...new Set(keys)].sort(); const at = new Map(u.map((k, i) => [k, i])); return keys.map((k) => at.get(k)); };
  let rank = classes(ids.map((id, i) => { const a = m.atoms.get(id); return `${a.element}|${a.formalCharge ?? 0}|${nbs[i].length}|${hs[i]}`; }));
  for (;;) {
    const next = classes(ids.map((id, i) => `${String(rank[i]).padStart(6, "0")}(${nbs[i].map((n) => rank[index.get(n)]).sort((a, b) => a - b).join(",")})`));
    if (new Set(next).size === new Set(rank).size) break;
    rank = next;
  }
  const smilesAt = (id) => m.input.get(id) ?? Infinity;
  const order = ids.map((id, i) => ({ id, r: rank[i] }))
    .sort((a, b) => a.r - b.r || smilesAt(a.id) - smilesAt(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(order.map((x, i) => [x.id, i]));
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

/** Rank order of two rings (see describeRings): chemistry and topology, never position. */
const byRank = (a, b) => { for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) { const d = (a.rank[i] ?? -1) - (b.rank[i] ?? -1); if (d) return d; } return 0; };

/** Components of rings that share atoms, the one holding the first-ranked ring first. */
function systems(rings) {
  const seen = new Set(), out = [];
  for (const r of rings) {
    if (seen.has(r)) continue;
    const group = [r]; seen.add(r);
    for (let i = 0; i < group.length; i++) for (const s of group[i].touching) if (!seen.has(s)) { seen.add(s); group.push(s); }
    out.push(group.sort(byRank));
  }
  return out.sort((a, b) => byRank(a[0], b[0]));
}

/** Breadth-first walk over rings sharing atoms. It starts at the given ring, else at a terminal ring
 * (one sharing atoms with exactly one other ring of the pool), the first by rank; from each ring it
 * goes on to rings sharing a bond before rings sharing only atoms, each set in rank order. Nothing
 * in it reads coordinates, so the letters do not depend on how the molecule is turned on the page. */
function walk(pool, start) {
  const order = [];
  for (const group of systems(pool)) {
    let first = start && group.includes(start) ? start : null;
    if (!first) {
      const terminals = group.filter((r) => r.touching.filter((s) => group.includes(s)).length === 1);
      first = (terminals.length ? terminals : group)[0];
    }
    const queue = [first], seen = new Set([first]);
    while (queue.length) {
      const r = queue.shift(); order.push(r);
      const next = r.touching.filter((s) => group.includes(s) && !seen.has(s))
        .sort((a, b) => (r.fused.includes(a) ? 0 : 1) - (r.fused.includes(b) ? 0 : 1) || byRank(a, b));
      for (const s of next) { seen.add(s); queue.push(s); }
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
    notes.push(`Letters follow a breadth-first walk over rings sharing atoms, from ${start ? "the start ring" : "a terminal ring chosen by chemistry"}; ties go by chemistry and canonical atom rank, never by position on the page.`);
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
    // No room even at 10 px: no letter, and the figure check fails it (the ring is a sliver or buried).
    if (!best) { out.push({ letter: L, ring: r, missing: true }); continue; }
    placed.push({ x0: best.box.x0 - 2, x1: best.box.x1 + 2, y0: best.box.y0 - 2, y1: best.box.y1 + 2 });
    out.push({ letter: L, ring: r, x: best.x, y: best.y, size: best.f, clearancePx: Number(best.clear.toFixed(1)), overlapping: !!best.overlapping });
  }
  return out;
}

// ---------- edits ----------
/** The user's `rotate` turns, one at a time. Each goes through `check` like an automatic move:
 * one it rejects is undone and reported; a kept one carries undo/redo snapshots so the
 * render-document check of the chosen layout covers it too. */
function rotateGroups(m, rotations = [], check = () => null) {
  const moved = [], reverted = [];
  for (const { atom, about, degrees } of rotations) {
    if (!m.atoms.has(atom) || !m.atoms.has(about) || !m.neighbours(about).includes(atom)) fail(`rotate: ${about} and ${atom} are not bonded atoms`);
    const group = new Set([atom]), queue = [atom];
    while (queue.length) for (const n of m.neighbours(queue.shift())) {
      if (n !== about && !group.has(n)) { group.add(n); queue.push(n); }
    }
    // A ring through `about` would pull it in via another path.
    if ([...group].some((id) => id !== atom && m.neighbours(id).includes(about))) fail(`rotate: ${atom} is in a ring with ${about}; only a substituent can be turned`);
    const g = { attach: about, root: atom, atoms: group, bonds: m.mol.bonds.filter((b) => group.has(b.fromAtomId) || group.has(b.toAtomId)) };
    const s = snapshot(m, g);
    place(m, g, s, "turn", degrees);
    const move = { group: `${atom} on ${about}${group.size > 1 ? ` (${group.size} atoms)` : ""}`, attach: about, root: atom, move: `turned ${degrees} degrees (rotate option)`, was: [], user: true };
    const why = check(m);
    if (why) { restore(m, s); reverted.push({ ...move, reason: why }); continue; }
    moved.push({ ...move, left: [], undo: s, redo: snapshot(m, g) });
  }
  return { moved, reverted };
}

function addFusionH(m, letters, carbonLabels, warnings, plan = false) {
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
    // The H bond never crosses a bond, and neither it nor its label sits on a fill.
    const tryAngles = (angles) => {
      for (const t of angles) for (const length of [0.8, 0.68]) {
        if (nbs.some((n) => apart(t, angle(a, n)) < (35 * Math.PI) / 180)) continue;
        const p = { x: a.x + Math.cos(t) * length * bondLength, y: a.y + Math.sin(t) * length * bondLength };
        const box = { x0: p.x - 0.36 * size, x1: p.x + 0.36 * size, y0: p.y - 0.42 * size, y1: p.y + 0.42 * size };
        if (lettered.some((r) => inPolygon(p, r.poly) || segmentInFill(a, p, r.poly) || boxInFill(box, r.poly))) continue;
        if (segs.some(([u, v]) => segmentsCross(a, p, u, v))) continue;
        candidates.push({ p, box });
      }
    };
    tryAngles([0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5].map((k) => base + k * Math.PI / 24));
    // An atom in three rings, or one whose fused-bond direction is blocked: any open direction,
    // but only with a wider margin, since such an H sits away from where a reader looks for it.
    let need = 1;
    if (!candidates.length) { tryAngles([...Array(72).keys()].map((k) => k * Math.PI / 36)); need = 4; }
    if (!candidates.length) { warnings.push(`Fusion CH ${a.id}: no room for an H, so none was drawn; look at it.`); continue; }
    sites.push({ a, stereo: stereo[0], segs, candidates, need });
  }
  // Two passes: the second re-places every H knowing where all the others went.
  const score = (site, c, others) => {
    let clear = Infinity;
    for (const b of boxes) clear = Math.min(clear, boxBox(c.box, b), boxSegment(b, site.a, c.p));
    // Two H labels side by side read as "HH": keep them a label's width further apart.
    for (const b of others) clear = Math.min(clear, boxBox(c.box, b) - 0.6 * size, boxSegment(b, site.a, c.p));
    for (const [u, v] of site.segs) clear = Math.min(clear, boxSegment(c.box, u, v));
    return Math.min(clear, site.need + 2);
  };
  const placeAll = () => {
    for (const site of sites) {
      const others = sites.filter((o) => o !== site && o.best).map((o) => o.best.box);
      let best = null, bestScore = -Infinity;
      for (const c of site.candidates) { const v = score(site, c, others); if (v > bestScore + 1e-9) { best = c; bestScore = v; } }
      site.best = best; site.clear = bestScore;
    }
  };
  placeAll(); placeAll();
  // A dry run reports where each H would go, before any is dropped for crowding.
  if (plan) return sites.map((x) => ({ atom: x.a.id, p: x.best.p, box: x.best.box }));
  // An H whose label would touch a bond or another label is not drawn; its atom keeps the ring wedge.
  for (;;) {
    const worst = [...sites].filter((x) => x.clear < x.need).sort((x, y) => x.clear - x.need - (y.clear - y.need))[0];
    if (!worst) break;
    sites.splice(sites.indexOf(worst), 1);
    warnings.push(`Fusion CH ${worst.a.id}: an H there would touch a bond or label, so none was drawn and its ring ${worst.stereo.display.bondStyle} stays; look at it.`);
    placeAll();
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

/** Take a fusion H back out: its atom and bond go, and the ring bond gets its wedge or hash back. */
function takeFusionH(m, h) {
  const atom = m.atoms.get(h.h), bond = m.mol.bonds.find((b) => b.id === `b_h_${h.atom}`);
  const [style, stereoId] = h.movedFrom.split(" "), stereo = m.mol.bonds.find((b) => b.id === stereoId);
  m.mol.atoms.splice(m.mol.atoms.indexOf(atom), 1); m.mol.bonds.splice(m.mol.bonds.indexOf(bond), 1);
  m.atoms.delete(atom.id); m.bondsOf.delete(atom.id);
  m.bondsOf.set(h.atom, m.bondsOf.get(h.atom).filter((b) => b !== bond));
  stereo.display = { ...(stereo.display ?? {}), bondStyle: style };
  return { atom, bond, stereo };
}
function putFusionH(m, h, { atom, bond, stereo }) {
  m.mol.atoms.push(atom); m.mol.bonds.push(bond);
  m.atoms.set(atom.id, atom); m.bondsOf.set(atom.id, [bond]); m.bondsOf.get(h.atom).push(bond);
  delete stereo.display.bondStyle;
}
/** Fusion H moves a wedge or hash, so render-document checks them like any move: all at once,
 * then one by one if that fails. One it rejects is taken out (its ring bond keeps the stereo
 * bond) and reported. Returns the H that stay. */
function verifyFusionH(m, added, verify, warnings, undone) {
  if (!added.length || !verify()) return added;
  const parts = added.map((h) => takeFusionH(m, h));
  const kept = [];
  added.forEach((h, i) => {
    putFusionH(m, h, parts[i]);
    const why = verify();
    if (!why) { kept.push(h); return; }
    takeFusionH(m, h);
    undone.push({ ...h, reason: `render-document ${why}` });
    warnings.push(`UNDONE: fusion H at ${h.atom}: render-document ${why}; its ring ${h.movedFrom.split(" ")[0]} stays.`);
  });
  return kept;
}

/** Labels that stay on a filled ring that is not their own (a substituent the fill rule could not
 * clear) are drawn white or near-black by that fill's luminance, the rule the ring letters use. No
 * box, halo or label background is added. Returns {atom, label, on, colour} per label coloured. */
function colourLabelsOnFills(cm, letters, colours, opacity, meIds, carbonLabels) {
  const size = cm.mol.style?.atomLabelFontSizePx ?? 15;
  const fills = fillsOf(cm, letters), out = [];
  for (const a of cm.mol.atoms) {
    const box = labelBox(cm, a, meIds, carbonLabels, size);
    if (!box) continue;
    const centre = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    const on = fills.filter((f) => !f.atoms.has(a.id) && (depth(a, f.poly) > TOL || boxInFill(box, f.poly)))
      .sort((f, g) => depth(centre, g.poly) - depth(centre, f.poly))[0];
    if (!on) continue;
    const colour = letterColour(colours.get(on.r), opacity);
    cm.mol.style.atomLabelColors = { ...(cm.mol.style.atomLabelColors ?? {}), [a.id]: colour };
    out.push({ atom: a.id, label: meIds.has(a.id) ? "Me" : carbonLabels.has(a.id) ? "CH3" : a.element, on: on.L, colour });
  }
  return out;
}

function ringMethyls(m, letters) {
  const ringAtoms = new Set(letters.flatMap(([, r]) => r.atomIds));
  return m.mol.atoms.filter((a) => {
    const bonds = m.bondsOf.get(a.id);
    return a.element === "C" && (a.formalCharge ?? 0) === 0 && bonds.length === 1 && bonds[0].order === "single" &&
      ringAtoms.has(m.other(bonds[0], a.id));
  });
}

// ---------- stereo read from the drawing (a local check; render-document has the last word) ----------
const isStereoBond = (b) => b.display?.bondStyle === "wedge" || b.display?.bondStyle === "hashed";
const det3 = (u, v, w) => u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);

/** Handedness a tetrahedral centre is drawn with: +1, -1, or 0 when the drawing does not say.
 * Its wedge or hash (narrow end at the centre) lifts that neighbour out of the page. */
function parity(m, c, L) {
  const a = m.atoms.get(c);
  const v = [...m.neighbours(c)].sort().map((id) => {
    const n = m.atoms.get(id), b = m.bondsOf.get(c).find((x) => m.other(x, c) === id);
    const z = b.fromAtomId === c && isStereoBond(b) ? (b.display.bondStyle === "wedge" ? L : -L) : 0;
    return [n.x - a.x, n.y - a.y, z];
  });
  const sub = (p, q) => p.map((x, i) => x - q[i]);
  const d = v.length === 3 ? det3(v[0], v[1], v[2]) : v.length === 4 ? det3(sub(v[1], v[0]), sub(v[2], v[0]), sub(v[3], v[0])) : 0;
  return Math.abs(d) < 1e-6 * L * L * L ? 0 : Math.sign(d);
}
export function stereoParities(m) {
  const L = m.mol.style?.bondLengthPx ?? 28;
  return new Map([...new Set(m.mol.bonds.filter(isStereoBond).map((b) => b.fromAtomId))].sort().map((c) => [c, parity(m, c, L)]));
}
/** Cis/trans of every double bond outside rings smaller than eight, read from coordinates. */
function doubleBondSides(m, rings) {
  const small = new Set(rings.filter((r) => r.size < 8).flatMap((r) => r.bondIds));
  const out = new Map();
  for (const b of m.mol.bonds) {
    if (b.order !== "double" || small.has(b.id)) continue;
    const p = m.atoms.get(b.fromAtomId), q = m.atoms.get(b.toAtomId);
    const np = m.neighbours(p.id).filter((id) => id !== q.id && m.atoms.get(id).element !== "H").sort()[0];
    const nq = m.neighbours(q.id).filter((id) => id !== p.id && m.atoms.get(id).element !== "H").sort()[0];
    if (!np || !nq) continue;
    const side = (r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    out.set(b.id, side(m.atoms.get(np)) * side(m.atoms.get(nq)));
  }
  return out;
}
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Put a wedge or hash on one bond of each stereocentre so it is drawn with the wanted
 * handedness: a bond to a terminal, non-ring, non-stereo atom first; among ring bonds, the one
 * in the fewest rings and closest to a standard length. */
function assignWedges(m, want, rings) {
  const ringAtoms = new Set(rings.flatMap((r) => r.atomIds));
  const inRings = (id) => rings.filter((r) => r.bondIds.includes(id)).length;
  const L = m.mol.style?.bondLengthPx ?? 28;
  for (const b of m.mol.bonds) if (isStereoBond(b)) delete b.display.bondStyle;
  const used = new Set(), centres = new Set(want.keys());
  for (const [c, sign] of want) {
    if (!sign) continue;
    const options = m.bondsOf.get(c).filter((b) => b.order === "single" && !used.has(b.id)).map((b) => {
      const n = m.other(b, c);
      const len = dist(m.atoms.get(c), m.atoms.get(n));
      return { b, rank: [centres.has(n) ? 1 : 0, ringAtoms.has(n) ? 1 : 0, m.neighbours(n).length === 1 ? 0 : 1, inRings(b.id), Math.abs(len / L - 1)] };
    }).sort((x, y) => x.rank.reduce((s, v, i) => s || Math.sign(v - y.rank[i]), 0));
    let done = false;
    for (const { b } of options) {
      if (b.fromAtomId !== c) [b.fromAtomId, b.toAtomId] = [b.toAtomId, b.fromAtomId];
      b.display = { ...(b.display ?? {}), bondStyle: "wedge" };
      const p = parity(m, c, L);
      if (!p) { delete b.display.bondStyle; continue; }
      if (p !== sign) b.display.bondStyle = "hashed";
      used.add(b.id); done = true; break;
    }
    if (!done) return `no bond at ${c} can carry its wedge in this layout`;
  }
  return null;
}

/** Draw every ring double bond's second line inside its smallest ring; others toward their neighbours. */
function sideDoubleBonds(m, rings) {
  const L = m.mol.style?.bondLengthPx ?? 28;
  for (const b of m.mol.bonds) {
    if (b.order !== "double") continue;
    const p = m.atoms.get(b.fromAtomId), q = m.atoms.get(b.toAtomId);
    const ring = rings.filter((r) => r.bondIds.includes(b.id)).sort((x, y) => x.size - y.size)[0];
    const pts = ring ? ring.atomIds.map((id) => m.atoms.get(id))
      : [...m.neighbours(p.id).filter((id) => id !== q.id), ...m.neighbours(q.id).filter((id) => id !== p.id)].map((id) => m.atoms.get(id));
    if (!pts.length) continue;
    const c = { x: pts.reduce((s, a) => s + a.x, 0) / pts.length, y: pts.reduce((s, a) => s + a.y, 0) / pts.length };
    const cross = (q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x);
    if (Math.abs(cross) < 0.05 * L * L) continue;
    b.display = { ...(b.display ?? {}), doubleBondSide: cross > 0 ? "left" : "right" };
  }
}

// ---------- other layouts of the same molecule (PubChem's 2D record, a rebuilt depiction) ----------
/** Heavy atoms and bonds of a V2000 molfile (PubChem's 2D SDF record). */
export function parseMolfile(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /V2000\s*$/.test(l));
  if (at < 0) fail("Not a V2000 molfile");
  const na = parseInt(lines[at].slice(0, 3), 10), nb = parseInt(lines[at].slice(3, 6), 10);
  const oldCharge = { 1: 3, 2: 2, 3: 1, 5: -1, 6: -2, 7: -3 };
  const atoms = [];
  for (let i = 0; i < na; i++) {
    const l = lines[at + 1 + i];
    atoms.push({ x: Number(l.slice(0, 10)), y: Number(l.slice(10, 20)), element: l.slice(31, 34).trim(), charge: oldCharge[parseInt(l.slice(36, 39), 10)] ?? 0 });
  }
  const bonds = [];
  for (let i = 0; i < nb; i++) {
    const l = lines[at + 1 + na + i];
    bonds.push({ a: parseInt(l.slice(0, 3), 10) - 1, b: parseInt(l.slice(3, 6), 10) - 1 });
  }
  for (const l of lines.slice(at + 1 + na + nb)) {
    if (!l.startsWith("M  CHG")) continue;
    const f = l.slice(6).trim().split(/\s+/).map(Number);
    for (let k = 1; k + 1 < f.length; k += 2) atoms[f[k] - 1].charge = f[k + 1];
  }
  return { atoms, bonds };
}

/** Heavy-atom graph: element, charge, heavy neighbours and hydrogen count per atom. */
function heavyGraph(atoms, bonds, implicitH = () => 0) {
  const keep = atoms.map((a, i) => a.element !== "H" ? i : -1).filter((i) => i >= 0);
  const index = new Map(keep.map((i, k) => [i, k]));
  const adj = keep.map(() => []), h = keep.map((i) => implicitH(i));
  for (const { a, b } of bonds) {
    if (index.has(a) && index.has(b)) { adj[index.get(a)].push(index.get(b)); adj[index.get(b)].push(index.get(a)); }
    else if (index.has(a)) h[index.get(a)]++;
    else if (index.has(b)) h[index.get(b)]++;
  }
  return { keep, adj, label: keep.map((i, k) => `${atoms[i].element}|${atoms[i].charge ?? 0}|${adj[k].length}|${h[k]}`) };
}

/** Map every heavy atom of one graph onto the other (element, charge, degree and H count must
 * agree, bonds must line up); null when the two are not the same skeleton. */
export function matchGraphs(src, dst) {
  if (src.adj.length !== dst.adj.length) return null;
  const refine = (g, rounds) => {
    let cls = g.label;
    for (let r = 0; r < rounds; r++) cls = cls.map((c, i) => c + "(" + g.adj[i].map((j) => cls[j]).sort().join(",") + ")");
    return cls;
  };
  const rounds = 4, cs = refine(src, rounds), cd = refine(dst, rounds);
  if ([...cs].sort().join(";") !== [...cd].sort().join(";")) return null;
  const n = src.adj.length, map = new Array(n).fill(-1), used = new Array(n).fill(false);
  const order = [], seen = new Array(n).fill(false);
  const count = new Map(); for (const c of cs) count.set(c, (count.get(c) ?? 0) + 1);
  for (const start of [...Array(n).keys()].sort((i, j) => count.get(cs[i]) - count.get(cs[j]))) {
    if (seen[start]) continue;
    const queue = [start]; seen[start] = true;
    while (queue.length) { const i = queue.shift(); order.push(i); for (const j of src.adj[i]) if (!seen[j]) { seen[j] = true; queue.push(j); } }
  }
  const adjSet = dst.adj.map((l) => new Set(l));
  let steps = 0;
  const place = (k) => {
    if (k === n) return true;
    if (++steps > 200000) return false;
    const i = order[k];
    const mappedNb = src.adj[i].filter((j) => map[j] >= 0);
    const pool = mappedNb.length ? dst.adj[map[mappedNb[0]]] : [...Array(n).keys()];
    for (const d of pool) {
      if (used[d] || cd[d] !== cs[i]) continue;
      if (!mappedNb.every((j) => adjSet[d].has(map[j]))) continue;
      if (dst.adj[d].filter((e) => used[e]).length !== mappedNb.length) continue;
      map[i] = d; used[d] = true;
      if (place(k + 1)) return true;
      map[i] = -1; used[d] = false;
    }
    return false;
  };
  return place(0) ? map : null;
}

/** The document's heavy atoms laid out as another source draws them: atom id -> {x, y}. */
function transferCoordinates(m, source) {
  const ids = m.mol.atoms.map((a) => a.id);
  const atoms = m.mol.atoms.map((a) => ({ element: a.element, charge: a.formalCharge ?? 0 }));
  const position = new Map(ids.map((id, i) => [id, i]));
  const bonds = m.mol.bonds.map((b) => ({ a: position.get(b.fromAtomId), b: position.get(b.toAtomId) }));
  const dst = heavyGraph(atoms, bonds, (i) => m.implicitH(ids[i]));
  const src = heavyGraph(source.atoms, source.bonds, source.implicitH);
  const map = matchGraphs(src, dst);
  if (!map) return null;
  const L = m.mol.style?.bondLengthPx ?? 28;
  const pts = src.keep.map((i) => source.atoms[i]);
  const lengths = source.bonds.filter(({ a, b }) => source.atoms[a].element !== "H" && source.atoms[b].element !== "H")
    .map(({ a, b }) => dist(source.atoms[a], source.atoms[b])).sort((x, y) => x - y);
  const scale = L / (lengths[Math.floor(lengths.length / 2)] || 1), flip = source.yUp ? -1 : 1;
  const heavy = m.mol.atoms.filter((a) => a.element !== "H");
  const cx = heavy.reduce((s, a) => s + a.x, 0) / heavy.length, cy = heavy.reduce((s, a) => s + a.y, 0) / heavy.length;
  const sx = pts.reduce((s, p) => s + p.x, 0) / pts.length, sy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const out = new Map();
  map.forEach((d, k) => out.set(ids[dst.keep[d]], { x: cx + (pts[k].x - sx) * scale, y: cy + flip * (pts[k].y - sy) * scale }));
  return out;
}

// ---------- substituents off the fills ----------
// Rule: no substituent atom, bond or label sits on a filled ring. A substituent is everything
// past an acyclic bond from a lettered-ring atom; it is turned or mirrored about that atom
// (bond lengths kept), and every move is checked and undone if the chemistry changed.
const TOL = 1.5;
function depth(p, poly) {
  if (!inPolygon(p, poly)) return -1;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}
function segmentInFill(a, b, poly) {
  const n = Math.max(4, Math.ceil(dist(a, b) / 2));
  for (let i = 1; i < n; i++) if (depth({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }, poly) > TOL) return true;
  return false;
}
function boxInFill(r, poly) {
  const s = { x0: r.x0 + 1, x1: r.x1 - 1, y0: r.y0 + 1, y1: r.y1 - 1 };
  return [...corners(s), { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 }].some((p) => depth(p, poly) > TOL);
}
const fillsOf = (m, letters) => letters.map(([L, r]) => ({ L, r, poly: r.order.map((id) => m.atoms.get(id)), bonds: new Set(r.bondIds), atoms: new Set(r.atomIds) }));

function substituentGroups(m, rings, letters) {
  const ringBonds = new Set(rings.flatMap((r) => r.bondIds)), lettered = new Set(letters.flatMap(([, r]) => r.atomIds));
  const groups = [];
  for (const b of m.mol.bonds) {
    if (ringBonds.has(b.id)) continue;
    for (const [attach, root] of [[b.fromAtomId, b.toAtomId], [b.toAtomId, b.fromAtomId]]) {
      if (!lettered.has(attach) || lettered.has(root)) continue;
      const atoms = new Set([root]), queue = [root];
      while (queue.length) for (const n of m.neighbours(queue.shift())) if (n !== attach && !atoms.has(n)) { atoms.add(n); queue.push(n); }
      if ([...atoms].some((id) => lettered.has(id))) continue;
      groups.push({ attach, root, atoms, bonds: m.mol.bonds.filter((x) => atoms.has(x.fromAtomId) || atoms.has(x.toAtomId)) });
    }
  }
  return groups;
}

/** What of a group lies on a fill: atoms, bonds and labels, by ring letter. */
function groupOnFills(m, g, fills, labels) {
  const hits = [];
  for (const f of fills) {
    for (const id of g.atoms) {
      const a = m.atoms.get(id);
      if (depth(a, f.poly) > TOL) hits.push(`${id} in ${f.L}`);
      else { const box = labels(a); if (box && boxInFill(box, f.poly)) hits.push(`${id} label on ${f.L}`); }
    }
    for (const b of g.bonds) if (!f.bonds.has(b.id) && segmentInFill(m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId), f.poly)) hits.push(`${b.id} across ${f.L}`);
  }
  return hits;
}

/** Crowding a placement causes: near atoms and touching labels, a bond squeezed against its
 * neighbours at the attachment atom. `blocked` when an atom lands on another or a bond crosses one:
 * a crossing is never traded for a fill. */
function crowding(m, g, labels, L) {
  let cost = 0, blocked = false;
  const others = m.mol.atoms.filter((a) => !g.atoms.has(a.id) && a.id !== g.attach);
  const rest = m.mol.bonds.filter((b) => !g.atoms.has(b.fromAtomId) && !g.atoms.has(b.toAtomId));
  const restBoxes = others.map((a) => [a, labels(a)]).filter(([, box]) => box);
  for (const id of g.atoms) {
    const a = m.atoms.get(id);
    for (const o of others) { const d = dist(a, o); if (d < 0.5 * L) blocked = true; else if (d < 0.85 * L) cost += 30 * (0.85 - d / L); }
    const box = labels(a);
    if (box) {
      for (const [, ob] of restBoxes) if (boxBox(box, ob) < 1) cost += 15;
      for (const b of rest) if (boxSegment(box, m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId)) < 1) cost += 6;
    }
  }
  for (const b of g.bonds) {
    const p = m.atoms.get(b.fromAtomId), q = m.atoms.get(b.toAtomId);
    for (const r of rest) {
      if ([r.fromAtomId, r.toAtomId].some((id) => id === b.fromAtomId || id === b.toAtomId)) continue;
      if (segmentsCross(p, q, m.atoms.get(r.fromAtomId), m.atoms.get(r.toAtomId))) blocked = true;
    }
  }
  const c = m.atoms.get(g.attach), root = m.atoms.get(g.root), t = Math.atan2(root.y - c.y, root.x - c.x);
  for (const n of m.neighbours(g.attach)) {
    if (n === g.root) continue;
    const o = m.atoms.get(n), u = Math.atan2(o.y - c.y, o.x - c.x);
    const apart = Math.abs(Math.atan2(Math.sin(t - u), Math.cos(t - u))) * 180 / Math.PI;
    if (apart < 30) blocked = true; else if (apart < 75) cost += (75 - apart) * 0.4;
  }
  return { cost, blocked };
}

function snapshot(m, g) {
  return { atoms: new Map([...g.atoms].map((id) => [id, { x: m.atoms.get(id).x, y: m.atoms.get(id).y }])),
    bonds: new Map(g.bonds.map((b) => [b.id, { fromAtomId: b.fromAtomId, toAtomId: b.toAtomId, display: b.display && { ...b.display } }])) };
}
function restore(m, s) {
  for (const [id, p] of s.atoms) Object.assign(m.atoms.get(id), p);
  for (const b of m.mol.bonds) {
    const v = s.bonds.get(b.id);
    if (!v) continue;
    b.fromAtomId = v.fromAtomId; b.toAtomId = v.toAtomId;
    if (v.display) b.display = { ...v.display }; else delete b.display;
  }
}
/** Turn (degrees, clockwise on the page) or mirror (across the line through the attachment
 * atom at `axis` degrees) a group from its snapshot. A mirror image swaps every wedge and hash
 * that starts inside the group, so the group's own stereocentres keep their handedness, and
 * flips each double bond's side. */
function place(m, g, s, kind, degrees) {
  restore(m, s);
  const c = m.atoms.get(g.attach), t = degrees * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  for (const id of g.atoms) {
    const a = m.atoms.get(id), dx = a.x - c.x, dy = a.y - c.y;
    if (kind === "turn") { a.x = c.x + dx * cos - dy * sin; a.y = c.y + dx * sin + dy * cos; }
    else {
      const c2 = Math.cos(2 * t), s2 = Math.sin(2 * t);
      a.x = c.x + dx * c2 + dy * s2; a.y = c.y + dx * s2 - dy * c2;
    }
  }
  if (kind === "mirror") for (const b of g.bonds) {
    if (isStereoBond(b) && g.atoms.has(b.fromAtomId)) b.display.bondStyle = b.display.bondStyle === "wedge" ? "hashed" : "wedge";
    if (b.order === "double" && b.display?.doubleBondSide) b.display.doubleBondSide = b.display.doubleBondSide === "left" ? "right" : "left";
  }
}

/** Move every substituent that lies on a fill to the clearest placement off all fills.
 * `check(m)` returns null when the chemistry is unchanged, else why; a move it rejects is undone
 * and the next-best placement tried. Returns what moved, what was undone and what is stuck. */
export function clearFills(m, rings, letters, carbonLabels, check = () => null) {
  const L = m.mol.style?.bondLengthPx ?? 28, size = m.mol.style?.atomLabelFontSizePx ?? 15;
  const labels = (a) => labelBox(m, a, new Set(), carbonLabels, size);
  const fills = fillsOf(m, letters);
  const moved = [], reverted = [], stuck = [];
  const groups = substituentGroups(m, rings, letters);
  const name = (g) => `${g.root} on ${g.attach}${g.atoms.size > 1 ? ` (${g.atoms.size} atoms)` : ""}`;
  const failed = new Set();
  for (let pass = 0; pass < 2; pass++) for (const g of groups) {
    const before = groupOnFills(m, g, fills, labels);
    if (!before.length) continue;
    // Every placement was undone in the first pass: the second has nothing new to try.
    if (failed.has(g)) { stuck.push({ group: name(g), attach: g.attach, on: before, reason: "every placement off the fill was undone: it would change the stereochemistry" }); continue; }
    const s = snapshot(m, g), base = crowding(m, g, labels, L).cost;
    const tries = [];
    for (let d = 5; d <= 360; d += 5) tries.push(["turn", d <= 180 ? d : d - 360]);
    for (let d = 0; d < 180; d += 5) tries.push(["mirror", d]);
    const scored = [];
    for (const [kind, deg] of tries) {
      place(m, g, s, kind, deg);
      const hits = groupOnFills(m, g, fills, labels);
      if (hits.length >= before.length) continue;
      const { cost, blocked } = crowding(m, g, labels, L);
      if (blocked) continue;
      scored.push({ kind, deg, hits, cost: hits.length * 100 + cost + Math.abs(deg) * 0.02 + (kind === "mirror" ? 2 : 0) });
    }
    restore(m, s);
    scored.sort((a, b) => a.cost - b.cost);
    let done = false;
    for (const t of scored.slice(0, 6)) {
      if (t.hits.length && t.cost - t.hits.length * 100 > base + 60) continue;
      place(m, g, s, t.kind, t.deg);
      const why = check(m);
      const move = { group: name(g), attach: g.attach, root: g.root, move: t.kind === "turn" ? `turned ${t.deg} degrees` : `mirrored across the ${t.deg}-degree line`, was: before };
      if (why) { restore(m, s); reverted.push({ ...move, reason: why }); continue; }
      moved.push({ ...move, left: t.hits, undo: s, redo: snapshot(m, g) });
      done = true; break;
    }
    if (!done && pass === 0 && scored.length && reverted.some((r) => r.root === g.root && r.attach === g.attach)) failed.add(g);
    if (!done && pass === 1) stuck.push({ group: name(g), attach: g.attach, on: before,
      reason: scored.length ? "every placement off the fill was undone or crowds the drawing" : "every placement off the fill lands on an atom or crosses a bond; the attachment atom is enclosed by filled rings" });
  }
  return { moved, reverted, stuck };
}

/** Turn substituents whose labels touch another label, a bond or a fusion H by up to 60 degrees,
 * never onto a fill, an atom or across a bond. `planH()` says where the fusion H would go in the
 * current drawing ([{atom, p, box}]); it is asked again for every candidate turn. Moves go
 * through `check` as in clearFills. */
export function declutter(m, rings, letters, carbonLabels, planH = () => [], check = () => null) {
  const L = m.mol.style?.bondLengthPx ?? 28, size = m.mol.style?.atomLabelFontSizePx ?? 15;
  const labels = (a) => labelBox(m, a, new Set(), carbonLabels, size);
  const fills = fillsOf(m, letters);
  const moved = [], reverted = [];
  // Touches count; `near` adds a soft cost for labels within a label's height of a fusion H.
  const touches = (g) => {
    let n = 0, near = 0;
    const hs = planH();
    const others = m.mol.atoms.filter((a) => !g.atoms.has(a.id));
    const rest = m.mol.bonds.filter((b) => !g.atoms.has(b.fromAtomId) && !g.atoms.has(b.toAtomId));
    for (const id of g.atoms) {
      const box = labels(m.atoms.get(id));
      if (!box) continue;
      for (const o of others) { const ob = labels(o); if (ob && boxBox(box, ob) < 2) n++; }
      for (const b of rest) if (boxSegment(box, m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId)) < 1) n++;
      for (const h of hs) {
        const gap = Math.min(boxBox(box, h.box), boxSegment(box, m.atoms.get(h.atom), h.p));
        if (gap < 3) n++; else if (gap < size) near += size - gap;
      }
    }
    for (const h of hs) for (const b of g.bonds) if (boxSegment(h.box, m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId)) < 1) n++;
    return { n, near };
  };
  for (const g of substituentGroups(m, rings, letters)) {
    const before = touches(g).n;
    if (!before || groupOnFills(m, g, fills, labels).length) continue;
    const s = snapshot(m, g), scored = [];
    for (let d = -60; d <= 60; d += 5) {
      if (!d) continue;
      place(m, g, s, "turn", d);
      if (groupOnFills(m, g, fills, labels).length) continue;
      const { n: t, near } = touches(g);
      if (t >= before) continue;
      const { cost, blocked } = crowding(m, g, labels, L);
      if (!blocked) scored.push({ deg: d, t, cost: t * 50 + cost + near * 2 + Math.abs(d) * 0.3 });
    }
    restore(m, s);
    scored.sort((a, b) => a.cost - b.cost);
    for (const t of scored.slice(0, 4)) {
      place(m, g, s, "turn", t.deg);
      const move = { group: `${g.root} on ${g.attach}${g.atoms.size > 1 ? ` (${g.atoms.size} atoms)` : ""}`, attach: g.attach, root: g.root, move: `turned ${t.deg} degrees to clear a label`, was: [`${before} label touch(es)`] };
      const why = check(m);
      if (why) { restore(m, s); reverted.push({ ...move, reason: why }); continue; }
      moved.push({ ...move, left: t.t ? [`${t.t} label touch(es)`] : [], undo: s, redo: snapshot(m, g) });
      break;
    }
  }
  return { moved, reverted };
}

// ---------- figure checks: a figure that fails one is not finished ----------
/** Limits a finished figure must meet, calibrated on ChemDraft's drawings of paclitaxel (CID 36314)
 * and cholesterol (CID 5997), which pass, against strychnine (CID 441071) and morphine (CID 5288826),
 * whose real faults they catch. See recipe 11, "The figure checks". */
export const LIMITS = {
  ringArea: 0.75,     // a lettered ring's area over a regular polygon's with the same ring size and mean side
  ringAngle: 0.6,     // its smallest interior angle over the regular polygon's angle (120 degrees for a 6-ring)
  bondStretch: 1.3,   // a plain bond's length over the median bond length
  wedgeStretch: 1.3,  // a wedge's or hash's length over the median bond length
  letterPx: 14,       // smallest legible ring letter, in px (the letters are set at 20 px)
  hiddenRing: 0.4     // share of a lettered ring's area lying under another lettered ring's fill
};

function signedArea(poly) {
  return poly.reduce((s, a, i) => { const b = poly[(i + 1) % poly.length]; return s + a.x * b.y - b.x * a.y; }, 0) / 2;
}
/** Interior angles of a simple polygon, in degrees (reflex angles above 180). */
function interiorAngles(poly) {
  const s = Math.sign(signedArea(poly));
  return poly.map((p, i) => {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
    const u = { x: a.x - p.x, y: a.y - p.y }, v = { x: b.x - p.x, y: b.y - p.y };
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
    const t = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    return Math.sign(u.x * v.y - u.y * v.x) === s ? 360 - t : t;
  });
}
function selfCrossing(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
  }
  return false;
}
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : 0; };

/** Shape of each lettered ring against a regular polygon of the same size, and how much of each
 * lies under another lettered ring's fill. */
export function ringShapes(m, letters) {
  const L = m.mol.style?.bondLengthPx ?? 28;
  const fills = fillsOf(m, letters);
  return fills.map((f) => {
    const n = f.poly.length;
    const side = f.poly.reduce((s, p, i) => s + dist(p, f.poly[(i + 1) % n]), 0) / n;
    const regular = n * side * side / (4 * Math.tan(Math.PI / n));
    const crossed = selfCrossing(f.poly);
    const angles = interiorAngles(f.poly);
    const shape = { letter: f.L, size: n, areaRatio: Number((area(f.poly) / regular).toFixed(2)),
      smallestAngle: Number(Math.min(...angles).toFixed(0)), regularAngle: Number(((n - 2) * 180 / n).toFixed(0)), crossed, under: [] };
    // Sample the ring's inside: the share under each other fill.
    const xs = f.poly.map((p) => p.x), ys = f.poly.map((p) => p.y), step = L / 10;
    let total = 0;
    const under = new Map();
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      if (depth({ x, y }, f.poly) <= TOL) continue;
      total++;
      for (const g of fills) if (g !== f && depth({ x, y }, g.poly) > TOL) under.set(g.L, (under.get(g.L) ?? 0) + 1);
    }
    shape.under = [...under].map(([by, k]) => ({ by, share: Number((k / Math.max(total, 1)).toFixed(2)) })).sort((a, b) => b.share - a.share);
    return shape;
  });
}

/** Fusion CH stereocentres (a CH carbon in two lettered rings with a wedge or hash starting there)
 * drawn without their H: the stereo stays on a ring bond. */
export function fusionHMissing(m, letters) {
  const lettered = letters.map(([, r]) => r);
  return m.mol.atoms.filter((a) => a.element === "C" && lettered.filter((r) => r.atomIds.includes(a.id)).length >= 2 &&
    m.implicitH(a.id) === 1 && !m.neighbours(a.id).some((id) => m.atoms.get(id).element === "H") &&
    m.bondsOf.get(a.id).some((b) => b.fromAtomId === a.id && isStereoBond(b))).map((a) => a.id);
}

/** The figure checks. `placed`: [{letter, size, missing}] ring letters as drawn. Returns
 * {failures: [text], measures}; a figure with any failure is not delivered as finished. */
export function figureFaults(m, letters, placed = [], why = new Map(), { fusionH = true } = {}) {
  const failures = [];
  const shapes = ringShapes(m, letters);
  for (const s of shapes) {
    if (s.crossed) failures.push(`ring ${s.letter} is degenerate: its outline crosses itself`);
    else if (s.areaRatio < LIMITS.ringArea || s.smallestAngle < LIMITS.ringAngle * s.regularAngle) {
      failures.push(`ring ${s.letter} is a sliver: area ${s.areaRatio} of a regular ${s.size}-ring with its sides, smallest angle ${s.smallestAngle} degrees (regular ${s.regularAngle}); limits ${LIMITS.ringArea} and ${Math.round(LIMITS.ringAngle * s.regularAngle)} degrees`);
    }
    for (const u of s.under) if (u.share > LIMITS.hiddenRing) {
      failures.push(`ring ${u.by}'s fill covers ${Math.round(u.share * 100)}% of ring ${s.letter} (limit ${Math.round(LIMITS.hiddenRing * 100)}%)`);
    }
  }
  const heavy = m.mol.bonds.filter((b) => [b.fromAtomId, b.toAtomId].every((id) => m.atoms.get(id).element !== "H"));
  const len = (b) => dist(m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId));
  const mid = median(heavy.map(len));
  const bonds = [];
  for (const b of heavy) {
    const ratio = len(b) / mid, stereo = isStereoBond(b);
    bonds.push({ bond: b.id, ratio: Number(ratio.toFixed(2)), stereo });
    const at = `${b.id} (${b.fromAtomId}-${b.toAtomId})`;
    if (stereo && ratio > LIMITS.wedgeStretch) failures.push(`${b.display.bondStyle === "wedge" ? "wedge" : "hash"} ${at} is drawn ${ratio.toFixed(2)}x the median bond length (limit ${LIMITS.wedgeStretch}x)`);
    else if (!stereo && ratio > LIMITS.bondStretch) failures.push(`bond ${at} is stretched to ${ratio.toFixed(2)}x the median bond length (limit ${LIMITS.bondStretch}x)`);
  }
  for (const p of placed) {
    if (p.missing) failures.push(`ring ${p.letter} has no room for its letter, even at 10 px`);
    else if (p.size < LIMITS.letterPx) failures.push(`ring ${p.letter}'s letter is shrunk to ${p.size} px to fit (limit ${LIMITS.letterPx} px)`);
  }
  // With fusionH off (options) no H was asked for, so none is missing.
  const missing = fusionH ? fusionHMissing(m, letters) : [];
  for (const id of missing) {
    const smiles = m.input.get(id);
    failures.push(`fusion H dropped at ${id}${smiles !== undefined ? ` (SMILES atom ${smiles})` : ""}: ${why.get(id) ?? "no H drawn"}; its stereo stays on a ring bond`);
  }
  return { failures, measures: { medianBondPx: Number(mid.toFixed(1)), rings: shapes, longestBonds: bonds.sort((a, b) => b.ratio - a.ratio).slice(0, 5),
    letters: placed.map((p) => ({ letter: p.letter, size: p.missing ? null : p.size })), fusionHMissing: missing } };
}

// ---------- scoring a layout ----------
/** The options' `layout` values that force one drawing, and the candidate each names. */
const LAYOUTS = { build: "build", canonical: "canonical-SMILES rebuild", pubchem: "PubChem 2D" };
/** Another layout replaces ChemDraft's build only when it scores more than this much lower. */
export const BUILD_MARGIN = 6;

/** Faults of a styled layout: bond crossings, bonds and atoms or labels on fills that are not
 * their own, fill overlapping fill, clashing atoms, stretched bonds. Lower `score` is cleaner. */
export function layoutFaults(m, rings, letters, carbonLabels = new Set()) {
  const L = m.mol.style?.bondLengthPx ?? 28, size = m.mol.style?.atomLabelFontSizePx ?? 15;
  const fills = fillsOf(m, letters);
  const heavy = m.mol.atoms.filter((a) => a.element !== "H");
  const seg = m.mol.bonds.map((b) => [b, m.atoms.get(b.fromAtomId), m.atoms.get(b.toAtomId)]);
  const crossings = [], onFills = [], clashes = [], stretched = [];
  for (let i = 0; i < seg.length; i++) for (let j = i + 1; j < seg.length; j++) {
    const [b, p, q] = seg[i], [c, r, s] = seg[j];
    if ([b.fromAtomId, b.toAtomId].some((id) => id === c.fromAtomId || id === c.toAtomId)) continue;
    const o = (u, v, w) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
    if (o(p, q, r) * o(p, q, s) < 0 && o(r, s, p) * o(r, s, q) < 0) crossings.push(`${b.id} x ${c.id}`);
  }
  for (const f of fills) {
    for (const [b, p, q] of seg) if (!f.bonds.has(b.id) && segmentInFill(p, q, f.poly)) onFills.push(`bond ${b.id} across ${f.L}`);
    for (const a of heavy) {
      if (f.atoms.has(a.id)) continue;
      const box = labelBox(m, a, new Set(), carbonLabels, size);
      if (depth(a, f.poly) > TOL) onFills.push(`atom ${a.id} in ${f.L}`);
      else if (box && boxInFill(box, f.poly)) onFills.push(`label ${a.id} on ${f.L}`);
    }
  }
  // Fill on fill: sample the drawing; a point under two fills is overlap.
  let overlap = 0;
  if (fills.length > 1) {
    const xs = fills.flatMap((f) => f.poly.map((p) => p.x)), ys = fills.flatMap((f) => f.poly.map((p) => p.y)), step = L / 6;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      if (fills.filter((f) => depth({ x, y }, f.poly) > TOL).length > 1) overlap += step * step;
    }
  }
  const bonded = new Set(m.mol.bonds.map((b) => [b.fromAtomId, b.toAtomId].sort().join(" ")));
  for (let i = 0; i < heavy.length; i++) for (let j = i + 1; j < heavy.length; j++) {
    if (!bonded.has([heavy[i].id, heavy[j].id].sort().join(" ")) && dist(heavy[i], heavy[j]) < 0.5 * L) clashes.push(`${heavy[i].id}/${heavy[j].id}`);
  }
  for (const [b, p, q] of seg) if (Math.abs(dist(p, q) / L - 1) > 0.25) stretched.push(`${b.id}${isStereoBond(b) ? " (" + b.display.bondStyle + ")" : ""} ${(dist(p, q) / L).toFixed(2)}x`);
  // Rings the figure checks would fail as slivers or buried under another fill.
  const shapes = ringShapes(m, letters);
  const slivers = shapes.filter((s) => s.crossed || s.areaRatio < LIMITS.ringArea || s.smallestAngle < LIMITS.ringAngle * s.regularAngle).map((s) => s.letter);
  const hidden = shapes.flatMap((s) => s.under.filter((u) => u.share > LIMITS.hiddenRing).map((u) => `${s.letter} under ${u.by}`));
  const score = 40 * crossings.length + 12 * onFills.length + 10 * overlap / (L * L) + 20 * clashes.length +
    stretched.reduce((s, t) => s + (/\((wedge|hashed)\)/.test(t) ? 12 : 6), 0) + 30 * slivers.length + 30 * hidden.length;
  return { score: Number(score.toFixed(1)), crossings, onFills, overlapBondAreas: Number((overlap / (L * L)).toFixed(2)), clashes, stretched, slivers, hidden };
}

/** Choose the cleanest layout among the sources and clear substituents off the fills.
 * `tools.sources`: [{name, atoms, bonds, implicitH?, yUp?}] other drawings of the molecule;
 * `tools.verify(mol)`: null when render-document reads the molecule as the build did, else why.
 * Edits `mol` in place and returns the report. */
function arrange(mol, buildMol, opts, tools) {
  const verify = tools.verify ?? (() => null);
  const ref = model(mol, buildMol);
  const refParity = stereoParities(ref);
  const baseRings = describeRings(ref, buildMol.rings ?? fail("The build output has no rings"));
  const refSides = doubleBondSides(ref, baseRings);
  const local = (m) => {
    const p = stereoParities(m);
    for (const [c, v] of refParity) if (p.get(c) !== v) return `the drawing at ${c} now reads as the other stereoisomer`;
    if (!sameMap(doubleBondSides(m, baseRings), refSides)) return "a double bond now reads as the other geometric isomer";
    return null;
  };
  const candidates = [], rejected = [];
  const consider = (name, coords) => {
    const cmol = structuredClone(mol), m = model(cmol, buildMol);
    if (coords) {
      for (const [id, p] of coords) Object.assign(m.atoms.get(id), p);
      const why = assignWedges(m, refParity, baseRings);
      if (why) { rejected.push(`${name}: ${why}`); return; }
      sideDoubleBonds(m, baseRings);
      const bad = local(m);
      if (bad) { rejected.push(`${name}: ${bad}`); return; }
    }
    // The user's turns first, each checked like any other move.
    const turned = rotateGroups(m, opts.rotate, local);
    let rings = describeRings(m, buildMol.rings);
    const { letters } = assignLetters(rings, opts);
    const carbonLabels = new Set((opts.methyls === "none" ? [] : ringMethyls(m, letters)).map((a) => a.id));
    const cleared = clearFills(m, rings, letters, carbonLabels, local);
    cleared.moved.unshift(...turned.moved); cleared.reverted.unshift(...turned.reverted);
    // Then labels that touch, counting the fusion H style() will add.
    if (opts.declutter !== false) {
      const planH = () => opts.fusionH ? addFusionH(model(structuredClone(cmol), buildMol), letters, carbonLabels, [], true) : [];
      const tidy = declutter(m, rings, letters, carbonLabels, planH, local);
      cleared.moved.push(...tidy.moved); cleared.reverted.push(...tidy.reverted);
    }
    rings = describeRings(m, buildMol.rings);
    const faults = layoutFaults(m, rings, assignLetters(rings, opts).letters, carbonLabels);
    candidates.push({ name, cmol, m, faults, cleared, carbonLabels, transferred: !!coords });
  };
  const want = opts.layout ?? "search";
  if (want !== "search" && !LAYOUTS[want]) fail(`layout must be "search", ${Object.keys(LAYOUTS).map((k) => `"${k}"`).join(", ")}, not ${JSON.stringify(want)}`);
  consider("build", null);
  if (want !== "build") for (const s of tools.sources ?? []) {
    if (want !== "search" && s.name !== LAYOUTS[want]) continue;
    const coords = transferCoordinates(ref, s);
    if (coords) consider(s.name, coords); else rejected.push(`${s.name}: its atoms could not be matched to the document's`);
  }
  // The build layout stays unless another scores more than BUILD_MARGIN lower (clearly cleaner);
  // a forced layout is used whatever its score.
  const order = want === "search"
    ? [...candidates].sort((a, b) => (a.faults.score - (a.name === "build" ? BUILD_MARGIN : 0)) - (b.faults.score - (b.name === "build" ? BUILD_MARGIN : 0)))
    : candidates.filter((c) => c.name === LAYOUTS[want]);
  if (!order.length) {
    fail(`layout "${want}" is not available: ${rejected.filter((r) => r.startsWith(LAYOUTS[want])).join("; ") ||
      (want === "pubchem" ? "no PubChem 2D record (<name>-pubchem.sdf): run the pubchem step first" : "the input SMILES is already ChemDraft's canonical SMILES, so that layout is the build: use \"layout\": \"build\"")}`);
  }
  const notes = [];
  let chosen = null;
  for (const c of order) {
    // A new layout must read as the same molecule before any substituent moves count.
    if (c.transferred) {
      const why = verify(c.cmol);
      if (why) { rejected.push(`${c.name}: render-document ${why}`); continue; }
    }
    chosen = c; break;
  }
  if (!chosen && want !== "search") fail(`layout "${want}" was refused: ${rejected.at(-1)}`);
  if (want !== "search") notes.push(`Layout forced by the options ("layout": "${want}").`);
  chosen ??= candidates[0];
  // Every kept move, the user's rotate turns included, is checked by render-document too: all at
  // once, then one by one if that fails.
  const { m, cleared } = chosen;
  if (cleared.moved.length && verify(chosen.cmol)) {
    const moves = cleared.moved;
    for (const mv of [...moves].reverse()) restore(m, mv.undo);
    cleared.moved = [];
    const undone = new Set();
    for (const mv of moves) {
      // A later move of an atom an undone move had moved starts where that one ended: undo it too.
      if ([...mv.undo.atoms.keys()].some((id) => undone.has(id))) { cleared.reverted.push({ ...mv, reason: "an earlier move of this substituent was undone" }); continue; }
      restore(m, mv.redo);
      const why = verify(chosen.cmol);
      if (why) { restore(m, mv.undo); for (const id of mv.undo.atoms.keys()) undone.add(id); cleared.reverted.push({ ...mv, reason: `render-document ${why}` }); }
      else cleared.moved.push(mv);
    }
    const rings = describeRings(m, buildMol.rings);
    chosen.faults = layoutFaults(m, rings, assignLetters(rings, opts).letters, chosen.carbonLabels);
  }
  mol.atoms = chosen.cmol.atoms; mol.bonds = chosen.cmol.bonds;
  const strip = ({ undo, redo, ...rest }) => rest;
  return {
    chosen: chosen.name,
    candidates: candidates.map((c) => ({ name: c.name, score: c.faults.score })),
    rejected, faults: chosen.faults, moved: cleared.moved.map(strip), reverted: cleared.reverted.map(strip), stuck: cleared.stuck, notes
  };
}

export function style(doc, buildMol, options = {}, tools = {}) {
  const opts = { fillOpacity: 0.9, letterSizePx: 20, letterFont: "Times New Roman, Times, serif", fusionH: true, methyls: "ring", ...options };
  const page = doc.pages.find((p) => p.objects.some((o) => o.id === buildMol.objectId)) ?? doc.pages[0];
  const mol = page.objects.find((o) => o.id === buildMol.objectId) ?? page.objects.find((o) => o.type === "molecule");
  if (!mol) fail("No molecule in the document");
  mol.style ??= {};
  const layout = arrange(mol, buildMol, opts, tools);
  const xs = mol.atoms.map((a) => a.x), ys = mol.atoms.map((a) => a.y);
  Object.assign(mol, { x: Math.min(...xs) - 8, y: Math.min(...ys) - 8, width: Math.max(...xs) - Math.min(...xs) + 16, height: Math.max(...ys) - Math.min(...ys) + 16 });
  const m = model(mol, buildMol);
  const rings = describeRings(m, buildMol.rings ?? fail("The build output has no rings"));
  if (!rings.length) fail("The molecule has no rings to style");
  const { letters, notes } = assignLetters(rings, opts);
  const colours = assignColours(letters, opts.palette);
  const warnings = [];
  const methyls = opts.methyls === "none" ? [] : ringMethyls(m, letters);
  const carbonLabels = new Set(methyls.map((a) => a.id));
  const hydrogensUndone = [];
  const hydrogens = verifyFusionH(m, opts.fusionH ? addFusionH(m, letters, carbonLabels, warnings) : [],
    () => tools.verify ? tools.verify(mol) : null, warnings, hydrogensUndone);
  mol.style.atomLabelBackgroundColor = "transparent";
  mol.style.ringStyles = { ...(mol.style.ringStyles ?? {}) };
  for (const [, r] of letters) mol.style.ringStyles[r.ringKey] = { fillColor: colours.get(r), fillOpacity: opts.fillOpacity };
  // A bridged ring can be drawn around another lettered ring. Ring
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
    notes.push(`Ring ${L}'s outline takes in part of a smaller lettered ring, so its fill is a path object under the molecule (ring-fill-${L}) and the smaller ring shows on top; the path does not follow the atoms if they are moved in the app.`);
  }
  mol.style.atomLabelShowTerminalCarbonsByAtomId = { ...(mol.style.atomLabelShowTerminalCarbonsByAtomId ?? {}), ...Object.fromEntries(methyls.map((a) => [a.id, true])) };

  const variant = (meIds, carbon) => {
    const copy = structuredClone(doc);
    const cpage = copy.pages[doc.pages.indexOf(page)];
    const cmol = cpage.objects.find((o) => o.id === mol.id);
    const placed = placeLetters(model(cmol, buildMol), letters.map(([L, r]) => [L, r]), opts, meIds, carbon);
    for (const p of placed.filter((x) => !x.missing)) {
      const fill = colours.get(p.ring), w = 1.4 * p.size;
      cpage.objects.push({ id: `ring-letter-${p.letter}`, type: "text", text: p.letter, spans: [], rotation: 0,
        x: p.x - w / 2, y: p.y - 0.64 * p.size, width: w, height: 1.25 * p.size,
        style: { fontSizePx: p.size, fontWeight: 700, fontStyle: "italic", textAlign: "center", fontFamily: opts.letterFont, color: letterColour(fill, opts.fillOpacity) } });
    }
    const labels = colourLabelsOnFills(model(cmol, buildMol), letters, colours, opts.fillOpacity, meIds, carbon);
    for (const a of cmol.atoms) if (meIds.has(a.id)) a.element = "Me";
    return { copy, placed, labels };
  };
  const carbon = variant(new Set(), carbonLabels);
  const picture = variant(new Set(methyls.map((a) => a.id)), new Set());
  for (const p of [...carbon.placed, ...picture.placed]) {
    if (p.missing) continue;
    if (p.clearancePx < 0) warnings.push(`Ring ${p.letter}: the letter touches a bond or label even at ${p.size}px; look at it.`);
    if (p.overlapping) warnings.push(`Ring ${p.letter}: the ring is drawn under another ring, so its letter sits where the two overlap; check it reads as ${p.letter}'s.`);
  }
  // The figure checks, on the final drawing; the smaller of each letter's two sizes counts.
  const smallest = letters.map(([L]) => [...carbon.placed, ...picture.placed].filter((p) => p.letter === L)
    .sort((a, b) => (a.missing ? -1 : a.size) - (b.missing ? -1 : b.size))[0]).filter(Boolean);
  const quality = figureFaults(m, letters, smallest, fusionReasons(warnings), { fusionH: !!opts.fusionH });
  const report = {
    letters: letters.map(([L, r]) => {
      const at = picture.placed.find((p) => p.letter === L && !p.missing);
      return { letter: L, ringKey: r.ringKey, ring: label(r), fill: colours.get(r), letterColour: letterColour(colours.get(r), opts.fillOpacity),
        letterAt: at ? { x: at.x, y: at.y, size: at.size, clearancePx: at.clearancePx } : null };
    }),
    unlettered: rings.filter((r) => !letters.some(([, s]) => s === r)).map(label),
    fusionHydrogens: hydrogens,
    fusionHydrogensUndone: hydrogensUndone,
    labelsOnFills: { carbon: carbon.labels, picture: picture.labels },
    methyls: methyls.map((a) => ({ atom: a.id, smilesAtom: m.input.get(a.id) })),
    layout,
    quality: { limits: LIMITS, fusionH: !!opts.fusionH, ...quality },
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
  // A hashed bond is a group of tick lines that carries the bond id.
  for (const g of svg.matchAll(/<g\s((?:[^>"]|"[^"]*")*data-bond-id="[^"]*"(?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/g>/g)) {
    const id = attr(" " + g[1], "data-bond-id");
    for (const l of g[2].matchAll(/<line\s((?:[^>"]|"[^"]*")*)\/?>/g)) {
      const tag = " " + l[1];
      strokes.push({ bond: id, a: { x: Number(attr(tag, "x1")), y: Number(attr(tag, "y1")) }, b: { x: Number(attr(tag, "x2")), y: Number(attr(tag, "y2")) }, w: Number(attr(tag, "stroke-width") ?? 2) });
    }
  }
  for (const p of svg.matchAll(/<polygon\s((?:[^>"]|"[^"]*")*)\/?>/g)) {
    const tag = " " + p[1], id = attr(tag, "data-bond-id");
    const pts = (attr(tag, "points") ?? "").trim().split(/\s+/).map((xy) => xy.split(",").map(Number)).map(([x, y]) => ({ x, y }));
    for (let i = 0; i + 1 < pts.length; i++) strokes.push({ bond: id ?? "stereo", a: pts[i], b: pts[i + 1], w: 0 });
  }
  return { labels, texts, strokes };
}

/** Label pairs that nearly touch, text objects that sit on a label or a bond, and, given
 * `incident(label, bondId)` (true when the bond belongs to the label's atom), bonds that touch a
 * label: another atom's bond within 1 px, or the label's own bond running into it (a hash tick or
 * wedge drawn into the letters). */
export function collisions(svg, nearPx = 1.5, incident = null) {
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
  if (incident) for (const l of labels) {
    let worst = null;
    for (const s of strokes) {
      const g = boxSegment(l.box, s.a, s.b) - s.w / 2;
      if (g < (incident(l, s.bond) ? 0 : 1) && (!worst || g < worst.g)) worst = { s, g };
    }
    if (worst) out.push({ kind: "bond-label", a: l, b: { text: `bond ${worst.s.bond}` }, gapPx: Number(Math.max(0, worst.g).toFixed(1)) });
  }
  return out;
}

// ---------- commands ----------
// ---------- the ChemDraft CLI, run with this Node and no shell ----------
/** Runs the CLI of a ChemDraft checkout the way `pnpm chemdraft` does (tsx on cli.ts), with
 * process.execPath and an argument list: no shell, the same on macOS and Windows. */
export function chemdraftCli(checkout) {
  const tsx = path.join(checkout, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(checkout, "packages", "chemdraft-cli", "src", "cli.ts");
  if (!fs.existsSync(tsx) || !fs.existsSync(entry)) fail(`--checkout ${checkout} is not an installed ChemDraft checkout (no ${path.relative(checkout, tsx)} or ${path.relative(checkout, entry)})`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ring-style-"));
  let n = 0;
  const run = (args) => {
    const r = spawnSync(process.execPath, [tsx, entry, ...args], { cwd: checkout, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
    if (r.error) fail(`Could not run the ChemDraft CLI (${args[0]}): ${r.error.message}`);
    const lines = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"))
      .map((l, i) => parseIn(l, `ChemDraft CLI ${args[0]} output line ${i + 1}`));
    // Exit status and the tail of stderr, for any error message about this run.
    const status = `exit status ${r.status ?? r.signal}${r.stderr?.trim() ? `; stderr: ${r.stderr.trim().slice(-1500)}` : ""}`;
    return { lines, status };
  };
  /** Canonical SMILES and stereo counts render-document reads from a document. */
  const identity = (doc) => {
    const file = path.join(tmp, `check-${++n}.json`);
    writeJson(file, doc);
    const { lines, status } = run(["render-document", "--document", file, "--out", path.join(tmp, `check-${n}.svg`)]);
    const line = lines[0];
    if (!line?.ok) fail(`render-document could not read a candidate drawing (${file}): ${JSON.stringify(line?.error ?? line ?? "no output")} (${status})`);
    return line.molecules.map((mol) => ({ canonicalSmiles: mol.canonicalSmiles, stereoCenters: mol.stereoCenters, unspecifiedStereoCenters: mol.unspecifiedStereoCenters }));
  };
  /** Standard InChIKey of a SMILES, from `analyze`. */
  const keys = new Map();
  const inchiKey = (smiles) => {
    if (keys.has(smiles)) return keys.get(smiles);
    const job = path.join(tmp, `key-${++n}.json`);
    writeJson(job, [{ name: `key-${n}`, smiles }]);
    const { lines, status } = run(["analyze", "--batch", job, "--methods", "rdkit.inchikey"]);
    const key = lines[0]?.summary?.inchiKey?.value;
    if (!key) fail(`analyze gave no InChIKey for ${smiles}: ${JSON.stringify(lines[0]?.error ?? lines[0] ?? "no output")} (${status})`);
    keys.set(smiles, key);
    return key;
  };
  /** A fresh depiction of a SMILES: the build line and its document. */
  const build = (smiles) => {
    const job = path.join(tmp, `build-${++n}.json`);
    writeJson(job, [{ name: `relayout-${n}`, smiles }]);
    const line = run(["document", "--batch", job, "--out-dir", tmp]).lines[0];
    if (!line?.ok) return null;
    return { line, doc: readJson(line.document) };
  };
  return { identity, inchiKey, build, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** verify(mol) for style(): null when render-document reads the drawing exactly as it reads the
 * build's own drawing (canonical SMILES, specified and unspecified stereocentres), else why.
 * Explicit H atoms (the fusion H) change the SMILES string but not the molecule: when the drawing
 * reads with [H] atoms, the standard InChIKeys (from `inchiKey`, if given) are compared instead. */
export function identityVerifier(identity, doc, molId, inchiKey) {
  const withMol = (mol) => {
    const copy = structuredClone(doc);
    for (const page of copy.pages) page.objects = page.objects.map((o) => o.id === molId ? mol : o);
    return copy;
  };
  const page = doc.pages.find((p) => p.objects.some((o) => o.id === molId));
  const reference = identity(withMol(page.objects.find((o) => o.id === molId)));
  const verify = (mol) => {
    const got = identity(withMol(mol));
    const a = reference[0], b = got[0];
    if (!b) return "found no molecule";
    if (b.canonicalSmiles !== a.canonicalSmiles) {
      const sameKey = inchiKey && b.canonicalSmiles.includes("[H]") && inchiKey(b.canonicalSmiles) === inchiKey(a.canonicalSmiles);
      if (!sameKey) return `reads ${b.canonicalSmiles}, not ${a.canonicalSmiles}`;
    }
    if (b.stereoCenters !== a.stereoCenters || b.unspecifiedStereoCenters !== a.unspecifiedStereoCenters) {
      return `counts ${b.stereoCenters} specified / ${b.unspecifiedStereoCenters} unspecified stereocentres, not ${a.stereoCenters} / ${a.unspecifiedStereoCenters}`;
    }
    return null;
  };
  return { reference: reference[0], verify };
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
  // PubChem's own 2D drawing of the record, one of the layouts `style` compares.
  const sdf = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${p.CID}/SDF?record_type=2d`);
  if (sdf.ok) fs.writeFileSync(path.join(dir, `${name}-pubchem.sdf`), await sdf.text());
  else console.log(`PubChem has no 2D SDF for CID ${p.CID} (HTTP ${sdf.status}); style will compare ChemDraft's layouts only.`);
  console.log(JSON.stringify({ cid: p.CID, title: p.Title, formula: p.MolecularFormula, inchiKey: p.InChIKey,
    definedAtomStereo: p.DefinedAtomStereoCount, undefinedAtomStereo: p.UndefinedAtomStereoCount,
    definedBondStereo: p.DefinedBondStereoCount, undefinedBondStereo: p.UndefinedBondStereoCount, smiles: p.SMILES }));
}

function runStyle(dir, name, optionsFile, checkout) {
  if (!checkout) fail("style needs --checkout <ChemDraft checkout>: every coordinate move is checked with its render-document");
  const lines = readLines(path.join(dir, `${name}-build.jsonl`));
  const build = lines.find((l) => l.name === name) ?? lines[0] ?? fail(`No build output in ${name}-build.jsonl`);
  if (!build.ok) fail(`The document build failed: ${JSON.stringify(build.error ?? build.warnings)}`);
  const docFile = build.document && fs.existsSync(build.document) ? build.document : path.join(dir, `${name}.json`);
  const options = optionsFile ? readJson(optionsFile) : {};
  const doc = readJson(docFile), buildMol = build.molecules[0];
  const cli = chemdraftCli(checkout);
  try {
    const { reference, verify } = identityVerifier(cli.identity, doc, buildMol.objectId, cli.inchiKey);
    const sources = [];
    const sdf = path.join(dir, `${name}-pubchem.sdf`);
    if (fs.existsSync(sdf)) sources.push({ name: "PubChem 2D", yUp: true, ...parseMolfile(readText(sdf)) });
    // ChemDraft's layout of the canonical SMILES: the same molecule in another atom order.
    const rebuilt = build.canonicalSmiles && build.canonicalSmiles !== build.smiles && cli.build(build.canonicalSmiles);
    const rmol = rebuilt && rebuilt.doc.pages.flatMap((p) => p.objects).find((o) => o.type === "molecule");
    if (rmol) {
      const rm = model(rmol);
      const index = new Map(rmol.atoms.map((a, i) => [a.id, i]));
      sources.push({ name: "canonical-SMILES rebuild", atoms: rmol.atoms.map((a) => ({ ...a, charge: a.formalCharge ?? 0 })),
        bonds: rmol.bonds.map((b) => ({ a: index.get(b.fromAtomId), b: index.get(b.toAtomId) })), implicitH: (i) => rm.implicitH(rmol.atoms[i].id) });
    }
    const { carbon, picture, report } = style(doc, buildMol, options, { sources, verify });
    report.layout.reference = reference;
    writeJson(path.join(dir, `${name}-carbon.json`), carbon);
    writeJson(path.join(dir, `${name}-nicolaou.json`), picture);
    writeJson(path.join(dir, `${name}-style.json`), report);
    const lay = report.layout;
    console.log(`Layout: ${lay.chosen} (${lay.candidates.map((c) => `${c.name} ${c.score}`).join(", ")}; lower is cleaner)`);
    for (const r of lay.rejected) console.log(`  layout not used: ${r}`);
    for (const mv of lay.moved) console.log(`Moved ${mv.group}: ${mv.move}${mv.left.length ? `; still ${mv.left.join(", ")}` : ""}`);
    for (const mv of lay.reverted) console.log(`UNDONE: ${mv.group}, ${mv.move}: ${mv.reason}`);
    for (const st of lay.stuck) console.log(`STILL ON A FILL: ${st.group}: ${st.on.join(", ")} (${st.reason})`);
    const f = lay.faults, list = (xs) => xs.length ? ` [${xs.join("; ")}]` : "";
    console.log(`Remaining: ${f.crossings.length} bond crossing(s)${list(f.crossings)}, ${f.onFills.length} item(s) on a fill not their own${list(f.onFills)}, ` +
      `fill overlap ${f.overlapBondAreas} bond-length squares, ${f.clashes.length} atom clash(es)${list(f.clashes)}, ${f.stretched.length} stretched bond(s)${list(f.stretched)}`);
    for (const l of report.letters) console.log(`${l.letter}  ${l.fill} (${l.letterColour === WHITE ? "white" : "dark"} letter, ${l.letterAt ? `${l.letterAt.size}px` : "no room"})  ${l.ring}`);
    if (report.unlettered.length) console.log(`Not lettered or filled: ${report.unlettered.length} ring(s) outside the core`);
    console.log(`Fusion H added: ${report.fusionHydrogens.length}; ring methyls (Me in the picture, CH3 in -carbon): ${report.methyls.length}`);
    for (const [copy, list] of Object.entries(report.labelsOnFills)) for (const l of list) {
      console.log(`Label ${l.label} ${l.atom} stays on ring ${l.on}'s fill (${copy}): drawn ${l.colour === WHITE ? "white" : "near-black"} for legibility`);
    }
    for (const n of [...report.notes, ...report.warnings]) console.log(n);
    console.log(`Wrote ${name}-carbon.json, ${name}-nicolaou.json and ${name}-style.json`);
    printFigureVerdict(report.quality.failures);
    if (report.quality.failures.length) process.exitCode = 1;
  } finally {
    cli.cleanup();
  }
}

/** The figure checks' verdict, the same in style and check. */
function printFigureVerdict(failures) {
  if (!failures.length) { console.log(`Figure checks passed: ${figureChecksText()}.`); return; }
  console.log(`Figure checks FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  FAILED ${f}`);
  console.log("This figure is not finished: do not deliver it as finished. Say exactly what failed, and offer the plain (unfilled) drawing, " +
    "or the coloured one with these failures named. A forced layout (options \"layout\": \"build\", \"canonical\" or \"pubchem\") may clear them; check again.");
}
const figureChecksText = () => `no sliver ring (area >= ${LIMITS.ringArea} of regular, smallest angle >= ${LIMITS.ringAngle} of regular), ` +
  `no bond over ${LIMITS.bondStretch}x or wedge over ${LIMITS.wedgeStretch}x the median, letters >= ${LIMITS.letterPx} px, ` +
  `no ring more than ${Math.round(LIMITS.hiddenRing * 100)}% under another fill, every fusion H drawn`;

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

const buildLineOf = (dir, name) => {
  const lines = readLines(path.join(dir, `${name}-build.jsonl`));
  return lines.find((l) => l.name === name) ?? lines[0] ?? fail(`No build output in ${name}-build.jsonl`);
};
/** Why each fusion H was not drawn, from the style warnings: atom id -> reason. */
function fusionReasons(warnings) {
  const why = new Map();
  for (const w of warnings) {
    const hit = /^(?:UNDONE: fusion H at|Fusion CH) (\S+?):? (.*?)(?:, so n|; its ring)/.exec(w);
    if (hit) why.set(hit[1], hit[2]);
  }
  return why;
}

/** The figure checks on each rendered document: failure text -> the documents it holds in. */
function documentFaults(dir, name, renders) {
  const out = new Map();
  const add = (text, where) => { if (!out.has(text)) out.set(text, []); if (!out.get(text).includes(where)) out.get(text).push(where); };
  const styleFile = path.join(dir, `${name}-style.json`);
  if (!fs.existsSync(path.join(dir, `${name}-build.jsonl`)) || !fs.existsSync(styleFile)) {
    add(`the figure checks need ${name}-build.jsonl and ${name}-style.json in ${dir}`, "check");
    return out;
  }
  const buildMol = buildLineOf(dir, name).molecules[0], report = readJson(styleFile);
  const why = fusionReasons(report.warnings ?? []);
  for (const file of [...new Set(renders.map((l) => l.document).filter(Boolean))]) {
    if (!fs.existsSync(file)) { add(`${path.basename(file)} is missing`, path.basename(file)); continue; }
    const objects = readJson(file).pages.flatMap((p) => p.objects);
    const mol = objects.find((o) => o.id === buildMol.objectId) ?? objects.find((o) => o.type === "molecule");
    const m = model(mol, buildMol), rings = describeRings(m, buildMol.rings);
    const letters = report.letters.map((l) => [l.letter, rings.find((r) => r.ringKey === l.ringKey)]).filter(([, r]) => r);
    const placed = report.letters.map((l) => {
      const t = objects.find((o) => o.id === `ring-letter-${l.letter}`);
      return t ? { letter: l.letter, size: t.style?.fontSizePx ?? 16 } : { letter: l.letter, missing: true };
    });
    for (const f of figureFaults(m, letters, placed, why, { fusionH: report.quality?.fusionH !== false }).failures) add(f, path.basename(file));
  }
  return out;
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
    const incident = mol ? (label, bondId) => {
      const a = atomAt(label.x, label.y), b = mol.bonds.find((x) => x.id === bondId);
      return !!a && !!b && (b.fromAtomId === a.id || b.toAtomId === a.id);
    } : null;
    for (const file of (l.files ?? []).filter((f) => f.toLowerCase().endsWith(".svg"))) {
      for (const c of collisions(readText(file), 1.5, incident)) {
        const where = (x) => {
          if (x.x === undefined) return x.id ?? x.text;
          const a = atomAt(x.x, x.y);
          return `${x.text}${a ? ` ${a.id} (bonded to ${bondedTo(a.id).join(", ")})` : ""} at (${x.x.toFixed(0)}, ${x.y.toFixed(0)})`;
        };
        result.collisions.push({ svg: path.basename(file), kind: c.kind, a: where(c.a), b: where(c.b), gapPx: c.gapPx });
      }
    }
  }
  const figure = [...documentFaults(dir, name, renders)].map(([text, files]) => `${text} (${files.join(", ")})`);
  writeJson(path.join(dir, `${name}-check.json`), { ...result, failures, figureFailures: figure, limits: LIMITS });
  console.log(`PubChem CID ${ref.CID} ${ref.Title}: InChIKey ${ref.InChIKey}, stereocentres ${ref.DefinedAtomStereoCount} defined / ${ref.UndefinedAtomStereoCount} undefined`);
  for (const r of result.renders) {
    console.log(`${r.inchiKeyMatches ? "same" : "DIFFERENT"} InChIKey  ${r.files.join(", ")}${r.picture ? " (picture: Me read as C; its stereo counts are the carbon document's)" : `  stereo ${r.stereoCenters} specified / ${r.unspecifiedStereoCenters} unspecified, ${r.unspecifiedDoubleBonds} unspecified double bonds`}`);
  }
  for (const c of result.collisions) console.log(`near-touch ${c.kind} in ${c.svg}: ${c.a} vs ${c.b}, gap ${c.gapPx}px`);
  if (result.collisions.length) console.log("Fix a label pair by turning one substituent about its attachment atom (options.rotate), restyle, render and check again; move a ring letter with letterSizePx or by fixing the label it meets.");
  else console.log("No near-touching labels: no label within 1.5 px of another label or a ring letter, and no bond touching a label.");
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length ? "Identity check FAILED: do not deliver." : "Identity check passed.");
  printFigureVerdict(figure);
  if (!failures.length && !figure.length) console.log("Now look at the PNGs at full size.");
  if (failures.length || figure.length) process.exitCode = 1;
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
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    // The header comment above is the help text.
    const source = readText(fileURLToPath(import.meta.url)).split(/\r?\n/);
    const text = source.slice(1, source.findIndex((l) => !l.startsWith("//") && l.trim() !== "" && !l.startsWith("#!")));
    console.log(text.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  }
  const at = args.indexOf("--checkout");
  const checkout = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const [command, dir, name, extra] = args;
  try {
    if (!command || !dir || !name) fail("Usage: node ring-style.mjs <pubchem|style|relayout|identity-jobs|check> <dir> <name> [cid-or-name | options.json] [--checkout <ChemDraft checkout>]; --help for more");
    if (!NAME.test(name)) fail(`Name "${name}" must match ${NAME}`);
    if (!fs.existsSync(dir)) fail(`No directory ${dir}`);
    if (command === "pubchem") await pubchem(dir, name, extra ?? fail("pubchem needs a CID or a compound name"));
    else if (command === "style") runStyle(dir, name, extra, checkout && path.resolve(checkout));
    else if (command === "relayout") relayout(dir, name);
    else if (command === "identity-jobs") identityJobs(dir, name);
    else if (command === "check") check(dir, name);
    else fail(`Unknown command ${command}`);
  } catch (error) {
    console.error(`ring-style: ${error.message}`);
    process.exitCode = 2;
  }
}
