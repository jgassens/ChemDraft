# `@chemdraft/toolset-registry`

Typed registry for command-backed ChemDraft toolsets.

Toolsets describe toolbar windows and palettes. They do not own chemistry behavior and they do not mutate documents. Every visible item routes a command ID back to the app command registry.
