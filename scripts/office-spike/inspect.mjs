import { readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename, posix } from 'node:path';
import { readZip } from './zip.mjs';
import { pathToFileURL } from 'node:url';
import { sha256, checkEnvelope, hasPayloadMarker } from './payload.mjs';
import { pngFindings } from './png.mjs';
import { svgFindings, isSvg } from './svg.mjs';
import { pdfFindings } from './pdf.mjs';
import { emfFindings } from './emf.mjs';

export function inspectBlob(buf, container, entry = basename(container), expect) {
  let type = 'other', findings = [], image = null, error = null, notes = [];
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') type = 'png';
  else if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') type = 'jpeg';
  else if (buf.subarray(0, 5).toString() === '%PDF-') type = 'pdf';
  else if (isSvg(buf)) type = 'svg';
  else if (buf.subarray(0, 3).toString() === 'GIF') type = 'gif';
  else if (['49492a00', '4d4d002a'].includes(buf.subarray(0, 4).toString('hex'))) type = 'tiff';
  else if (buf.length >= 44 && buf.readUInt32LE(0) === 1 && buf.toString('ascii', 40, 44) === ' EMF') type = 'emf';
  else if (buf.subarray(0, 4).toString('hex') === 'd7cdc69a' || (buf.length >= 18 && [1, 2].includes(buf.readUInt16LE(0)) && buf.readUInt16LE(2) === 9 && [0x100, 0x300].includes(buf.readUInt16LE(4)))) type = 'wmf';
  try {
    if (type === 'png') { const result = pngFindings(buf); findings = result.found; notes = result.notes; image = { width: result.width, height: result.height, dpi: result.dpi }; }
    if (type === 'svg') findings = svgFindings(buf);
    if (type === 'pdf') findings = pdfFindings(buf);
    if (type === 'emf') findings = emfFindings(buf);
    if (type === 'other' && (checkEnvelope(buf).ok || (/^\s*\{/.test(buf.toString('utf8', 0, 40)) && hasPayloadMarker(buf)))) findings = [{ carrier: 'private JSON', envelope: buf }];
    else if (!['png', 'svg', 'pdf', 'emf'].includes(type) && hasPayloadMarker(buf)) findings = [{ carrier: 'raw marker', note: 'marker present, container not decoded' }];
  } catch (e) { error = e.message; }
  notes = [...notes, ...(findings.notes ?? [])];
  return { container, entry, type, size: buf.length, sha256: sha256(buf), image, notes, findings: findings.map(({ envelope, ...item }) => {
    const checked = envelope ? checkEnvelope(envelope) : null;
    return { ...item, ...(checked ? { envelope: checked, matchesExpect: expect ? checked.ok && checked.sha256 === expect : null } : {}) };
  }), error, ...(type === 'other' ? { firstBytes: buf.subarray(0, 16).toString('hex'), guess: buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' ? 'OLE compound file (not a ZIP)' : /^\s*</.test(buf.toString('utf8', 0, 40)) ? 'XML/text (not a ZIP)' : 'unknown blob (not a ZIP)' } : {}) };
}

const xmlText = text => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10));
  return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[entity];
});
function relationshipReferences(entries) {
  const references = new Map();
  for (const rel of entries.filter(x => /(?:^|\/)_rels\/[^/]*\.rels$/.test(x.name))) {
    const match = /^(?:(.*)\/)?_rels\/(.*)\.rels$/.exec(rel.name);
    if (!match) continue;
    const part = posix.join(match[1] ?? '', match[2]);
    const xml = rel.data.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)) {
      const attrs = Object.fromEntries([...tag[1].matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], xmlText(m[2] ?? m[3])]));
      if (!attrs.Target || attrs.TargetMode === 'External') continue;
      const targetUri = attrs.Target.split('#')[0];
      const target = posix.normalize(targetUri.startsWith('/') ? decodeURIComponent(targetUri).slice(1) : posix.join(posix.dirname(part), decodeURIComponent(targetUri)));
      if (target.startsWith('../')) continue;
      if (!references.has(target)) references.set(target, new Set());
      references.get(target).add(part || '/');
    }
  }
  return references;
}
export function inspectPath(path, expect) {
  const stat = statSync(path);
  if (stat.isDirectory()) return readdirSync(path).filter(name => name !== 'index.json' && name !== 'manifest.json').flatMap(name => inspectPath(join(path, name), expect));
  if (stat.size > 200 * 1024 * 1024) throw new Error(`Input exceeds 200 MB: ${path}`);
  const buf = readFileSync(path);
  const signature = buf.subarray(0, 4).toString('hex');
  if (['504b0304', '504b0506', '504b0708'].includes(signature) || /\.(docx|pptx|xlsx|zip)$/i.test(path)) {
    try {
      const entries = readZip(buf), references = relationshipReferences(entries);
      return entries.filter(x => /(?:^|\/)(media|embeddings)\//i.test(x.name) || /\.(png|jpe?g|pdf|svg|emf|wmf|tiff?|gif)$/i.test(x.name)).map(x => {
        const row = inspectBlob(x.data, path, x.name, expect);
        return { ...row, notes: [...row.notes, ...(entries.notes ?? [])], references: [...(references.get(x.name) ?? [])] };
      });
    } catch (error) {
      return [{ ...inspectBlob(buf, path, basename(path), expect), error: error.message, firstBytes: buf.subarray(0, 16).toString('hex'), guess: signature.startsWith('504b') ? 'ZIP signature; invalid or unsupported archive' : 'not a ZIP' }];
    }
  }
  return [inspectBlob(buf, path, basename(path), expect)];
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const index = args.indexOf('--expect');
  const expect = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && !/^[a-f\d]{64}$/i.test(expect ?? '')) throw new Error('--expect requires a SHA-256 hex digest');
  if (index >= 0) args.splice(index, 2);
  const paths = args.filter(x => x !== '--json');
  if (!paths.length) { console.error('Usage: inspect.mjs <path...> [--expect <sha256>] [--json]'); process.exitCode = 2; }
  else {
    const rows = paths.flatMap(path => { try { return inspectPath(path, expect); } catch (error) { return [{ container: path, error: error.message }]; } });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log('Container\tEntry\tType\tBytes\tSHA-256\tPixels / DPI\tReferences\tCarriers / errors / blob guess\tNotes');
      for (const row of rows) console.log([row.container, row.entry, row.type, row.size, row.sha256, row.image ? `${row.image.width}x${row.image.height} / ${row.image.dpi?.join('x') ?? 'unspecified'}` : '', row.references?.join(', '), row.error ?? (row.findings?.map(f => `${f.carrier}: ${f.envelope?.ok ? 'valid' : f.error || f.envelope?.reason || f.note}${f.envelope?.notes ? `; ${f.envelope.notes.join('; ')}` : ''}${f.matchesExpect === null || f.matchesExpect === undefined ? '' : `; expect=${f.matchesExpect}`}`).join(', ') || `${row.guess ?? ''} ${row.firstBytes ?? ''}`), row.notes?.join('; ')].join('\t'));
    }
    if (rows.some(row => row.error || row.findings?.some(f => f.error || f.envelope?.ok === false || f.matchesExpect === false))) process.exitCode = 1;
  }
}
