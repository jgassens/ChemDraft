# @chemdraft/ketcher-adapter

Wraps an injected Ketcher-like engine host behind `@chemdraft/editor-adapter`.

The adapter boundary supports basic molecule load/save, reports explicit capability gaps, and keeps `chem-core` as the page/document source of truth. The desktop app currently lazy-loads `ketcher-react` and `ketcher-standalone` only through the narrow active molecule editor host.

Do not expose Ketcher internals as public app API. Do not import Ketcher directly into random app UI packages.
