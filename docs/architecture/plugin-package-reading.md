# Reading a local plugin package

**Plugins ▸ Add plugin from package…** lets the user pick a plugin `.zip`. The native file dialog
grants filesystem scope for that one file, not for the `<name>.zip.sha256` that `pnpm plugin:package`
writes beside it, so the webview cannot read the checksum itself. The main-window-only command
`read_plugin_package` (`apps/desktop/src-tauri/src/plugin_package.rs`) reads both, without widening
the webview's scope.

## What it does

1. Opens the ZIP with no-follow on the final component and requires a regular file.
2. Takes the opened handle's real final path (`fcntl(F_GETPATH)` on macOS,
   `GetFinalPathNameByHandleW` on Windows) and checks it against the dialog-granted scope. A
   folder link that existed before the pick, or a Windows 8.3 short name, therefore resolves to the
   real file before anything is authorized.
3. Derives the checksum name from that final long name plus `.sha256`, opens it the same way, and
   requires it to share the ZIP's final parent folder (Windows compares names case-insensitively).
4. Reads both byte streams from the validated handles, never by reopening a path, within the size
   caps (32 MB ZIP, 4 KB checksum), and returns them as one binary IPC response with a length
   header.

The checksum is optional (ADR-0029 §4): if the sibling does not exist, the install goes ahead and
is not marked verified. A sibling that exists but is a link, not a regular file, too large,
unreadable, malformed or mismatched is refused. Every other install gate (CRC-32 per entry,
manifest, `apiVersion`, worker handshake, path-traversal guards) still runs.

## Threat model

In scope: a webview caller passing a path the user did not pick, short-name and case aliases, and
links present before the pick.

Out of scope: another process, running as the same user, that renames or relinks the package's
folders while the read is in progress. Such a process can already read every file the user can, and
can replace the ZIP and its checksum together, so winning that race gains it nothing. The checksum
guards against accidental corruption, not against an attacker on the machine; it is not a signature
(see `docs/plugin-architecture/AUTHORING.md`). Tauri's own filesystem plugin has the same
path-based boundary.
