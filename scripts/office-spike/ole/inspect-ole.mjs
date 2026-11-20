import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { emfFindings } from '../emf.mjs';
import { chunks } from '../png.mjs';
import { MAX_INFLATED, readZip } from '../zip.mjs';
import { CLSID, DOCUMENT_STREAM, readCfb } from './cfb-writer.mjs';
import { inspectOleMarkup } from './ole-markup.mjs';

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

function pngThroughIend(bytes) {
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > bytes.length) break;
    if (bytes.toString('ascii', at + 4, at + 8) === 'IEND') {
      if (length || bytes.length - end > 3) throw new Error('Invalid EMF+ PNG IEND or padding');
      const png = bytes.subarray(0, end);
      chunks(png); // Validate CRCs and chunk order on the PNG itself.
      return png;
    }
    at = end;
  }
  throw new Error('Missing complete IEND in EMF+ PNG');
}

function previewReport(data, name, references, expected, type = imageType(data, name)) {
  const hash = sha256(data);
  const pngs = [];
  let error = null;
  if (type === 'emf') {
    try {
      emfFindings(data, (bytes, label, metadata) => {
        if (metadata.imageType !== 1 || !label.startsWith('EMF+ image object[') ||
            bytes.subarray(0, 8).toString('hex') !== pngSignature) return;
        const png = pngThroughIend(bytes);
        pngs.push({ objectId: metadata.objectId, size: png.length, sha256: sha256(png) });
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

const clipboardFormats = {
  2: 'CF_BITMAP', 3: 'CF_METAFILEPICT', 8: 'CF_DIB', 14: 'CF_ENHMETAFILE', 17: 'CF_DIBV5',
};

function presentationReport(name, bytes, expected) {
  let clipboardFormat = null, size = null;
  try {
    // MS-OLEDS OLEPresentationStream starts with a variable-length clipboard
    // format and a TargetDeviceSize that includes the size field itself.
    if (bytes.length < 4) throw new Error('Truncated clipboard format marker');
    const marker = bytes.readUInt32LE(0);
    let at = 4;
    if (marker === 0) {
      throw new Error('OLEPresentationStream ClipboardFormat marker 0 is invalid');
    } else if (marker === 0xffffffff || marker === 0xfffffffe) {
      if (bytes.length < 8) throw new Error('Truncated standard clipboard format');
      const id = bytes.readUInt32LE(at);
      clipboardFormat = { id, name: clipboardFormats[id] ?? null };
      at += 4;
    } else if (marker) {
      if (marker > bytes.length - at || bytes[at + marker - 1] !== 0) {
        throw new Error('Invalid registered clipboard format name');
      }
      clipboardFormat = { id: null, name: bytes.toString('latin1', at, at + marker - 1) };
      at += marker;
    }

    if (at + 4 > bytes.length) throw new Error('Missing TargetDeviceSize');
    const targetDeviceSize = bytes.readUInt32LE(at);
    if (targetDeviceSize < 4 || targetDeviceSize > bytes.length - at) throw new Error('Invalid TargetDeviceSize');
    at += targetDeviceSize;
    // Aspect, Lindex, Advf, Reserved1, Width, Height, Size.
    if (at + 28 > bytes.length) throw new Error('Truncated presentation header');
    size = bytes.readUInt32LE(at + 24);
    at += 28;
    if (size > bytes.length - at) throw new Error('Truncated presentation data');
    const preview = clipboardFormat?.name === 'CF_ENHMETAFILE'
      ? previewReport(bytes.subarray(at, at + size), name, [], expected, 'emf') : null;
    return { name, clipboardFormat, size, preview, error: null };
  } catch (error) {
    return { name, clipboardFormat, size, preview: null, error: error.message };
  }
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
      presentations: [...streams].filter(([name]) => /^\x02OlePres\d{3}$/i.test(name))
        .map(([name, bytes]) => presentationReport(name, bytes, expected)),
      document: { present: document !== undefined, sha256: documentHash, matchesManifest: expected ? documentHash === expected.json : null },
      error: null,
    };
  } catch (error) {
    return { ...base, clsid: null, probeClass: null, streams: null, presentations: null, document: null, error: error.message };
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
  const parts = new Map(entries.filter(({ name }) => !name.endsWith('/')).map(({ name, data }) => [name, data]));
  const { objects, images, embeddings, imageUses, inspectedSources } = inspectOleMarkup(parts);
  const liveEmbeddings = embeddings.filter(embedding => embedding.live);
  const liveObjects = new Set(liveEmbeddings.map(embedding => embedding.target));
  const livePreviews = new Set(liveEmbeddings.flatMap(embedding => embedding.previews)
    .filter(preview => preview.exists).map(preview => preview.target));
  const oleObjects = [];
  const previews = [];
  for (const [name, data] of parts) {
    if (objects.has(name) || /^(word|ppt)\/embeddings\/oleObject[^/]*\.bin$/i.test(name) ||
        (/^(word|ppt)\/embeddings\//i.test(name) && data.subarray(0, 8).toString('hex') === cfbSignature)) {
      oleObjects.push({ ...objectReport(data, name, objects.get(name) ?? [], expected), orphan: !liveObjects.has(name) });
    }
    if (images.has(name) || /^(word|ppt)\/media\//i.test(name)) {
      const references = images.get(name) ?? [];
      const orphan = !imageUses.has(name) &&
        !references.some(ref => !inspectedSources.has(ref.part) && parts.has(ref.part));
      previews.push({ ...previewReport(data, name, references, expected), orphan, usedByLiveEmbedding: livePreviews.has(name) });
    }
  }
  return {
    oleObjectPresent: oleObjects.length > 0,
    liveEmbeddingPresent: liveEmbeddings.length > 0,
    probeClassPresent: oleObjects.some(object => object.probeClass),
    embeddings, oleObjects, previews,
    orphanParts: [...oleObjects, ...previews].filter(part => part.orphan).map(part => part.part),
    missingRelatedParts: [...new Set([...objects.keys(), ...images.keys()])].filter(part => !parts.has(part)),
  };
}

function branchLabel(branches) {
  return branches.map(branch => branch.kind === 'choice'
    ? `Choice Requires="${branch.requires.join(' ')}"` : 'Fallback').join(' / ');
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
      console.log(`Live embedding ${report.liveEmbeddingPresent ? 'yes' : 'no'} | OLE part present ${report.oleObjectPresent ? 'yes' : 'no'} | Probe CLSID present ${report.probeClassPresent ? 'yes' : 'no'}`);
      for (const embedding of report.embeddings) {
        const branch = branchLabel(embedding.branches);
        console.log(`  ${embedding.part} [${embedding.id ?? 'missing ID'}]${branch ? ` | ${branch}` : ''} | ${embedding.live ? embedding.target : `unresolved (${embedding.target ?? 'missing OLE relationship'})`}`);
        for (const preview of embedding.previews) {
          const branch = branchLabel(preview.branches);
          console.log(`    Preview ${preview.part} [${preview.id ?? 'missing ID'}]${branch ? ` | ${branch}` : ''} | ${preview.exists ? preview.target : `unresolved (${preview.target ?? 'missing image relationship'})`}`);
        }
      }
      for (const object of report.oleObjects) {
        console.log(`  ${object.part} | ${object.size} bytes | ${object.clsid ?? object.error}`);
        for (const stream of object.streams ?? []) {
          console.log(`    ${JSON.stringify(stream.name)} | ${stream.size} bytes`);
        }
        for (const presentation of object.presentations ?? []) {
          const { name, clipboardFormat, size, preview, error } = presentation;
          console.log(`    Cache ${JSON.stringify(name)} | ${clipboardFormat?.name ?? clipboardFormat?.id ?? 'unknown format'} | ${size ?? 'unknown'} data bytes`);
          if (preview) console.log(`      ${preview.state}${preview.error ? ` | ${preview.error}` : ''}`);
          if (error) console.log(`      ${error}`);
        }
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
      for (const part of report.orphanParts) console.log(`Orphan part ${part}`);
      for (const part of report.missingRelatedParts) console.log(`Missing relationship target ${part}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
