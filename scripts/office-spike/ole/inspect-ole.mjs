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

const WMF_ESCAPE = 0x0626, MFCOMMENT = 0x000f, WMFC = 0x43464d57;

// GetWinMetaFileBits stores the source EMF in META_ESCAPE MFCOMMENT records ("WMFC"
// comments, MS-WMF META_ESCAPE_ENHANCED_METAFILE) ahead of the WMF rendering. Windows'
// OLE cache writes a CF_ENHMETAFILE presentation that way, so reassemble that EMF.
export function emfInWmf(wmf) {
  let at = wmf.length >= 22 && wmf.readUInt32LE(0) === 0x9ac6cdd7 ? 22 : 0; // Placeable header.
  if (wmf.length - at < 18) throw new Error('Truncated WMF header');
  const headerWords = wmf.readUInt16LE(at + 2);
  if (headerWords !== 9) throw new Error('Invalid WMF header size');
  at += 18;
  const chunks = [];
  let total = null, collected = 0, records = 0, declaredRecords = null, sequenceRecords = 0;
  while (at < wmf.length) {
    if (++records > 100000) throw new Error('WMF record count exceeds 100000');
    if (wmf.length - at < 6) throw new Error('Truncated WMF record');
    const words = wmf.readUInt32LE(at), func = wmf.readUInt16LE(at + 4);
    if (words < 3 || words > (wmf.length - at) / 2) throw new Error('Invalid or truncated WMF record size');
    const record = wmf.subarray(at, at + words * 2);
    at += record.length;
    if (func === 0) break; // META_EOF.
    const inSequence = total !== null && collected < total;
    if (func !== WMF_ESCAPE || record.length < 44 || record.readUInt16LE(6) !== MFCOMMENT ||
        record.readUInt32LE(10) !== WMFC || record.readUInt32LE(14) !== 1) {
      // MS-WMF: the comment records carrying one EMF are consecutive.
      if (inSequence) throw new Error('EMF chunks in WMF comments are interrupted by another record');
      continue;
    }
    const commentRecords = record.readUInt32LE(28);
    if (declaredRecords === null) declaredRecords = commentRecords;
    if (commentRecords !== declaredRecords || ++sequenceRecords > declaredRecords) {
      throw new Error('Inconsistent EMF comment record count in WMF');
    }
    const byteCount = record.readUInt16LE(8), current = record.readUInt32LE(32);
    const remaining = record.readUInt32LE(36), size = record.readUInt32LE(40);
    if (total === null) total = size;
    if (size !== total || current > record.length - 44 || byteCount < 34 + current ||
        current > total - collected || remaining !== total - collected - current) {
      throw new Error('Inconsistent EMF chunk in WMF comment');
    }
    chunks.push(record.subarray(44, 44 + current));
    collected += current;
  }
  if (total === null) return null;
  if (collected !== total || sequenceRecords !== declaredRecords) throw new Error('Incomplete EMF in WMF comments');
  return Buffer.concat(chunks, total);
}

function cachedEnhancedMetafile(data) {
  const type = imageType(data, '');
  if (type === 'emf') return { dataType: 'emf', emf: data };
  if (type === 'wmf') return { dataType: 'wmf', emf: emfInWmf(data) };
  // A CONTENTS-style prefix: sizeof(ENHMETAHEADER) and nBytes ahead of the EMF bits.
  const inner = data.subarray(8);
  if (data.length >= 8 && imageType(inner, '') === 'emf' && data.readUInt32LE(4) === inner.length) {
    return { dataType: 'emf-with-size-prefix', emf: inner };
  }
  return { dataType: type, emf: data }; // Report the EMF parser's own error.
}

function presentationReport(name, bytes, expected) {
  let clipboardFormat = null, size = null, dataType = null, embeddedEmfSize = null;
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
    let preview = null;
    // Dispatch on the standard format ID; a registered format may carry any name.
    if (clipboardFormat?.id === 14) {
      const cached = cachedEnhancedMetafile(bytes.subarray(at, at + size));
      dataType = cached.dataType;
      embeddedEmfSize = cached.dataType === 'wmf' ? cached.emf?.length ?? null : null;
      if (cached.emf) preview = previewReport(cached.emf, name, [], expected, 'emf');
    }
    return { name, clipboardFormat, size, dataType, embeddedEmfSize, preview, error: null };
  } catch (error) {
    return { name, clipboardFormat, size, dataType, embeddedEmfSize, preview: null, error: error.message };
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
          const { name, clipboardFormat, size, dataType, embeddedEmfSize, preview, error } = presentation;
          const embedded = embeddedEmfSize === null ? '' : ` | embedded EMF ${embeddedEmfSize} bytes`;
          console.log(`    Cache ${JSON.stringify(name)} | ${clipboardFormat?.name ?? clipboardFormat?.id ?? 'unknown format'} | ${size ?? 'unknown'} data bytes${dataType ? ` | ${dataType}` : ''}${embedded}`);
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
