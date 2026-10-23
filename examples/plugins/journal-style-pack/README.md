# Optional journal style pack placeholder

This remains a placeholder for an installable, broader journal-style plugin; it is not shipped
as an installed plugin. The desktop's five-entry starter catalog and its generic style dialog
are described in `../../../docs/journal-presets/README.md`.

The `data/` folder contains fifteen optional metadata/profile entries. The desktop loads them only
after the user clicks Load additional journal pack; its owning document window separately validates
the pack before preview or Apply. All twenty combined entries have partial coverage. Unverified journals are omitted. See `../../../docs/journal-presets/EXPANDED_CATALOG.md`.
This is read-only bundled data, not an executable plugin or an installed package.

Broader catalogs belong here or in separate optional packages, rather than expanding the
core into a full journal directory. Keep journal identity metadata separate from versioned
formatting profiles. Validate profiles with the native contract, retain a source URL/section
for every rule, distinguish minimum values from exact targets, and leave unknown rules absent
and unknown limits null. Reuse publisher profiles only when each journal's source supports it.

An executable plugin may import only plugin-api and must obey existing permissions and proposal
review for changes to existing objects. The starter's core-owned operation does not add a plugin
API bypass or change that contract. Executable installable-plugin catalog contribution is future work.

Do not hard-code proprietary or unlicensed style sheets. Code licensing does not automatically
cover bundled datasets: any future package must declare each dataset's licence and provenance.
Do not scrape a complete journal directory into the app at startup or claim complete compliance.
