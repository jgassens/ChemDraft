import { readFileSync, writeFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename, posix } from 'node:path';
import { readZip } from './zip.mjs';
import { pathToFileURL } from 'node:url';
import { sha256, checkEnvelope, hasPayloadMarker } from './payload.mjs';
import { pngFindings } from './png.mjs';
import { svgFindings, isSvg } from './svg.mjs';
import { pdfFindings } from './pdf.mjs';
import { emfFindings } from './emf.mjs';
import { rtfPictures } from './rtf.mjs';
import { scanPictures } from './scan.mjs';

export function inspectBlob(buf, container, entry = basename(container), expect, context = { depth: 0, budget: { count: 0, bytes: 0 } }) {
  let type = 'other', findings = [], image = null, error = null, notes = [];
  const nestedEntries = [];
  let budgetFailed = false, sniffed = false;
  const nested = (bytes, label, metadata) => {
    const failBudget = message => { budgetFailed = true; throw new Error(message); };
    if (context.depth >= 4) failBudget('Nested picture depth exceeds 4');
    if (++context.budget.count > 2000) failBudget('Nested entry count exceeds 2000');
    if (context.budget.bytes + bytes.length > 200 * 1024 * 1024) failBudget('Nested inspection bytes exceed 200 MB');
    context.budget.bytes += bytes.length;
    const row = inspectBlob(bytes, container, `${entry} > ${label}`, expect, {
      depth: context.depth + 1, budget: context.budget, emfFormat: label.startsWith('EMF multiformat'),
    });
    nestedEntries.push({ ...row, ...metadata });
  };
  try {
    if (buf.length > 200 * 1024 * 1024) throw new Error('Input exceeds 200 MB');
    if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') type = 'png';
    else if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') type = 'jpeg';
    else if (buf.subarray(0, 5).toString() === '%PDF-') type = 'pdf';
    else if (buf.subarray(0, 5).toString() === '{\\rtf') type = 'rtf';
    else if (isSvg(buf)) type = 'svg';
    else if (buf.subarray(0, 3).toString() === 'GIF') type = 'gif';
    else if (['49492a00', '4d4d002a'].includes(buf.subarray(0, 4).toString('hex'))) type = 'tiff';
    else if (buf.length >= 44 && buf.readUInt32LE(0) === 1 && buf.toString('ascii', 40, 44) === ' EMF') type = 'emf';
    else if (buf.subarray(0, 4).toString('hex') === 'd7cdc69a' || (buf.length >= 18 && [1, 2].includes(buf.readUInt16LE(0)) && buf.readUInt16LE(2) === 9 && [0x100, 0x300].includes(buf.readUInt16LE(4)))) type = 'wmf';
    sniffed = true;
    if (context.emfFormat) entry += ` (${type.toUpperCase()})`;
    if (type === 'png') { const result = pngFindings(buf); findings = result.found; notes = result.notes; image = { width: result.width, height: result.height, dpi: result.dpi }; }
    if (type === 'svg') findings = svgFindings(buf);
    if (type === 'pdf') findings = pdfFindings(buf);
    if (type === 'emf') findings = emfFindings(buf, nested);
    if (type === 'rtf') rtfPictures(buf, nested);
    if (type === 'other' && (checkEnvelope(buf).ok || (/^\s*\{/.test(buf.toString('utf8', 0, 40)) && hasPayloadMarker(buf)))) findings = [{ carrier: 'private JSON', envelope: buf }];
    else if (!['png', 'svg', 'pdf', 'emf', 'rtf'].includes(type) && hasPayloadMarker(buf)) findings = [{ carrier: 'raw marker', note: 'marker present, container not decoded' }];
  } catch (e) { error = e.message; nestedEntries.length = 0; findings = []; }
  // Independently recover opaque pictures when typed parsing failed or found none.
  // Keep the input size guard ahead of the fallback as well.
  if (sniffed && !budgetFailed && buf.length <= 200 * 1024 * 1024 &&
      (error || (!findings.some(f => f.carrier !== 'raw marker') && !nestedEntries.length)) &&
      !['png', 'svg', 'pdf', 'jpeg', 'gif', 'tiff'].includes(type)) {
    try { scanPictures(buf, nested, note => notes.push(note)); }
    catch (e) { error = e.message; }
  }
  if (type === 'rtf' && !nestedEntries.length && hasPayloadMarker(buf)) {
    findings.push({ carrier: 'raw marker', note: 'marker present, container not decoded' });
  }
  notes = [...notes, ...(findings.notes ?? [])];
  return { container, entry, type, size: buf.length, sha256: sha256(buf), image, notes, findings: findings.map(({ envelope, ...item }) => {
    const checked = envelope ? checkEnvelope(envelope) : null;
    return { ...item, ...(checked ? { envelope: checked, matchesExpect: expect ? checked.ok && checked.sha256 === expect : null } : {}) };
  }), error, ...(nestedEntries.length ? { nestedEntries } : {}), ...(type === 'other' ? { firstBytes: buf.subarray(0, 16).toString('hex'), guess: buf.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' ? 'OLE compound file (not a ZIP)' : /^\s*</.test(buf.toString('utf8', 0, 40)) ? 'XML/text (not a ZIP)' : 'unknown blob (not a ZIP)' } : {}) };
}

function flattenRows({ nestedEntries = [], ...row }) {
  return [row, ...nestedEntries.flatMap(child => flattenRows({ ...child, references: row.references }))];
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
export function inspectPath(path, expect, traversal = { depth: 0, budget: { count: 0 } }) {
  const failure = error => [{ container: path, entry: basename(path), error }];
  if (++traversal.budget.count > 2000) return failure('Input path count exceeds 2000');
  const stat = statSync(path);
  if (stat.isDirectory()) {
    if (traversal.depth >= 4) return failure('Input directory depth exceeds 4');
    const names = readdirSync(path).filter(name => name !== 'index.json' && name !== 'manifest.json');
    if (names.length > 2000 - traversal.budget.count) return failure('Input path count exceeds 2000');
    return names.flatMap(name => inspectPath(join(path, name), expect, { depth: traversal.depth + 1, budget: traversal.budget }));
  }
  if (stat.size > 200 * 1024 * 1024) return failure('Input exceeds 200 MB');
  const buf = readFileSync(path);
  const signature = buf.subarray(0, 4).toString('hex');
  if (['504b0304', '504b0506', '504b0708'].includes(signature) || /\.(docx|pptx|xlsx|zip)$/i.test(path)) {
    try {
      const entries = readZip(buf), references = relationshipReferences(entries);
      return entries.filter(x => /(?:^|\/)(media|embeddings)\//i.test(x.name) || /\.(png|jpe?g|pdf|svg|emf|wmf|tiff?|gif|rtf)$/i.test(x.name)).flatMap(x => {
        const row = inspectBlob(x.data, path, x.name, expect);
        return flattenRows({ ...row, references: [...(references.get(x.name) ?? [])] }).map(result => ({ ...result, notes: [...result.notes, ...(entries.notes ?? [])] }));
      });
    } catch (error) {
      return [{ ...inspectBlob(buf, path, basename(path), expect), error: error.message, firstBytes: buf.subarray(0, 16).toString('hex'), guess: signature.startsWith('504b') ? 'ZIP signature; invalid or unsupported archive' : 'not a ZIP' }];
    }
  }
  return flattenRows(inspectBlob(buf, path, basename(path), expect));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const index = args.indexOf('--expect');
  const expect = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && !/^[a-f\d]{64}$/i.test(expect ?? '')) throw new Error('--expect requires a SHA-256 hex digest');
  if (index >= 0) args.splice(index, 2);
  const outIndex = args.indexOf('--out');
  const out = outIndex < 0 ? undefined : args[outIndex + 1];
  if (outIndex >= 0 && (!out || out.startsWith('--'))) throw new Error('--out requires a file path');
  if (outIndex >= 0) args.splice(outIndex, 2);
  const paths = args.filter(x => x !== '--json');
  if (!paths.length) { console.error('Usage: inspect.mjs <path...> [--expect <sha256>] [--json] [--out <file>]'); process.exitCode = 2; }
  else {
    const rows = paths.flatMap(path => { try { return inspectPath(path, expect); } catch (error) { return [{ container: path, error: error.message }]; } });
    const lines = [];
    if (json) lines.push(JSON.stringify(rows, null, 2));
    else {
      lines.push('Container\tEntry\tType\tBytes\tSHA-256\tPixels / DPI\tReferences\tCarriers / errors / blob guess\tNotes');
      for (const row of rows) lines.push([row.container, row.entry, row.type, row.size, row.sha256, row.image ? `${row.image.width}x${row.image.height} / ${row.image.dpi?.join('x') ?? 'unspecified'}` : '', row.references?.join(', '), row.error ?? (row.findings?.map(f => `${f.carrier}: ${f.envelope?.ok ? 'valid' : f.error || f.envelope?.reason || f.note}${f.envelope?.notes ? `; ${f.envelope.notes.join('; ')}` : ''}${f.matchesExpect === null || f.matchesExpect === undefined ? '' : `; expect=${f.matchesExpect}`}`).join(', ') || `${row.guess ?? ''} ${row.firstBytes ?? ''}`), row.notes?.join('; ')].join('\t'));
    }
    const output = lines.join('\n') + '\n';
    if (out) writeFileSync(out, output, 'utf8');
    else process.stdout.write(output);
    if (rows.some(row => row.error || row.findings?.some(f => f.error || f.envelope?.ok === false || f.matchesExpect === false))) process.exitCode = 1;
  }
}
