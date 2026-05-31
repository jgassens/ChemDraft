# @chemdraft/ketcher-adapter

Wraps an injected Ketcher-like engine host behind `@chemdraft/editor-adapter`.

Ketcher is not included as a runtime dependency yet. The adapter boundary supports basic molecule load/save, reports explicit capability gaps, and keeps `chem-core` as the page/document source of truth.

Do not expose Ketcher internals as public app API. Do not import Ketcher directly into app UI packages.
