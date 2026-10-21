# Proposed bug fixes: exports and session safety

Unreleased changes based on `8a3781eaf0b2ebb446c445c068cf3a4d62b5750c`.

## Bug fixes

- Preserve neutral radical atoms and their hydrogen counts in fallback SMILES, including when a
  stored SMILES string predates the radical mark. For example, a methyl radical stays `[CH3]`
  instead of becoming `C`.
- Spell supported single-heavy-element labels (`NH2`, `OH`, `CH3`) in the molfile input used by
  SMILES and SDF export, using the existing shared parser instead of replacing them with `*`.
  A radical-bearing label instead keeps the placeholder and its loss warning, since spelling it
  would change its radical count.
- Refuse the Windows updater's strict session flush when an empty drawing contains unsaved changes
  and autosave is unavailable. A clean empty canvas can still skip a write.
- Reject reserved Windows device names (`CON`, `NUL`, `AUX`, `PRN`, `COM1`–`COM9`, `LPT1`–`LPT9`)
  in batch jobs on every platform. Document output uses the same predicate.

## Supporting test correction

Resolve `@thednp/dommatrix` from its owner, `svg-path-commander`, in the art-engine license test.
It is a transitive dependency, so resolving it as a direct dependency fails with pnpm's isolated
installation layout. No package or lockfile change is required.

## Regression coverage

`tools/bug-audit.test.ts` exercises engine-unavailable radical export, stale stored SMILES, real
RDKit label exports and SDF records, updater refusal, and reserved and ordinary batch names.
The existing Copy As, structure-list, and session tests assert the corrected behavior. A warning
test for unsupported aryl placeholders remains, so supporting `NH2` does not remove that warning.

Before applying the implementation changes, the new regression file produced 22 failures and
5 passes against the base commit. The passing cases are ordinary allowed batch names; the
failures demonstrate the four original issues.

## Verification limits

The shared code can be exercised from macOS using the workspace test runner and real RDKit WASM.
Native updater installation and Windows device-file behavior require native Windows testing.
Native macOS and Windows application builds have not been verified in this environment; Rust/Cargo
is unavailable. Do not interpret passing unit tests as a native application release qualification.

Build stamp: `10.19.01.01-codex`.
