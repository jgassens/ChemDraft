# @chemdraft/plugin-host

Owns plugin manifest handling, command registration, permission enforcement, plugin storage scoping, and lifecycle behavior.

This package validates trusted manifests, registers command-backed plugin contributions, enforces declared permissions, scopes plugin storage, and queues proposed document patches for host/user approval before applying them through `chem-core`.
