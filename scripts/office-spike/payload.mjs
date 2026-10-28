import { createHash } from 'node:crypto';

export const MAX_ENVELOPE = 20 * 1024 * 1024;
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function makeEnvelope(json) {
  const payload = typeof json === 'string' ? json : JSON.stringify(json);
  JSON.parse(payload);
  const result = Buffer.from(JSON.stringify({ format: 'chemdraft-spike', version: 1, sha256: sha256(payload), payload }));
  if (result.length > MAX_ENVELOPE) throw new Error('Envelope exceeds 20 MB');
  return result;
}

export function checkEnvelope(buf) {
  if (buf.length > MAX_ENVELOPE) return { ok: false, reason: 'Envelope exceeds 20 MB', sha256: null };
  try {
    const envelope = JSON.parse(Buffer.from(buf).toString('utf8'));
    if (envelope.format !== 'chemdraft-spike' || envelope.version !== 1 || typeof envelope.payload !== 'string' || typeof envelope.sha256 !== 'string') throw new Error('Invalid envelope');
    JSON.parse(envelope.payload);
    const digest = sha256(envelope.payload);
    return { ok: digest === envelope.sha256, reason: digest === envelope.sha256 ? null : 'SHA-256 mismatch', sha256: digest };
  } catch (error) {
    return { ok: false, reason: error.message, sha256: null };
  }
}
