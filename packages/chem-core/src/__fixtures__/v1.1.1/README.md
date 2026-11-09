# Released schema fixture (test only)

These TypeScript modules were copied from tag `v1.1.1`, commit
`6be9bb8eb040d99dd5e5be0d4fff06382ec0a7d2`, under `packages/chem-core/src/`.
The only addition to each file is its first-line test-only provenance comment.
Dependencies are frozen alongside the schema so later page-preset or normalization changes cannot
quietly change what this test considers a released reader.

Do not modernize or use these modules in production. `documentCompatibility.test.ts` imports the
released schema to prove plain files written by the current app still parse, and to guard the
feature introduction table against unregistered fields and enum/literal values.
