import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeEnvelope, sha256 } from './payload.mjs';
import { makePng } from './png.mjs';
import { makeSvg } from './svg.mjs';
import { makePdf } from './pdf.mjs';

export function makeCarriers({ payload, png, svg, pdf, out, html }) {
  const envelope = makeEnvelope(readFileSync(payload, 'utf8'));
  const image = readFileSync(png), vector = readFileSync(svg), document = readFileSync(pdf);
  const files = [
    ['png-ztxt.png', 'png zTXt', makePng(image, envelope, 'zTXt')],
    ['png-itxt.png', 'png iTXt', makePng(image, envelope, 'iTXt')],
    ['png-ztxt-96dpi.png', 'png zTXt 96dpi', makePng(image, envelope, 'zTXt', 96)],
    ['png-ztxt-384dpi.png', 'png zTXt 384dpi', makePng(image, envelope, 'zTXt', 384)],
    ['svg-metadata.svg', 'svg metadata', makeSvg(vector, envelope, 'metadata')],
    ['svg-comment.svg', 'svg comment', makeSvg(vector, envelope, 'comment')],
    ['pdf-embedded.pdf', 'pdf embedded file', makePdf(document, envelope, 'embedded')],
    ['pdf-catalog-key.pdf', 'pdf catalog key', makePdf(document, envelope, 'catalog-key')],
  ];
  mkdirSync(out, { recursive: true });
  for (const [name, , bytes] of files) writeFileSync(join(out, name), bytes);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(files.map(([file, kind, bytes]) => ({ file, kind, sha256: sha256(bytes) })), null, 2) + '\n');
  if (html) writeFileSync(html, '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>ChemDraft clipboard trial</title></head><body>\n<!--StartFragment--><p>ChemDraft: ethanol → acetaldehyde</p><!--EndFragment-->\n</body></html>\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--payload', '--png', '--svg', '--pdf', '--out', '--html'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: make-carriers.mjs --payload <json> --png <png> --svg <svg> --pdf <pdf> --out <dir> [--html <example.html>]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.payload || !options.png || !options.svg || !options.pdf || !options.out) throw new Error('All of --payload, --png, --svg, --pdf and --out are required');
  makeCarriers(options);
}
