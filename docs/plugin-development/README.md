# Plugin Development

Plugin development starts with manifest types in `packages/plugin-api` and command registration in `packages/plugin-host`.

Plugins must declare permissions before receiving capabilities. Future plugin work should add manifest validation, permission enforcement, isolated execution modes, and tests before enabling filesystem, network, native execution, clipboard, or document-write access.
