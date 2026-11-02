// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: adapted the binary codec to a local ordered element tree, warnings, and bounded ChemDraft import/export.

import { CHARSETS, OBJECTS, PROPS } from "./cdxTags";
import { sha256Hex } from "./sha256";
export interface CdxElement {
  name: string;
  attrs: Record<string, string>;
  kids: CdxElement[];
  text: string;
}
export interface CdxWarning { code: string; message: string; sourceObjectId?: string }
// Bit 14 identifies the user-defined envelope property interpreted by index.ts.
export const CDX_NATIVE_ENVELOPE_ATTRIBUTE = "attrib4344";
const fmt = (n: number) => { const s = n.toFixed(2); return s === "-0.00" ? "0" : s.endsWith(".00") ? s.slice(0, -3) : s; };

export const MAGIC = "VjCD0100";
// The magic, 04 03 02 01 and ten reserved bytes; the document object's tag and ID follow.
const HEADER = [0x56, 0x6a, 0x43, 0x44, 0x30, 0x31, 0x30, 0x30, 4, 3, 2, 1, ...new Array(10).fill(0)];
const MAX_BYTES = 64 * 1024 * 1024, MAX_DEPTH = 64, MAX_OBJECTS = 1_000_000, MAX_POINTS = 8191, MAX_SPECTRUM = 1 << 21;
const MAX_PROPERTIES = 1_000_000, MAX_WARNINGS = 1000;

function warningSink(warnings: CdxWarning[]): (warning: CdxWarning) => void {
  let summary = warnings.find((warning) => warning.code === "cdx.warnings_truncated");
  let dropped = summary ? Number(/CDX: (\d+)/.exec(summary.message)?.[1] ?? 0) : 0;
  return (warning) => {
    if (warnings.length < MAX_WARNINGS) { warnings.push(warning); return; }
    if (!summary) {
      summary = { code: "cdx.warnings_truncated", message: "" };
      warnings.push(summary);
    }
    summary.message = `CDX: ${++dropped} additional warnings omitted after the ${MAX_WARNINGS}-warning limit`;
  };
}

type Prop = { tag: number; name: string; kind: string; names?: Map<number, string>; values?: Map<string, number> };
const byTag = new Map<number, Prop>(), byName = new Map<string, Prop>(), objectTag = new Map<string, number>();
for (const [tag, name, kind, list] of PROPS) {
  const p: Prop = { tag, name, kind };
  if (list) {
    p.names = new Map();
    p.values = new Map();
    for (const pair of list.split(",")) {
      const k = pair.indexOf("="), v = Number(pair.slice(0, k)), n = pair.slice(k + 1);
      if (!p.names.has(v)) p.names.set(v, n);
      if (!p.values.has(n)) p.values.set(n, v);
    }
  }
  byTag.set(tag, p);
  if (name && !byName.has(name)) byName.set(name, p);
}
for (const [tag, name] of Object.entries(OBJECTS)) objectTag.set(name, Number(tag));
const charsets = new Map(CHARSETS.split(",").map((pair) => { const k = pair.indexOf("="); return [Number(pair.slice(0, k)), pair.slice(k + 1)] as const; }));
const charsetCode = new Map([...charsets].map(([code, name]) => [name, code]));
// The style records' four parts, as CDXML splits them (LabelFont, LabelFace, LabelSize, LabelColor).
const STYLE_PARTS = ["Font", "Face", "Size", "Color"];

// Validate before decoding so malformed properties produce one warning each, without partial tables.
function validProperty(p: Prop | undefined, b: Uint8Array, little: boolean, attrs: Record<string, string>): boolean {
  if (!p) return true;
  const n = b.length, d = new DataView(b.buffer, b.byteOffset, n);
  const integer = [1, 2, 4].includes(n);
  switch (p.kind) {
    case "flag": return n === 0;
    case "bool": return n === 0 || integer;
    case "i8": case "i16": case "i32": case "u16": case "e8": case "e16":
    case "b8": case "b16": case "order": case "charge": case "deg10": case "spacing":
    case "alpha": case "lh": case "wrap": case "style": return integer;
    case "coord": return n === 4;
    case "p2": case "f64": case "labelstyle": case "captionstyle": return n === 8;
    case "p3": return n === 12;
    case "rect": return n === 16;
    case "angle": return n === 2 || n === 4;
    case "ids": return n % 4 === 0;
    case "attachments": return n % 4 === 0 || n >= 2 && n === 2 + 4 * d.getUint16(0, little);
    case "linestarts": return n >= 2 && n === 2 + 2 * d.getUint16(0, little);
    case "elist": return n >= 2 && n === 2 + 2 * Math.abs(d.getInt16(0, little));
    case "curve": return n >= 2 && n === 2 + 8 * d.getUint16(0, little);
    case "colortable": return n >= 2 && n === 2 + 6 * d.getUint16(0, little);
    case "represent": return n % 6 === 0;
    case "spectrum": return n % 8 === 0 && n / 8 <= MAX_SPECTRUM;
    case "tagvalue": return attrs.TagType === "Double" ? n === 8 : attrs.TagType === "Long" ? integer
      : attrs.TagType === "String" ? validProperty({ ...p, kind: "str" }, b, little, attrs) : true;
    case "text": case "utf8": case "str": {
      if (n < 2) return false;
      const runs = d.getUint16(0, little), start = 2 + 10 * runs;
      if (start > n) return false;
      let previous = 0;
      for (let k = 0; k < runs; k++) {
        const at = d.getUint16(2 + 10 * k, little);
        if (at < previous || at > n - start) return false;
        previous = at;
      }
      return true;
    }
    case "fonttable": {
      if (n < 4) return false;
      let at = 4;
      for (let k = 0; k < d.getUint16(2, little); k++) {
        if (at + 6 > n) return false;
        at += 6 + d.getUint16(at + 4, little);
        if (at > n) return false;
      }
      return at === n;
    }
    default: return true;
  }
}

