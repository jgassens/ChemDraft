# @chemdraft/plugin-host

Owns plugin manifest handling, command registration, permission enforcement, plugin storage scoping, and lifecycle behavior.

This package validates trusted manifests, registers command-backed plugin contributions, enforces declared permissions, scopes plugin storage, queues proposed document patches for host/user approval, and forwards `document.write` patches only from the owning plugin's active command invocation. Image acquisition is similarly limited to an `image.read` plugin's active command and enforces the 25 MB / 8192-pixel host limits before bytes reach plugin code.

API 0.1.6 also gates local structure recognition on `image.read`, `ml.inference`, `model.load`, and
`native.execute`, and accepts only bytes the host handed to that same command invocation.

API 0.1.8 gates `tools` on both `assistant.run` and `native.execute`, including a permission check
on every method call. Manifests declaring `assistant.run` without `native.execute` are refused.

Registration is transactional across the shared command registry: all command ids are preflighted,
partial registration is rolled back, and uninstall removes only commands still owned by that plugin.
