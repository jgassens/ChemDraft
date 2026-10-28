import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { MAX_ENVELOPE, SVG_NAMESPACE, hasPayloadMarker } from './payload.mjs';

// A bounded lexical scan only: declarations (including DTD subsets) are skipped,
// never interpreted, and no entities or external resources are resolved.
function* markup(text) {
  if (Buffer.byteLength(text) > 200 * 1024 * 1024) throw new Error('SVG exceeds 200 MB');
  let p = 0;
  while ((p = text.indexOf('<', p)) >= 0) {
    const start = p;
    const terminator = text.startsWith('<!--', p) ? '-->' : text.startsWith('<?', p) ? '?>' : text.startsWith('<![CDATA[', p) ? ']]>' : null;
    if (terminator) {
      const end = text.indexOf(terminator, p + 2);
      if (end < 0) return;
      p = end + terminator.length;
    } else {
      let quote = '', subset = 0;
      const doctype = text.startsWith('<!DOCTYPE', start);
      for (p++; p < text.length; p++) {
        const c = text[p];
        if (quote) { if (c === quote) quote = ''; }
        else if (doctype && text.startsWith('<!--', p)) {
          const end = text.indexOf('-->', p + 4);
          if (end < 0) return;
          p = end + 2;
        }
        else if (doctype && text.startsWith('<?', p)) {
          const end = text.indexOf('?>', p + 2);
          if (end < 0) return;
          p = end + 1;
        }
        else if (c === '"' || c === "'") quote = c;
        else if (doctype && c === '[') subset++;
        else if (subset && c === ']') subset--;
        else if (c === '>' && !subset) { p++; break; }
      }
    }
    yield { start, end: p, raw: text.slice(start, p) };
  }
}

export function isSvg(buf) {
  // Avoid decoding a whole binary blob merely to sniff its type. An all-whitespace
  // prefix is allowed to continue so long SVG prologs are still recognised.
  if (!/^\s*(?:<|$)/.test(buf.toString('utf8', 0, Math.min(buf.length, 2048)))) return false;
  const text = buf.toString('utf8');
  let end = 0;
  for (const token of markup(text)) {
    if (text.slice(end, token.start).trim()) return false;
    if (!/^<(!|\?)/.test(token.raw)) return /^<(?:[\w.-]+:)?svg\b/i.test(token.raw);
    end = token.end;
  }
  return false;
}

export function makeSvg(input, envelope, kind) {
  const text = input.toString('utf8');
  const root = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(text);
  if (!root || /\/$/.test(root[0].slice(0, -1).trim())) throw new Error('SVG root start tag not found');
  const value = deflateRawSync(envelope).toString('base64');
  const child = kind === 'metadata'
    ? `<metadata><chemdraft:payload xmlns:chemdraft="https://chemdraft.ai/ns/spike/1" encoding="base64-deflate">${value}</chemdraft:payload></metadata>`
    : `<!-- chemdraft:${value} -->`;
  const at = root.index + root[0].length;
  return Buffer.from(text.slice(0, at) + child + text.slice(at));
}

// Advance past each name/value once, including malformed or unterminated ones.
// Retrying an unanchored attribute regex at every character makes long names
// without '=' quadratic.
function attributes(raw) {
  const attrs = new Map();
  let p = 0;
  while (p < raw.length) {
    if (!/[\w.:-]/.test(raw[p])) { p++; continue; }
    const start = p++;
    while (p < raw.length && /[\w.:-]/.test(raw[p])) p++;
    const name = raw.slice(start, p);
    while (p < raw.length && /\s/.test(raw[p])) p++;
    if (raw[p] !== '=') continue;
    p++;
    while (p < raw.length && /\s/.test(raw[p])) p++;
    const quote = raw[p];
    if (quote !== '"' && quote !== "'") continue;
    const end = raw.indexOf(quote, p + 1);
    if (end < 0) break;
    attrs.set(name, raw.slice(p + 1, end));
    p = end + 1;
  }
  return attrs;
}

export function svgFindings(buf) {
  const text = buf.toString('utf8'), result = [];
  const decode = (carrier, encoded) => {
    try { result.push({ carrier, envelope: inflateRawSync(Buffer.from(encoded, 'base64'), { maxOutputLength: MAX_ENVELOPE }) }); }
    catch (error) { result.push({ carrier, error: error.message }); }
  };
  const stack = [];
  for (const token of markup(text)) {
    if (token.raw.startsWith('<!--')) {
      const body = token.raw.slice(4, token.raw.endsWith('-->') ? -3 : undefined);
      const marker = /^\s*chemdraft:/.exec(body);
      const encoded = marker ? body.slice(marker[0].length) : '';
      if (/^[A-Za-z0-9+/=\s]+$/.test(encoded)) decode('svg comment', encoded);
      continue;
    }
    const tag = /^<(\/)?([\w.-]+(?::[\w.-]+)?)\b/.exec(token.raw);
    if (!tag) continue;
    const name = tag[2];
    if (tag[1]) {
      const current = stack.pop();
      if (current?.name !== name) { stack.length = 0; continue; }
      if (current.payload) {
        const encoded = text.slice(current.start, token.start).trim();
        if (/^[A-Za-z0-9+/=\s]+$/.test(encoded)) decode('svg metadata', encoded);
      }
      continue;
    }
    if (stack.length >= 256) break;
    const attrs = attributes(token.raw);
    const namespaces = new Map(stack.at(-1)?.namespaces);
    for (const [key, value] of attrs) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
    }
    const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
    if (!/\/\s*>$/.test(token.raw)) stack.push({ name, namespaces, start: token.end,
      payload: local === 'payload' && namespaces.get(prefix) === SVG_NAMESPACE && attrs.get('encoding') === 'base64-deflate' });
  }
  if (!result.length && hasPayloadMarker(buf)) result.push({ carrier: 'svg marker', note: 'marker present, structure not recognised' });
  return result;
}