// CDXML permits symbolic IDs; CDX uses 32-bit object IDs and references to those same IDs.
function numericObjectIds(root: CdxElement): CdxElement {
  const ids = new Map<string, string>(), used = new Set<number>();
  let count = 0;
  const walk = (x: CdxElement, visit: (x: CdxElement) => void, depth = 0) => {
    if (depth > MAX_DEPTH) throw new Error(`CDX export failed: object nesting exceeds ${MAX_DEPTH} levels`);
    if (++count > MAX_OBJECTS) throw new Error(`CDX export failed: object count exceeds ${MAX_OBJECTS}`);
    visit(x);
    for (const child of x.kids) walk(child, visit, depth + 1);
  };
  walk(root, (x) => {
    if (!objectTag.has(x.name)) return;
    const id = x.attrs.id;
    if (id && /^\d+$/.test(id) && Number(id) > 0 && Number(id) <= 0xffffffff) {
      ids.set(id, String(Number(id))); used.add(Number(id));
    }
  });
  let next = 1;
  count = 0;
  walk(root, (x) => {
    const id = x.attrs.id;
    if (objectTag.has(x.name) && id && !ids.has(id)) {
      while (used.has(next)) next++;
      ids.set(id, String(next)); used.add(next++);
    }
  });
  const references = new Set(["B", "E", "object", "SupersededBy", "BondCircularOrdering", "ConnectionOrder"]);
  const copy = (x: CdxElement): CdxElement => ({ ...x, attrs: Object.fromEntries(Object.entries(x.attrs).map(([key, value]) => {
    const kind = byName.get(key)?.kind;
    const isReference = references.has(key) || kind === "ids" || kind === "attachments";
    return [key, key === "id" && objectTag.has(x.name) ? ids.get(value) ?? value
      : isReference ? value.split(/\s+/).map((id) => ids.get(id) ?? id).join(" ") : value];
  })), kids: x.kids.map(copy) });
  return copy(root);
}

