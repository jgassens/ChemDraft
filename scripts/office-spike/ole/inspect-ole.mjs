import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { emfFindings } from '../emf.mjs';
import { MAX_INFLATED, readZip } from '../zip.mjs';
import { CLSID, DOCUMENT_STREAM, readCfb } from './cfb-writer.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pngSignature = '89504e470d0a1a0a';
const cfbSignature = 'd0cf11e0a1b11ae1';

function imageType(bytes, name) {
  const magic = bytes.subarray(0, 8).toString('hex');
  if (magic === pngSignature) return 'png';
  if (magic.startsWith('ffd8ff')) return 'jpeg';
  if (magic.startsWith('d7cdc69a') || (bytes.length >= 18 &&
      [1, 2].includes(bytes.readUInt16LE(0)) && bytes.readUInt16LE(2) === 9 &&
      [0x100, 0x300].includes(bytes.readUInt16LE(4)))) return 'wmf';
  if (bytes.length >= 44 && bytes.readUInt32LE(0) === 1 && bytes.toString('ascii', 40, 44) === ' EMF') return 'emf';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (magic.startsWith('49492a00') || magic.startsWith('4d4d002a')) return 'tiff';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  const extension = posix.extname(name).slice(1).toLowerCase();
  return { jpg: 'jpeg', tif: 'tiff' }[extension] ?? (extension || 'unknown');
}

function xmlText(text) {
  const values = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);/g, (entity, key) => {
    if (key[0] !== '#') return values[key];
    const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function relatedParts(entries) {
  const objects = new Map(), images = new Map();
  for (const { name, data } of entries) {
    const relation = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
    if (!relation) continue;
    const part = (relation[1] ?? '') + relation[2];
    const xml = data.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const [, element] of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)) {
      const attrs = Object.fromEntries(
        [...element.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
          .map(([, key, double, single]) => [key, xmlText(double ?? single)]),
      );
      if (!attrs.Target || attrs.TargetMode === 'External') continue;
      const destination = attrs.Type?.endsWith('/oleObject') ? objects : attrs.Type?.endsWith('/image') ? images : null;
      if (!destination) continue;
      const uri = decodeURIComponent(attrs.Target.split('#')[0]);
      const target = uri.startsWith('/') ? posix.normalize(uri).slice(1) : posix.join(posix.dirname(part), uri);
      if (!destination.has(target)) destination.set(target, []);
      destination.get(target).push({ part, id: attrs.Id });
    }
  }
  return { objects, images };
}

function previewReport(data, name, references, expected) {
  const type = imageType(data, name);
  const hash = sha256(data);
  const pngs = [];
  let error = null;
  if (type === 'emf') {
    try {
      emfFindings(data, (bytes, label, metadata) => {
        if (metadata.imageType !== 1 || !label.startsWith('EMF+ image object[') ||
            bytes.subarray(0, 8).toString('hex') !== pngSignature) return;
        pngs.push({ objectId: metadata.objectId, size: bytes.length, sha256: sha256(bytes) });
      });
    } catch (err) {
      error = err.message;
    }
  }
  const originalEmf = expected ? type === 'emf' && hash === expected.emf : null;
  const originalPng = expected ? type === 'png' && hash === expected.png : null;
  const originalPngInEmfPlus = expected && !error ? pngs.some(png => png.sha256 === expected.png) : null;
  let state = 'no-baseline';
  if (error) state = 'unreadable-emf';
  else if (originalEmf) state = 'unchanged-emf';
  else if (originalPngInEmfPlus) state = 'changed-emf-carrier-kept';
  else if (originalPng) state = 'standalone-original-png';
  else if (expected) state = 'changed-or-re-rendered';
  return {
    part: name, references, type, size: data.length, sha256: hash, state,
    originalEmf, originalPng, originalPngInEmfPlus, emfPlusPngs: pngs, error,
  };
}

