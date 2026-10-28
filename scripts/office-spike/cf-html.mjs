import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Offsets count UTF-8 bytes from the beginning of the entire CF_HTML value.
// Preserve the input HTML bytes, including its own line endings.
export function makeCfHtml(html) {
  html = Buffer.from(html);
  const startMarker = Buffer.from('<!--StartFragment-->'), endMarker = Buffer.from('<!--EndFragment-->');
  const start = html.indexOf(startMarker), end = html.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < start + startMarker.length) throw new Error('HTML requires ordered <!--StartFragment--> and <!--EndFragment--> markers');
  const header = values => 'Version:0.9\r\n' + ['StartHTML', 'EndHTML', 'StartFragment', 'EndFragment']
    .map((key, i) => `${key}:${String(values[i]).padStart(10, '0')}\r\n`).join('');
  const offset = Buffer.byteLength(header([0, 0, 0, 0]));
  const values = [offset, offset + html.length, offset + start + startMarker.length, offset + end];
  if (values.some(n => n > 9999999999)) throw new Error('CF_HTML offset exceeds 10 digits');
  return Buffer.concat([Buffer.from(header(values)), html, Buffer.from([0])]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: cf-html.mjs <input.html> <output.bin>');
  writeFileSync(process.argv[3], makeCfHtml(readFileSync(process.argv[2])));
}
