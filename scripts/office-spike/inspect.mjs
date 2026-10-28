import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename, posix } from 'node:path';
import { readZip } from './zip.mjs';
import { pathToFileURL } from 'node:url';
import { sha256, checkEnvelope } from './payload.mjs';
import { pngFindings } from './png.mjs';
import { svgFindings } from './svg.mjs';

export function inspectBlob(buf, container, entry = basename(container), expect) {
  let type = 'other', findings = [], image = null, error = null;
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') type = 'png';
  else if (buf.subarray(0, 3).toString('hex') === 'ffd8ff') type = 'jpeg';
  else if (buf.subarray(0, 5).toString() === '%PDF-') type = 'pdf';
  else if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(buf.toString('utf8', 0, Math.min(buf.length, 2048)))) type = 'svg';
  else if (buf.subarray(0, 3).toString() === 'GIF') type = 'gif';
  else if (['49492a00', '4d4d002a'].includes(buf.subarray(0, 4).toString('hex'))) type = 'tiff';
  else if (buf.length >= 44 && buf.readUInt32LE(0) === 1 && buf.toString('ascii', 40, 44) === ' EMF') type = 'emf';
  else if (buf.subarray(0, 4).toString('hex') === 'd7cdc69a') type = 'wmf';
  try {
    if (type === 'png') { const result = pngFindings(buf); findings = result.found; image = { width: result.width, height: result.height, dpi: result.dpi }; }
    if (type === 'svg') findings = svgFindings(buf);
    if (type === 'pdf' || type === 'emf') error = `${type.toUpperCase()} carrier inspection is not implemented`;
  } catch (e) { error = e.message; }
  return { container, entry, type, size: buf.length, sha256: sha256(buf), image, findings: findings.map(({ envelope, ...item }) => ({ ...item, ...(envelope ? { envelope: checkEnvelope(envelope), matchesExpect: expect ? checkEnvelope(envelope).sha256 === expect : null } : {}) })), error, ...(type === 'other' ? { firstBytes: buf.subarray(0, 16).toString('hex'), guess: 'unknown (not a recognized image or ZIP)' } : {}) };
}
export function inspectPath(path, expect) {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap(name => inspectPath(join(path, name), expect));
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).toString('hex') === '504b0304') {
    const entries = readZip(buf), references = new Map();
    for (const rel of entries.filter(x => /\/_rels\/[^/]+\.rels$/.test(x.name))) {
      const part = rel.name.replace(/\/_rels\/([^/]+)\.rels$/, '/$1');
      for (const match of rel.data.toString('utf8').matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map(m => [m[1], m[2]]));
        if (!attrs.Target || attrs.TargetMode === 'External') continue;
        const target = posix.normalize(posix.join(posix.dirname(part), attrs.Target));
        if (!references.has(target)) references.set(target, []);
        references.get(target).push(part);
      }
    }
    return entries.filter(x => /(?:^|\/)media\//i.test(x.name) || /\.(png|jpe?g|pdf|svg|emf|wmf|tiff?|gif)$/i.test(x.name)).map(x => ({ ...inspectBlob(x.data, path, x.name, expect), references: references.get(x.name) ?? [] }));
  }
  return [inspectBlob(buf, path, basename(path), expect)];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const index = args.indexOf('--expect');
  const expect = index < 0 ? undefined : args[index + 1];
  if (index >= 0) args.splice(index, 2);
  const paths = args.filter(x => x !== '--json');
  if (!paths.length) { console.error('Usage: inspect.mjs <path...> [--expect <sha256>] [--json]'); process.exitCode = 2; }
  else {
    const rows = paths.flatMap(path => { try { return inspectPath(path, expect); } catch (error) { return [{ container: path, error: error.message }]; } });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.container}\t${row.entry ?? ''}\t${row.type ?? ''}\t${row.size ?? ''}\t${row.error ?? row.findings?.map(f => `${f.carrier}: ${f.envelope?.ok ? 'valid' : f.error || f.envelope?.reason}`).join(', ') ?? ''}`);
    if (rows.some(row => row.error)) process.exitCode = 1;
  }
}
