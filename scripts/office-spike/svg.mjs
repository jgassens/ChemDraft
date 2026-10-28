import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { MAX_ENVELOPE } from './payload.mjs';

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
export function svgFindings(buf) {
  const text = buf.toString('utf8'), result = [];
  const patterns = [
    ['svg metadata', /<chemdraft:payload\b[^>]*\bxmlns:chemdraft=["']https:\/\/chemdraft\.ai\/ns\/spike\/1["'][^>]*\bencoding=["']base64-deflate["'][^>]*>([A-Za-z0-9+/=\s]+)<\/chemdraft:payload\s*>/g],
    ['svg comment', /<!--\s*chemdraft:([A-Za-z0-9+/=]+)\s*-->/g],
  ];
  for (const [carrier, pattern] of patterns) for (const match of text.matchAll(pattern)) {
    try { result.push({ carrier, envelope: inflateRawSync(Buffer.from(match[1], 'base64'), { maxOutputLength: MAX_ENVELOPE }) }); }
    catch (error) { result.push({ carrier, error: error.message }); }
  }
  return result;
}
