import { createHash } from 'node:crypto';

export const MAX_ENVELOPE = 20 * 1024 * 1024;
export const SVG_NAMESPACE = 'https://chemdraft.ai/ns/spike/1';
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function trailingNuls(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.length - end;
}
export const paddingNotes = length => length ? [`Trailing NUL padding: ${length} bytes`] : [];
export function hasPayloadMarker(buf) {
  return ['chemdraft-spike', SVG_NAMESPACE, 'chemdraft:', 'chemdraft\0'].some(marker =>
    buf.includes(Buffer.from(marker)) || buf.includes(Buffer.from(marker, 'utf16le')));
}

export function makeEnvelope(json) {
  const payload = typeof json === 'string' ? json : JSON.stringify(json);
  JSON.parse(payload);
  const result = Buffer.from(JSON.stringify({ format: 'chemdraft-spike', version: 1, sha256: sha256(payload), payload }));
  if (result.length > MAX_ENVELOPE) throw new Error('Envelope exceeds 20 MB');
  return result;
}

export function checkEnvelope(buf) {
  if (buf.length > MAX_ENVELOPE) return { ok: false, reason: 'Envelope exceeds 20 MB', sha256: null };
  const padding = trailingNuls(buf), notes = paddingNotes(padding);
  try {
    const envelope = JSON.parse(Buffer.from(buf).subarray(0, buf.length - padding).toString('utf8'));
    if (envelope.format !== 'chemdraft-spike' || envelope.version !== 1 || typeof envelope.payload !== 'string' || typeof envelope.sha256 !== 'string') throw new Error('Invalid envelope');
    JSON.parse(envelope.payload);
    const digest = sha256(envelope.payload);
    return { ok: digest === envelope.sha256, reason: digest === envelope.sha256 ? null : 'SHA-256 mismatch', sha256: digest, ...(notes.length ? { notes } : {}) };
  } catch (error) {
    return { ok: false, reason: error.message, sha256: null, ...(notes.length ? { notes } : {}) };
  }
}
