import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The verifier is intentionally plain JavaScript.
import { pubchemPath, referenceLockForComparison } from './verify-references.mjs';

describe('portable reference snapshot', () => {
  it('uses the committed PubChem snapshot, retaining CIDs and source names', async () => {
    expect(pubchemPath).toBe(fileURLToPath(new URL('./pubchem-references.json', import.meta.url)));
    const snapshot = JSON.parse(await readFile(pubchemPath, 'utf8'));
    expect(snapshot['L-alanine']).toMatchObject({ CID: 5950, IUPACName: '(2S)-2-aminopropanoic acid' });
    const lock = JSON.parse(await readFile(new URL('./references.lock.json', import.meta.url), 'utf8'));
    const sources = Object.values(snapshot) as { CID: number; IUPACName?: string }[];
    for (const reference of lock.references) if (reference.pubchemVerification) {
      expect(sources.find((entry) => entry.CID === reference.pubchemVerification.cid)?.IUPACName).toBe(reference.pubchemVerification.iupacName);
    }
  });

  it('compares chemistry exactly while ignoring the location of a missing local Java runtime', async () => {
    const lock = JSON.parse(await readFile(new URL('./references.lock.json', import.meta.url), 'utf8'));
    const relocated = structuredClone(lock);
    relocated.specialVerifications.P10.error = relocated.specialVerifications.P10.error.replace(/at "[^"]+"/, 'at "C:\\work\\java.exe"');
    expect(referenceLockForComparison(relocated)).toBe(referenceLockForComparison(lock));
    relocated.references[0].unspecifiedStereoCenters++;
    expect(referenceLockForComparison(relocated)).not.toBe(referenceLockForComparison(lock));
  });
});
