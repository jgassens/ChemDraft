# Linux desktop test document

`linux-desktop-v2.chemdraft` is an original synthetic ChemDraft drawing of benzene
and a single carbon-carbon bond, saved by the pre-v3 writer. It contains no user
data or third-party drawing assets. Its English-collated v2 visible checksum is
intentional: desktop integration tests also exercise opening an older native
document without changing its chemistry.

The desktop harness mounts this committed fixture read-only. Generated bundles,
screenshots and reports remain under ignored `artifacts/`.
