# @chemdraft/cdx-compat

Owns CDXML/CDX import, export, intermediate models, unknown-object preservation, and compatibility warnings.

This package must not become the native document model and must not depend on GPL or AGPL code without an explicit project decision.

## Native CDXML envelope checksums

New saves use envelope codec `chemdraft.cdxml.v3`. Its visible XML checksum sorts
attribute names by UTF-16 code units, with no locale or ICU collation dependency.
Equivalent attribute order, whitespace, comments and CDATA still canonicalize to
the same visible projection. The native document JSON keeps its separate SHA-256
integrity check.

Existing v1 and v2 envelopes remain readable. They used the runtime's default
collation for XML attribute names, so an untouched file could previously be
reported as externally modified when moved between English and POSIX locales.
Legacy reads verify the actual visible XML against the deterministic order and
the previous English, POSIX and current-locale orders. They never bypass the
native JSON hash or accept an arbitrary visible mismatch. V3 reads use only the
deterministic order.

Opening does not rewrite an old file. Saving upgrades it to v3 while preserving
the native document; v1 visible-only import still applies its existing coordinate
correction. Older application builds that do not support v3 report an unsupported
codec rather than guessing its checksum contract.
