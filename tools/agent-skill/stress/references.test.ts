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
    const macCopy = structuredClone(lock);
    const windowsCopy = structuredClone(lock);
    macCopy.specialVerifications.P10.error = 'OPSIN runtime missing at "/opt/homebrew/bin/java"';
    windowsCopy.specialVerifications.P10.error = 'OPSIN runtime missing at "C:\\Program Files\\Java\\bin\\java.exe"';
    expect(referenceLockForComparison(macCopy, { skipP10Opsin: true })).toBe(referenceLockForComparison(windowsCopy, { skipP10Opsin: true }));
    const relocated = structuredClone(macCopy);
    relocated.references[0].unspecifiedStereoCenters++;
    expect(referenceLockForComparison(relocated)).not.toBe(referenceLockForComparison(macCopy));
  });

  it('ignores only P10 OPSIN when the runtime is missing during --check', async () => {
    const lock = JSON.parse(await readFile(new URL('./references.lock.json', import.meta.url), 'utf8'));
    const generated = structuredClone(lock);
    generated.specialVerifications.P10 = { ...generated.specialVerifications.P10, opsinOk: false, error: 'Java missing' };
    expect(referenceLockForComparison(lock, { skipP10Opsin: true })).toBe(referenceLockForComparison(generated, { skipP10Opsin: true }));
    generated.references[0].unspecifiedStereoCenters++;
    expect(referenceLockForComparison(lock, { skipP10Opsin: true })).not.toBe(referenceLockForComparison(generated, { skipP10Opsin: true }));
  });
});