function objectReport(data, part, references, expected) {
  const hash = sha256(data);
  const base = { part, references, size: data.length, sha256: hash, matchesManifest: expected ? hash === expected.oleObject : null };
  try {
    const { clsid, streams } = readCfb(data);
    const document = streams.get(DOCUMENT_STREAM);
    const documentHash = document === undefined ? null : sha256(document);
    return {
      ...base, clsid, probeClass: clsid === CLSID,
      streams: [...streams].map(([name, bytes]) => ({ name, size: bytes.length })),
      document: { present: document !== undefined, sha256: documentHash, matchesManifest: expected ? documentHash === expected.json : null },
      error: null,
    };
  } catch (error) {
    return { ...base, clsid: null, probeClass: null, streams: null, document: null, error: error.message };
  }
}

export function inspectOle(bytes, manifest = null) {
  const expected = manifest?.sha256;
  if (manifest !== null && !['png', 'emf', 'oleObject', 'json'].every(key => /^[0-9a-f]{64}$/.test(expected?.[key] ?? ''))) {
    throw new Error('Invalid manifest: expected SHA-256 values for png, emf, oleObject, and json');
  }
  if (bytes.length > MAX_INFLATED) throw new Error('Office package exceeds 200 MiB');
  const entries = readZip(bytes);
  const names = new Set(entries.map(({ name }) => name));
  if (names.size !== entries.length) throw new Error('Duplicate part name in Office package');
  const { objects, images } = relatedParts(entries);
  const oleObjects = [];
  const previews = [];
  for (const { name, data } of entries) {
    if (name.endsWith('/')) continue;
    if (objects.has(name) || /^(word|ppt)\/embeddings\/oleObject[^/]*\.bin$/i.test(name) ||
        (/^(word|ppt)\/embeddings\//i.test(name) && data.subarray(0, 8).toString('hex') === cfbSignature)) {
      oleObjects.push(objectReport(data, name, objects.get(name) ?? [], expected));
    }
    if (images.has(name) || /^(word|ppt)\/media\//i.test(name)) {
      previews.push(previewReport(data, name, images.get(name) ?? [], expected));
    }
  }
  return {
    oleObjectPresent: oleObjects.length > 0,
    probeClassPresent: oleObjects.some(object => object.probeClass),
    oleObjects, previews,
    missingRelatedParts: [...new Set([...objects.keys(), ...images.keys()])].filter(part => !names.has(part)),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      options: { json: { type: 'boolean' }, manifest: { type: 'string' } },
      allowPositionals: true,
    });
    if (positionals.length !== 1 || !/\.(docx|pptx)$/i.test(positionals[0])) {
      throw new Error('Usage: node inspect-ole.mjs <file.docx|file.pptx> [--manifest manifest.json] [--json]');
    }
    const [file] = positionals;
    const siblingManifest = join(dirname(file), 'manifest.json');
    const manifestPath = values.manifest ?? (existsSync(siblingManifest) ? siblingManifest : null);
    const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    if (statSync(file).size > MAX_INFLATED) throw new Error('Office package exceeds 200 MiB');
    const report = { file, manifest: manifestPath, ...inspectOle(readFileSync(file), manifest) };
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`${file}\nBaseline manifest ${manifestPath ?? 'unavailable'}`);
      console.log(`OLE part present ${report.oleObjectPresent ? 'yes' : 'no'} | Probe CLSID present ${report.probeClassPresent ? 'yes' : 'no'}`);
      for (const object of report.oleObjects) {
        console.log(`  ${object.part} | ${object.size} bytes | ${object.clsid ?? object.error}`);
        for (const stream of object.streams ?? []) console.log(`    ${JSON.stringify(stream.name)} | ${stream.size} bytes`);
        if (object.document) {
          const comparison = object.document.matchesManifest === null ? 'no baseline' :
            object.document.matchesManifest ? 'matches manifest' : 'differs from manifest';
          console.log(`    ChemDraftDocument SHA-256 ${object.document.sha256 ?? 'missing'} | ${comparison}`);
        }
      }
      if (!report.previews.length) console.log('No preview image parts found');
      for (const preview of report.previews) {
        console.log(`  ${preview.part} | ${preview.type} | ${preview.size} bytes | ${preview.state}`);
        if (preview.error) console.log(`    ${preview.error}`);
      }
      for (const part of report.missingRelatedParts) console.log(`Missing relationship target ${part}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
