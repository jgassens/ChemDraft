# @chemdraft/plugin-host

Owns plugin manifest handling, command registration, permission enforcement, plugin storage scoping, and lifecycle behavior.

This package validates trusted manifests, registers command-backed plugin contributions, enforces declared permissions, scopes plugin storage, queues proposed document patches for host/user approval, and forwards `document.write` patches only from the owning plugin's active command invocation.

Registration is transactional across the shared command registry: all command ids are preflighted,
partial registration is rolled back, and uninstall removes only commands still owned by that plugin.