/** Convert the existing CDXML parser's ordered output without introducing another XML parser. */
export function cdxElementFromOrderedTree(nodes: Record<string, unknown>[]): CdxElement {
  const elements = (items: Record<string, unknown>[]): CdxElement[] => items.flatMap((node) => {
    const name = Object.keys(node).find((key) => !key.startsWith("#") && key !== ":@" && !key.startsWith("?"));
    if (!name || !Array.isArray(node[name])) return [];
    const children = node[name] as Record<string, unknown>[];
    return [{ name, attrs: Object.fromEntries(Object.entries((node[":@"] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
      kids: elements(children), text: children.map((child) => String(child["#text"] ?? "")).join("") }];
  });
  const root = elements(nodes)[0];
  if (!root || root.name.toLowerCase() !== "cdxml") throw new Error("CDX export failed: expected a CDXML root element");
  root.name = "CDXML";
  return root;
}

export function cdxElementToCdxml(root: CdxElement): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  const write = (x: CdxElement): string => `<${x.name}${Object.entries(x.attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join("")}>${escape(x.text)}${x.kids.map(write).join("")}</${x.name}>`;
  return write(root);
}
// Name on a tag and on a chemical property is plain bytes, not a styled string.
const plainName = (el: CdxElement, p?: Prop): Prop | undefined => (p?.tag === 0x0008 && (el.name === "objecttag" || el.name === "chemicalproperty") ? { ...p, kind: "plain" } : p);

// Supported legacy charsets use their declared encodings; zero-style CDXString is ISO Latin-1.
const LATIN1 = 28591;
const LABELS: Record<number, string> = { 10000: "macintosh", 1252: "windows-1252", 1250: "windows-1250", 1251: "windows-1251", 1253: "windows-1253", 1254: "windows-1254",
  1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257", 1258: "windows-1258", 874: "windows-874", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5",
  866: "ibm866", 10007: "x-mac-cyrillic", 65001: "utf-8", 1200: "utf-16le" };
const decoders = new Map<number, TextDecoder>();
function decoder(charset: number): TextDecoder {
  let d = decoders.get(charset);
  if (!d) {
    d = new TextDecoder(LABELS[charset] ?? "macintosh", { fatal: true });
    decoders.set(charset, d);
  }
  return d;
}
const byteMaps = new Map<number, Map<string, number[]>>();
function charsetBytes(text: string, charset: number, loss: (detail: string) => void): Uint8Array {
  if (charset === 65001) return new TextEncoder().encode(text);
  if (charset === 1200) {
    const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
    for (let k = 0; k < text.length; k++) view.setUint16(2 * k, text.charCodeAt(k), true);
    return bytes;
  }
  if (charset !== LATIN1 && !LABELS[charset]) {
    loss(`unsupported charset ${charset}; using Mac Roman`);
    charset = 10000;
  }
  let map = byteMaps.get(charset);
  if (!map) {
    map = new Map();
    const add = (bytes: number[]) => {
      try {
        const ch = charset === LATIN1 ? String.fromCharCode(bytes[0]) : decoder(charset).decode(new Uint8Array(bytes));
        if ([...ch].length === 1 && !map!.has(ch)) map!.set(ch, bytes);
      } catch { /* An invalid byte sequence is not an encodable character. */ }
    };
    for (let b = 0; b < 256; b++) add([b]);
    if ([932, 936, 949, 950].includes(charset)) {
      for (let hi = 0x80; hi < 256; hi++) for (let lo = 0; lo < 256; lo++) add([hi, lo]);
    }
    byteMaps.set(charset, map);
  }
  const bytes: number[] = [];
  const missing = new Set<string>();
  for (const ch of text) {
    const encoded = map.get(ch);
    if (encoded) { for (const b of encoded) bytes.push(b); }
    else { bytes.push(63); if (missing.size < 16) missing.add(ch); }
  }
  if (missing.size) loss(`characters ${JSON.stringify([...missing].join(""))} cannot be represented in charset ${charset}; replaced with '?'`);
  return new Uint8Array(bytes);
}

// Bytes as uppercase hex and back, as CDXML holds pictures: by table, as a picture can be megabytes.
const HEX = Array.from({ length: 256 }, (_, k) => k.toString(16).padStart(2, "0").toUpperCase());
export function hex(b: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < b.length; i += 0x8000) parts.push(Array.from(b.subarray(i, i + 0x8000), (x) => HEX[x]).join(""));
  return parts.join("");
}
const nibble = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
function unhex(s: string): Uint8Array | undefined {
  if (s.length % 2) return undefined;
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) {
    const hi = nibble(s.charCodeAt(2 * i)), lo = nibble(s.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return undefined;
    b[i] = (hi << 4) | lo;
  }
  return b;
}

export const isCdx = (b: Uint8Array) => b.length >= 8 && MAGIC.split("").every((c, i) => b[i] === c.charCodeAt(0));

// ---------------------------------------------------------------------------------------------------------------
// Reading.

// Decode the CDXML-shaped tree, using full fixed-point precision unless rounded output is requested.
export const NOT_CDX = "CDX import failed: invalid magic; expected VjCD0100";
export function readCdx(bytes: Uint8Array, exact = true, warnings: CdxWarning[] = [], integrity?: { visibleBinaryHash?: string }): CdxElement {
  if (bytes.length > MAX_BYTES) throw new Error("CDX import failed: file exceeds the 64 MB size limit");
  if (!isCdx(bytes)) throw new Error(NOT_CDX);
  if (bytes.length < 28) throw new Error("CDX import failed: truncated header or document object");
  if (![[4, 3, 2, 1], [1, 2, 3, 4]].some((o) => o.every((v, k) => bytes[8 + k] === v))) {
    throw new Error("CDX import failed: invalid byte-order marker");
  }
  // Bytes 8 to 11 give the byte order: 04 03 02 01 little-endian; 01 02 03 04 big-endian.
  const little = bytes[8] === 4, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 22, objects = 0, properties = 0;
  let envelopeRange: [number, number] | undefined;
  const warn = warningSink(warnings);
  let context = "document object";
  const fail = (message: string): never => { throw new Error("CDX import failed: " + message); };
  const need = (n: number) => { if (pos + n > bytes.length) fail(context + " runs " + (pos + n - bytes.length) + " bytes past the end of the file"); };
  const u16 = () => { need(2); const v = view.getUint16(pos, little); pos += 2; return v; };
  const u32 = () => { need(4); const v = view.getUint32(pos, little); pos += 4; return v; };
  const num = (v: number) => (exact ? String(v) : fmt(v));
  const fonts = new Map<number, number>(); // font id to charset code
  let root: CdxElement | undefined;

  // An integer of 1, 2 or 4 bytes, signed or not.
  const int = (d: DataView, signed: boolean): number | undefined =>
    d.byteLength === 1 ? (signed ? d.getInt8(0) : d.getUint8(0)) : d.byteLength === 2 ? (signed ? d.getInt16(0, little) : d.getUint16(0, little)) : d.byteLength === 4 ? (signed ? d.getInt32(0, little) : d.getUint32(0, little)) : undefined;
  const coord = (d: DataView, at: number) => d.getInt32(at, little) / 65536;
  // A styled string: its runs (start, font, face, size, colour) and its bytes. Short of its runs, it is all text.
  const styled = (b: Uint8Array) => {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength), n = b.length >= 2 ? d.getUint16(0, little) : 0;
    if (b.length < 2 || b.length < 2 + 10 * n) return { runs: [] as number[][], text: b };
    return { runs: Array.from({ length: n }, (_, k) => [0, 2, 4, 6, 8].map((o) => d.getUint16(2 + 10 * k + o, little))), text: b.subarray(2 + 10 * n) };
  };
  const decode = (b: Uint8Array, charset: number, el: CdxElement): string => {
    const loss = (detail: string) => warn({ code: "cdx.text_encoding_loss", message: `CDX import: ${detail} in ${el.name} object ${el.attrs.id ?? "0"}`, sourceObjectId: el.attrs.id });
    if (charset === LATIN1) {
      let text = "";
      for (let k = 0; k < b.length; k += 0x8000) text += String.fromCharCode(...b.subarray(k, k + 0x8000));
      return text;
    }
    if (!LABELS[charset]) {
      loss(`unsupported charset ${charset}; using Mac Roman`);
      charset = 10000;
    }
    try { return decoder(charset).decode(b); }
    catch {
      loss(`invalid bytes for charset ${charset}; replaced invalid sequences`);
      return new TextDecoder(LABELS[charset] ?? "macintosh").decode(b);
    }
  };
  // A run's charset: its font's, else the text's caption or label font's, else the document's, else Mac Roman.
  const charsetOf = (font: number, el: CdxElement) => [font, ...[el, root].flatMap((x) => [x?.attrs.CaptionFont, x?.attrs.LabelFont]).map((f) => Number.parseInt(f ?? "", 10))]
    .map((f) => fonts.get(f)).find((c) => c !== undefined) ?? 10000;
  // A text object's runs as CDXML's <s> elements: each run's bytes decoded in its font's charset (UTF-8 for 0x0709).
  const runsOf = (b: Uint8Array, unicode: boolean, el: CdxElement): CdxElement[] => {
    const { runs, text } = styled(b);
    const parts: { run?: number[]; bytes: Uint8Array }[] = [];
    if (!runs.length) parts.push({ bytes: text });
    else {
      if (runs[0][0] > 0) parts.push({ bytes: text.subarray(0, runs[0][0]) });
      runs.forEach((r, k) => parts.push({ run: r, bytes: text.subarray(Math.min(r[0], text.length), Math.min(k + 1 < runs.length ? Math.max(r[0], runs[k + 1][0]) : text.length, text.length)) }));
    }
    return parts.filter((p) => p.bytes.length).map(({ run, bytes: b2 }) => {
      const s: CdxElement = { name: "s", attrs: Object.create(null), kids: [], text: "" };
      if (run && run[1] !== 0xffff) s.attrs.font = String(run[1]);
      if (run && run[3]) s.attrs.size = String(run[3] / 20);
      if (run) s.attrs.color = String(run[4]);
      if (run && run[2]) s.attrs.face = String(run[2]);
      s.text = decode(b2, unicode ? 65001 : runs.length ? charsetOf(run?.[1] ?? -1, el) : LATIN1, el).replace(/\r\n?/g, "\n");
      return s;
    });
  };

  // One property into the element: an attribute, or the children CDXML gives it (tables, represent, text runs).
  const prop = (el: CdxElement, tag: number, b: Uint8Array, text: { legacy?: Uint8Array; unicode?: Uint8Array }) => {
    const p = plainName(el, byTag.get(tag)), d = new DataView(b.buffer, b.byteOffset, b.byteLength), a = el.attrs;
    const kid = (name: string, attrs: Record<string, string>) => { const x: CdxElement = { name, attrs: Object.assign(Object.create(null), attrs), kids: [], text: "" }; return x; };
    const raw = () => { a[p?.name || `attrib${tag.toString(16).padStart(4, "0")}`] = `|x|${hex(b)}`; };
    if (!p) return raw();
    const name = p.name, n = b.length;
    switch (p.kind) {
      case "flag": a[name] = "yes"; return;
      case "bool": a[name] = n === 0 ? (tag === 0x0011 ? "no" : tag === 0x0014 ? "no" : "yes") : b.some((x) => x) ? "yes" : "no"; return;
      case "i8": case "i16": case "i32": case "u16": { const v = int(d, p.kind !== "u16"); if (v !== undefined) a[name] = String(v); return; }
      case "e8": case "e16": { const v = int(d, false), signed = int(d, true); if (v !== undefined) a[name] = p.names!.get(v) ?? p.names!.get(signed!) ?? String(v); return; }
      case "b8": case "b16": {
        const v = int(d, false);
        if (v === undefined) return;
        const set = [...p.names!].filter(([bit]) => bit && (v & bit) === bit).map(([, nm]) => nm);
        a[name] = set.length ? set.join(" ") : p.names!.get(0) ?? "0";
        return;
      }
      case "order": {
        const v = int(d, false);
        if (v === undefined) return;
        a[name] = (n === 1 && v === 0xff) || v === 0xffff ? "any" : [...p.names!].filter(([bit]) => v & bit).map(([, nm]) => nm).join(" ") || "1";
        return;
      }
      case "charge": { const v = n === 4 ? d.getInt32(0, little) / 2 ** 24 : int(d, true); if (v !== undefined) a[name] = String(n === 4 ? +v.toFixed(4) : v); return; }
      case "coord": if (n === 4) a[name] = num(coord(d, 0)); return;
      case "p2": if (n === 8) a[name] = `${num(coord(d, 4))} ${num(coord(d, 0))}`; return;
      case "p3": if (n === 12) a[name] = `${num(coord(d, 8))} ${num(coord(d, 4))} ${num(coord(d, 0))}`; return;
      case "rect": if (n === 16) a[name] = `${num(coord(d, 4))} ${num(coord(d, 0))} ${num(coord(d, 12))} ${num(coord(d, 8))}`; return;
      case "angle": { const v = n === 4 ? d.getInt32(0, little) / 65536 : n === 2 ? d.getInt16(0, little) / 10 : undefined; if (v !== undefined) a[name] = exact ? String(v) : String(+v.toFixed(2)); return; }
      case "deg10": { const v = int(d, true); if (v !== undefined) a[name] = String(v / 10); return; }
      case "spacing": { const v = int(d, false); if (v !== undefined) a[name] = String(v / 10); return; }
      case "alpha": { const v = int(d, false); if (v !== undefined) a[name] = exact ? String(v / 65535) : String(+(v / 65535).toFixed(4)); return; }
      case "f64": if (n === 8) a[name] = String(d.getFloat64(0, little)); return;
      case "lh": { const v = n === 4 ? d.getInt32(0, little) / 65536 : int(d, true); if (v !== undefined) a[name] = n !== 4 && v === 1 ? "auto" : n !== 4 && v === 0 ? "variable" : String(n === 4 ? v : v / 20); return; }
      case "wrap": { const v = n === 4 ? d.getInt32(0, little) / 65536 : int(d, true); if (v !== undefined) a[name] = num(v); return; }
      case "str": a[name] = runsOf(b, tag === 0x1500 || tag === 0x1501, el).map((run) => run.text).join(""); return;
      case "plain": a[name] = decode(b, 10000, el); return;
      case "hex": a[name] = hex(b); return;
      case "ids": if (n % 4 === 0) a[name] = Array.from({ length: n / 4 }, (_, k) => d.getInt32(4 * k, little)).join(" "); return;
      case "attachments": {
        const counted = n >= 2 && n === 2 + 4 * d.getUint16(0, little), at = counted ? 2 : 0;
        if (counted || n % 4 === 0) a[name] = Array.from({ length: (n - at) / 4 }, (_, k) => d.getInt32(at + 4 * k, little)).join(" ");
        return;
      }
      case "linestarts": if (n >= 2 && n === 2 + 2 * d.getUint16(0, little)) a[name] = Array.from({ length: d.getUint16(0, little) }, (_, k) => d.getUint16(2 + 2 * k, little)).join(" "); return;
      case "elist": {
        if (n < 2) return;
        const c = d.getInt16(0, little), m = Math.abs(c);
        if (n === 2 + 2 * m) a[name] = (c < 0 ? "NOT " : "") + Array.from({ length: m }, (_, k) => d.getInt16(2 + 2 * k, little)).join(" ");
        return;
      }
      case "curve": {
        if (n < 2) return;
        const c = d.getUint16(0, little);
        if (n === 2 + 8 * c) a[name] = Array.from({ length: c }, (_, k) => `${num(coord(d, 6 + 8 * k))} ${num(coord(d, 2 + 8 * k))}`).join(" ");
        return;
      }
      // A spectrum's values, each in full (CDXML's YLow and YScale do not apply to them: they are dropped below).
      case "spectrum": if (n % 8 === 0 && n / 8 <= MAX_SPECTRUM) el.text = Array.from({ length: n / 8 }, (_, k) => String(d.getFloat64(8 * k, little))).join(" "); return;
      case "tagvalue": {
        const t = a.TagType;
        if (t === "Double" && n === 8) a[name] = String(d.getFloat64(0, little));
        else if (t === "Long") { const v = int(d, true); if (v !== undefined) a[name] = String(v); }
        else if (t === "String") a[name] = runsOf(b, false, el).map((run) => run.text).join("");
        else raw();
        return;
      }
      case "sgvalue": if (a.SGDataType === "4") a[name] = decode(b, 65001, el); else if (n === 8) a[name] = String(d.getFloat64(0, little)); else raw(); return;
      case "text": text.legacy = b; return;
      case "utf8": text.unicode = b; return;
      // One part of a style record on its own (other writers, Indigo among them, write these).
      case "style": { const v = int(d, false); if (v !== undefined) a[name] = String(name.endsWith("Size") ? v / 20 : v); return; }
      case "labelstyle": case "captionstyle": {
        if (n !== 8) return;
        const which = p.kind === "labelstyle" ? "Label" : "Caption", [font, face, size, colour] = [0, 2, 4, 6].map((o) => d.getUint16(o, little));
        if (font !== 0xffff) a[`${which}Font`] = String(font);
        a[`${which}Face`] = String(face);
        a[`${which}Size`] = String(size / 20);
        a[`${which}Color`] = String(colour);
        return;
      }
      case "fonttable": {
        if (n < 4) return;
        const table = kid("fonttable", {}), count = d.getUint16(2, little);
        let at = 4;
        for (let k = 0; k < count; k++) {
          if (at + 6 > n) return;
          const id = d.getUint16(at, little), cs = d.getUint16(at + 2, little), len = d.getUint16(at + 4, little);
          if (at + 6 + len > n) return;
          const nameBytes = b.subarray(at + 6, at + 6 + len);
          fonts.set(id, cs);
          table.kids.push(kid("font", { id: String(id), charset: charsets.get(cs) ?? "Unknown", name: decode(nameBytes, cs, el) }));
          at += 6 + len;
        }
        if (at === n) el.kids.push(table);
        return;
      }
      case "colortable": {
        const count = n >= 2 ? d.getUint16(0, little) : -1;
        if (n !== 2 + 6 * count) return;
        const c = (v: number) => (v === 0 ? "0" : v === 0xffff ? "1" : exact ? String(v / 65535) : (v / 65535).toFixed(4));
        el.kids.push({ name: "colortable", attrs: Object.create(null), text: "", kids: Array.from({ length: count }, (_, k) => kid("color", { r: c(d.getUint16(2 + 6 * k, little)), g: c(d.getUint16(4 + 6 * k, little)), b: c(d.getUint16(6 + 6 * k, little)) })) });
        return;
      }
      case "represent":
        if (n % 6) return;
        for (let k = 0; k < n / 6; k++) el.kids.push(kid("represent", { attribute: byTag.get(d.getUint16(6 * k + 4, little))?.name || "", object: String(d.getUint32(6 * k, little)) }));
        return;
      default: raw();
    }
  };

  const object = (tag: number, id: number, depth: number): CdxElement => {
    if (++objects > MAX_OBJECTS) fail("object count exceeds " + MAX_OBJECTS);
    if (depth > MAX_DEPTH) fail("object nesting exceeds " + MAX_DEPTH + " levels");
    const el: CdxElement = depth ? { name: OBJECTS[tag] ?? `object${tag.toString(16)}`, attrs: Object.create(null), kids: [], text: "" } : root!;
    if (id) el.attrs.id = String(id);
    const text: { legacy?: Uint8Array; unicode?: Uint8Array } = {}, objects0: CdxElement[] = [];
    for (;;) {
      context = "object " + id + ": truncated tag";
      const propertyStart = pos;
      const t = u16();
      if (t === 0) break;
      if (t & 0x8000) { objects0.push(object(t, u32() | 0, depth + 1)); continue; }
      if (++properties > MAX_PROPERTIES) fail("property count exceeds " + MAX_PROPERTIES);
      context = "property 0x" + t.toString(16).padStart(4, "0") + " in object " + id;
      let len = u16();
      if (len === 0xffff) len = u32();
      need(len);
      const b = bytes.subarray(pos, pos + len);
      pos += len;
      if (depth === 0 && t === 0x4344) {
        if (envelopeRange) fail("duplicate native envelope property");
        envelopeRange = [propertyStart, pos];
      }
      const p = plainName(el, byTag.get(t));
      if (t === 0x4f43 || !validProperty(p, b, little, el.attrs)) {
        warn({ code: "cdx.property_skipped", message: "CDX import: property 0x" + t.toString(16).padStart(4, "0") + " in object " + id + " has unsupported or invalid " + (p?.kind ?? "embedded drawing") + " data (" + len + " bytes); skipped", sourceObjectId: String(id) });
        continue;
      }
      prop(el, t, b, text);
    }
    // UTF-8 text wins over the legacy copy (as CDX reads it).
    if (el.name === "spectrum" && el.text) { delete el.attrs.YLow; delete el.attrs.YScale; }
    const runs = text.unicode?.length ? runsOf(text.unicode, true, el) : text.legacy ? runsOf(text.legacy, false, el) : [];
    el.kids = [...el.kids, ...runs, ...objects0];
    return el;
  };
  // The format writes the document's tag and id after the header; other writers (Indigo) leave them as zeros.
  const tag = u16(), id = u32() | 0;
  if (tag !== 0x8000 && (tag || id)) fail("invalid document object tag 0x" + tag.toString(16).padStart(4, "0"));
  root = { name: "CDXML", attrs: Object.create(null), kids: [], text: "" };
  const result = object(0x8000, id, 0);
  if (integrity && envelopeRange) {
    // Hash all raw bytes except the root envelope, including both text copies and skipped properties.
    const [start, end] = envelopeRange, visible = new Uint8Array(bytes.length - (end - start));
    visible.set(bytes.subarray(0, start));
    visible.set(bytes.subarray(end), start);
    integrity.visibleBinaryHash = sha256Hex(visible);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Writing.

// A growing byte buffer, little-endian.
class Out {
  b = new Uint8Array(1 << 16);
  n = 0;
  room(k: number) {
    if (this.n + k > MAX_BYTES) throw new Error("CDX export failed: file exceeds the 64 MB size limit");
    if (this.n + k <= this.b.length) return;
    const next = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    next.set(this.b.subarray(0, this.n));
    this.b = next;
  }
  bytes(x: ArrayLike<number>) { this.room(x.length); this.b.set(x, this.n); this.n += x.length; }
  u16(v: number) { this.room(2); new DataView(this.b.buffer).setUint16(this.n, v & 0xffff, true); this.n += 2; }
  u32(v: number) { this.room(4); new DataView(this.b.buffer).setUint32(this.n, v >>> 0, true); this.n += 4; }
  done() { return this.b.slice(0, this.n); }
}
// Little-endian values as bytes.
const le = (size: 1 | 2 | 4, ...vs: number[]) => {
  const b = new Uint8Array(size * vs.length), d = new DataView(b.buffer);
  vs.forEach((v, k) => (size === 1 ? d.setUint8(k, v & 0xff) : size === 2 ? d.setUint16(2 * k, v & 0xffff, true) : d.setUint32(4 * k, v >>> 0, true)));
  return b;
};
const f64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; };
const enc = new TextEncoder();
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,3})?$/;
const real = (s?: string) => { const t = s?.trim(); return t && NUMBER.test(t) && Math.abs(Number(t)) < 1e9 ? Number(t) : undefined; };
const reals = (s: string) => s.trim().split(/\s+/).map(real);
// Whole numbers in a list (ids reach 2^31).
const ints = (s: string) => (s.trim() ? s.trim().split(/\s+/) : []).map((v) => (/^-?\d{1,10}$/.test(v) && Math.abs(Number(v)) < 2 ** 32 ? Number(v) : undefined));
const fixed = (v: number) => Math.round(v * 65536);
export function writeCdx(root: CdxElement, warnings: CdxWarning[] = []): Uint8Array {
  root = numericObjectIds(root);
  const emitWarning = warningSink(warnings);
  const warn = (x: CdxElement, detail: string) => emitWarning({ code: "cdx.unencodable_data", message: "CDX export: " + detail + " in " + x.name + " object " + (x.attrs.id ?? "0") + " was omitted", sourceObjectId: x.attrs.id });
  const encodingLoss = (x: CdxElement) => (detail: string) => emitWarning({ code: "cdx.text_encoding_loss", message: `CDX export: ${detail} in ${x.name} object ${x.attrs.id ?? "0"}`, sourceObjectId: x.attrs.id });
  const fonts = new Map<number, number>();
  const gatherFonts = (x: CdxElement) => {
    if (x.name === "font") fonts.set(Number(x.attrs.id), charsetCode.get(x.attrs.charset ?? "") ?? 0);
    x.kids.forEach(gatherFonts);
  };
  gatherFonts(root);
  const charsetOf = (font: number, el: CdxElement) => [font, ...[el, root].flatMap((x) => [Number(x.attrs.CaptionFont), Number(x.attrs.LabelFont)])]
    .map((id) => fonts.get(id)).find((cs) => cs !== undefined) ?? 10000;
  const stringBytes = (text: string, x: CdxElement, charset = 10000) => charsetBytes(text, charset, encodingLoss(x));
  const plainString = (text: string, x: CdxElement, unicode = false) => {
    // Unstyled strings are Latin-1. A styled default-font run can represent additional characters.
    const styled = !unicode && [...text].some((ch) => ch.codePointAt(0)! > 255);
    const data = stringBytes(text, x, unicode ? 65001 : styled ? charsetOf(-1, x) : LATIN1);
    const prefix = styled ? le(2, 1, 0, 0xffff, 0, 0, 3) : le(2, 0);
    const bytes = new Uint8Array(prefix.length + data.length);
    bytes.set(prefix); bytes.set(data, prefix.length);
    return bytes;
  };
  const checkAttrs = (x: CdxElement, allowed: string[]) => {
    for (const key of Object.keys(x.attrs)) if (!allowed.includes(key)) warn(x, `unknown attribute ${key}`);
  };
  const out = new Out();
  out.bytes(HEADER);
  const docStyle: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.attrs)) if (/^(Label|Caption)(Font|Face|Size|Color)$/.test(k)) docStyle[k] = v;
  let properties = 0;
  const put = (tag: number, data: Uint8Array) => {
    if (++properties > MAX_PROPERTIES) throw new Error("CDX export failed: property count exceeds " + MAX_PROPERTIES);
    out.u16(tag);
    if (data.length >= 0xffff) { out.u16(0xffff); out.u32(data.length); } else out.u16(data.length);
    out.bytes(data);
  };
  // An attribute's bytes, by its tag's kind; undefined when the value does not fit it.
  const value = (el: CdxElement, p: Prop, v: string): Uint8Array | undefined => {
    const i = Number.parseInt(v, 10), r = real(v), list = reals(v), whole = ints(v);
    const isInteger = /^[-+]?\d+$/.test(v.trim());
    const widths: Record<string, [number, number]> = { i8: [-128, 127], i16: [-32768, 32767], u16: [0, 65535], i32: [-2147483648, 4294967295] };
    const range = widths[p.kind];
    if (range && (!isInteger || i < range[0] || i > range[1])) return undefined;
    if (["coord", "p2", "p3", "rect", "angle", "curve"].includes(p.kind) && list.some((x) => x !== undefined && (fixed(x) < -2147483648 || fixed(x) > 2147483647))) return undefined;
    if (p.kind === "charge" && r !== undefined && (r < -128 || r >= 128)) return undefined;
    const named = (s: string) => p.values!.get(s) ?? [...p.values!].find(([nm]) => nm.toLowerCase() === s.toLowerCase())?.[1] ?? (/^-?\d+$/.test(s) ? Number(s) : undefined);
    switch (p.kind) {
      case "flag": return /^(yes|true)$/.test(v) ? new Uint8Array(0) : undefined;
      case "bool": return le(1, /^(yes|true)$/.test(v) ? 1 : 0);
      case "i8": return Number.isFinite(i) ? le(1, i) : undefined;
      case "i16": case "u16": return Number.isFinite(i) ? le(2, i) : undefined;
      case "i32": return Number.isFinite(i) ? le(4, i) : undefined;
      case "e8": case "e16": { const x = named(v.trim()), small = p.kind === "e8"; return x === undefined || x < (small ? -128 : -32768) || x > (small ? 255 : 65535) ? undefined : le(small ? 1 : 2, x); }
      case "b8": case "b16": {
        const bits = v.trim().split(/\s+/).map(named);
        return bits.some((x) => x === undefined) ? undefined : le(p.kind === "b8" ? 1 : 2, bits.reduce((s: number, x) => s | x!, 0));
      }
      case "order": {
        if (v.trim() === "any") return le(2, 0xffff);
        const bits = v.trim().split(/\s+/).map((s) => p.values!.get(s));
        return bits.some((x) => x === undefined) ? undefined : le(2, bits.reduce((s: number, x) => s | x!, 0));
      }
      case "charge": return r === undefined ? undefined : Number.isInteger(r) && Math.abs(r) < 128 ? le(1, r) : le(4, Math.round(r * 2 ** 24));
      case "coord": return r === undefined ? undefined : le(4, fixed(r));
      case "p2": return list.length >= 2 && list[0] !== undefined && list[1] !== undefined ? le(4, fixed(list[1]), fixed(list[0])) : undefined;
      case "p3": return list.length >= 2 && list.slice(0, 3).every((x) => x !== undefined) ? le(4, fixed(list[2] ?? 0), fixed(list[1]!), fixed(list[0]!)) : undefined;
      case "rect": return list.length === 4 && list.every((x) => x !== undefined) ? le(4, fixed(list[1]!), fixed(list[0]!), fixed(list[3]!), fixed(list[2]!)) : undefined;
      case "angle": return r === undefined ? undefined : le(4, fixed(r));
      case "deg10": return r === undefined ? undefined : le(2, Math.round(r * 10));
      case "spacing": return r === undefined ? undefined : le(2, Math.round(r * 10));
      case "alpha": return r === undefined ? undefined : le(2, Math.round(Math.min(1, Math.max(0, r)) * 65535));
      case "f64": return r === undefined ? undefined : f64(r);
      case "lh": return v === "auto" ? le(2, 1) : v === "variable" ? le(2, 0) : r === undefined ? undefined : le(2, Math.round(r * 20));
      case "wrap": return r === undefined ? undefined : le(2, Math.round(r));
      case "str": return plainString(v.replace(/\n/g, "\r"), el, p.tag === 0x1500 || p.tag === 0x1501);
      case "plain": return stringBytes(v, el);
      case "hex": return unhex(v.trim());
      case "ids": return whole.every((x) => x !== undefined) ? le(4, ...(whole as number[])) : undefined;
      case "attachments": return whole.every((x) => x !== undefined) ? new Uint8Array([...le(2, whole.length), ...le(4, ...(whole as number[]))]) : undefined;
      case "linestarts": return whole.every((x) => x !== undefined) ? le(2, whole.length, ...(whole as number[])) : undefined;
      case "elist": {
        const not = /^NOT\s/.test(v), ids = reals(v.replace(/^NOT\s+/, ""));
        return ids.every((x) => x !== undefined) ? le(2, not ? -ids.length : ids.length, ...(ids as number[])) : undefined;
      }
      case "curve": {
        if (list.length % 2 || list.some((x) => x === undefined) || list.length / 2 > MAX_POINTS) return undefined;
        const pts: number[] = [];
        for (let k = 0; k < list.length; k += 2) pts.push(fixed(list[k + 1]!), fixed(list[k]!));
        return new Uint8Array([...le(2, list.length / 2), ...le(4, ...pts)]);
      }
      case "tagvalue": {
        const t = el.attrs.TagType;
        return t === "Double" && r !== undefined ? f64(r) : t === "Long" && Number.isFinite(i) ? le(4, i) : t === "String" ? plainString(v, el) : undefined;
      }
      case "sgvalue": return el.attrs.SGDataType === "4" ? enc.encode(v) : r === undefined ? undefined : f64(r);
      default: return undefined;
    }
  };
  // A raw property kept from a CDX file ("|x|" and hex).
  const rawValue = (v: string) => (v.startsWith("|x|") ? unhex(v.slice(3)) : enc.encode(v));

  // Each run uses its declared/default font charset alongside the UTF-8 copy.
  const textProps = (runs: CdxElement[], owner: CdxElement) => {
    const legacy: number[][] = [], unicode: number[][] = [], legacyBytes: number[] = [], unicodeBytes: number[] = [];
    for (const s of runs) {
      checkAttrs(s, ["font", "size", "color", "face"]);
      const text = s.text.replace(/\r\n?|\n/g, "\r"), font = Number.parseInt(s.attrs.font ?? "", 10), size = real(s.attrs.size), colour = Number.parseInt(s.attrs.color ?? "", 10), face = Number.parseInt(s.attrs.face ?? "", 10);
      const style = [Number.isFinite(font) ? font : 0xffff, Number.isFinite(face) ? face : 0, size ? Math.round(size * 20) : 0, Number.isFinite(colour) ? colour : 3];
      if (!text) continue;
      const u = enc.encode(text);
      unicode.push([unicodeBytes.length, ...style]);
      for (const byte of u) unicodeBytes.push(byte);
      const mac = stringBytes(text, owner, charsetOf(font, owner));
      if (mac.length) { legacy.push([legacyBytes.length, ...style]); for (const byte of mac) legacyBytes.push(byte); }
    }
    if (unicode.length > 65535 || unicode.some((run) => run[0] > 65535)) throw new Error("CDX export failed: styled text exceeds the 65535-byte run-offset limit");
    const pack = (rs: number[][], b: number[]) => new Uint8Array([...le(2, rs.length), ...rs.flatMap((r) => [...le(2, ...r)]), ...b]);
    if (legacy.length) put(0x0700, pack(legacy, legacyBytes));
    if (unicode.length) put(0x0709, pack(unicode, unicodeBytes));
  };

  const object = (x: CdxElement, depth: number) => {
    const tag = objectTag.get(x.name);
    if (depth > MAX_DEPTH) throw new Error("CDX export failed: object nesting exceeds " + MAX_DEPTH + " levels");
    if (tag === undefined) { warn(x, "unsupported element <" + x.name + ">"); return; }
    out.u16(tag);
    out.u32(Number.parseInt(x.attrs.id ?? "0", 10) || 0);
    const style: Record<string, string> = {};
    for (const [k, v] of Object.entries(x.attrs)) {
      if (k === "id") continue;
      const m = /^attrib([0-9a-f]{4})$/.exec(k);
      if (m) {
        const rawTag = parseInt(m[1], 16), b = rawValue(v);
        if (!rawTag || rawTag & 0x8000 || rawTag === 0x4f43 || !b) warn(x, "unencodable attribute " + k);
        else put(rawTag, b);
        continue;
      }
      const p = plainName(x, byName.get(k));
      if (!p) { warn(x, "unknown attribute " + k); continue; }
      if (p.kind === "style") { style[k] = v; continue; }
      if (p.kind === "raw" || p.kind === "glist" || ["tagvalue", "sgvalue"].includes(p.kind) && v.startsWith("|x|")) {
        const b = rawValue(v);
        if (b) put(p.tag, b); else warn(x, `unencodable attribute ${k}`);
        continue;
      }
      // Width and Height on a TLC spot, and its Tail, are whole 1/65536 pt.
      const kind = x.name === "tlcspot" && (k === "Width" || k === "Height") ? { ...p, kind: "i32" } : p;
      const b = value(x, kind, v);
      if (b) put(p.tag, b);
      else if (!(p.kind === "flag" && /^(no|false)$/.test(v))) warn(x, "unencodable attribute " + k + "=" + JSON.stringify(v));
    }
    // Label and caption styles: CDXML's four attributes as one 8-byte record, the document's filling any part left out.
    for (const which of ["Label", "Caption"]) {
      if (!STYLE_PARTS.some((part) => style[which + part] !== undefined)) continue;
      const part = (s: string, d: number) => { const v = real(style[which + s] ?? docStyle[which + s]); return v === undefined ? d : v; };
      put(which === "Label" ? 0x080a : 0x080b, le(2, part("Font", 0xffff), part("Face", 0), Math.round(part("Size", 10) * 20), part("Color", 3)));
    }
    // Children CDXML holds that CDX holds as properties.
    for (const k of x.kids) {
      if (["colortable", "fonttable"].includes(k.name)) checkAttrs(k, []);
      if (k.name === "colortable") for (const color of k.kids) checkAttrs(color, ["r", "g", "b"]);
      if (k.name === "colortable") put(0x0300, new Uint8Array([...le(2, k.kids.length), ...k.kids.flatMap((c) => [...le(2, ...["r", "g", "b"].map((ch) => Math.round(Math.min(1, Math.max(0, real(c.attrs[ch]) ?? 0)) * 65535)))])]));
      if (k.name === "fonttable") {
        const entries: number[] = [];
        let count = 0;
        for (const f of k.kids) {
          checkAttrs(f, ["id", "charset", "name"]);
          const id = Number.parseInt(f.attrs.id ?? "", 10), cs = charsetCode.get(f.attrs.charset ?? "") ?? 0;
          if (!Number.isFinite(id)) { warn(f, "unencodable font ID"); continue; }
          count++;
          const nm = stringBytes(f.attrs.name ?? "", f, cs);
          entries.push(...le(2, id, cs, nm.length), ...nm);
        }
        put(0x0100, new Uint8Array([...le(2, 1, count), ...entries]));
      }
    }
    const represent = x.kids.filter((k) => k.name === "represent").flatMap((k) => {
      checkAttrs(k, ["attribute", "object"]);
      const tagOf = byName.get(k.attrs.attribute ?? "")?.tag, id = Number.parseInt(k.attrs.object ?? "", 10);
      if (tagOf === undefined || !Number.isFinite(id)) warn(k, "unencodable property reference");
      return tagOf === undefined || !Number.isFinite(id) ? [] : [...le(4, id), ...le(2, tagOf)];
    });
    if (represent.length) put(0x000e, new Uint8Array(represent));
    // A spectrum's values in full: CDXML's text times YScale (when it is not 0 or 1), plus YLow.
    if (x.name === "spectrum" && x.text.trim()) {
      const v = x.text.trim().split(/\s+/).map(Number), scale = Number(x.attrs.YScale ?? 0), low = Number(x.attrs.YLow ?? 0), f = Number.isFinite(scale) && scale !== 0 ? scale : 1;
      if (v.length <= MAX_SPECTRUM && v.every(Number.isFinite) && Number.isFinite(low)) {
        const b = new Uint8Array(8 * v.length), dv = new DataView(b.buffer);
        v.forEach((n, k) => dv.setFloat64(8 * k, n * f + low, true));
        put(0x0a86, b);
      }
    }
    const runs = x.kids.filter((k) => k.name === "s");
    // ChemDraft's CDXML writer also emits plain text directly inside <t>.
    if (x.name === "t" && x.text.length) runs.unshift({ name: "s", attrs: {}, kids: [], text: x.text });
    if (runs.length) textProps(runs, x);
    for (const k of x.kids) if (!["colortable", "fonttable", "represent", "s"].includes(k.name)) object(k, depth + 1);
    out.u16(0);
  };
  object(root, 0);
  return out.done();
}
