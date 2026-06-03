# @chemdraft/layout-engine

Owns page and object layout operations such as align, distribute, group, rotate, flip, z-order, guides, and page sizing.

It also owns pure molecule-growth geometry helpers used by drawing tools, such as planning the next bonded atom position from an existing native molecule graph. The desktop app may consume these plans, but document mutation remains in `chem-core` patches and app workflow code.

Layout must not change chemical identity.
