# Windows: Office object registration

The Windows installer registers ChemDraft's OLE class so Word and PowerPoint can embed and edit
ChemDraft structures (design: `docs/architecture/office-editing.md`, section 4, "Class and
registration"). This page says what the installer writes, when, and how to check it.

## What runs, and when

The NSIS hooks in `apps/desktop/src-tauri/windows/installer-hooks.nsh` (wired by
`bundle.windows.nsis.installerHooks` in `tauri.windows.conf.json`) run the installed executable
(`$INSTDIR\${MAINBINARYNAME}.exe`, `chemdraft.exe`):

| Phase | Hook | Command |
| --- | --- | --- |
| Install and update, after the files are copied | `NSIS_HOOK_POSTINSTALL` | `chemdraft.exe --register-office-object=<scope>` |
| Uninstall, before the files are removed | `NSIS_HOOK_PREUNINSTALL` | `chemdraft.exe --unregister-office-object=<scope>` |

`<scope>` follows the installer:

- the per-user installer (`installMode: "currentUser"`, what ChemDraft ships today) uses
  `per-user`, which writes under `HKCU\Software\Classes`;
- an all-users installer (`installMode: "perMachine"`) uses `all-users`, which writes under
  `HKLM\Software\Classes`;
- an installer built with `installMode: "both"` uses whichever the user chose on its install-mode
  page.

A failed registration never fails the install or uninstall. The installer's details list (Show
details) has one line per run: `ChemDraft Office object: --register-office-object=per-user
succeeded`, or `failed (exit code N); continuing`, or `could not run ...`. ChemDraft works without the
object; only Insert > Object and double-click editing in Office are missing.

## What gets written

The executable picks the class from its own bundle identifier, compiled in at build time:

| Build | Identifier | Class written |
| --- | --- | --- |
| Stable (from `main`, or `CHEMDRAFT_STABLE_BUILD=1`) | `org.chemdraft.desktop` | CLSID `{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}`, ProgIDs `ChemDraft.Structure.1` and `ChemDraft.Structure` ("ChemDraft Structure") |
| Dev (branch builds, if ever installed) | `org.chemdraft.desktop.dev` | CLSID `{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}`, ProgIDs `ChemDraft.DevStructure.1` and `ChemDraft.DevStructure` ("ChemDraft (dev) Structure") |

A build writes only its own class, and never another program's keys. Under `Software\Classes` it
writes, in both the 64-bit and 32-bit registry views:

- `CLSID\{clsid}`: display name, `LocalServer32` (the quoted `chemdraft.exe` path), `ProgID`,
  `VersionIndependentProgID`, `InprocHandler32` (`ole32.dll`), `Insertable`, `DefaultIcon`,
  `AuxUserType`, `MiscStatus` (`0`), and the verbs `0` (&Edit) and `1` (&Open);
- `<ProgID>.1` and `<ProgID>`: display name, `CLSID`, `Insertable` or `CurVer`.

All of it is written in one registry transaction. If a ProgID already exists with another program's
CLSID, registration stops without writing anything and exits 1 (the install continues).

## Upgrades and uninstall

- **Upgrade or update** (including the passive install `tauri-plugin-updater` runs): registration
  rewrites the same fixed keys, so there is still exactly one registration, and its `LocalServer32`
  names the new executable.
- **Uninstall** removes only the entries registration wrote, and only when `LocalServer32` names the
  executable being uninstalled. If another copy of ChemDraft has since registered from a different
  folder, the uninstaller keeps that registration.
- Changing scope (a per-user install replaced by an all-users one, or the reverse) is not an
  upgrade: uninstall the old one first, or the HKCU registration stays and takes priority over HKLM.

## Running it by hand

```powershell
# Per-user (HKCU). A bare flag means per-user.
& "$env:LOCALAPPDATA\ChemDraft\chemdraft.exe" --register-office-object=per-user
& "$env:LOCALAPPDATA\ChemDraft\chemdraft.exe" --unregister-office-object=per-user

# All users (HKLM). Needs an elevated (Run as administrator) prompt; otherwise it exits 1 with
# "All-users Office registration writes HKLM and needs an elevated (administrator) process."
& "C:\Program Files\ChemDraft\chemdraft.exe" --register-office-object=all-users
& "C:\Program Files\ChemDraft\chemdraft.exe" --unregister-office-object=all-users
```

Each flag must be the only argument. The exit code is 0 on success and 1 on any failure, with the
reason on stderr; run from a terminal, it prints every entry it wrote or removed.

## Verifying

After installing the stable per-user build (use `HKLM` in place of `HKCU` for an all-users install,
and the dev CLSID and ProgIDs for a dev build):

```powershell
reg query "HKCU\Software\Classes\CLSID\{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}" /s /reg:64
reg query "HKCU\Software\Classes\CLSID\{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}\LocalServer32" /reg:32
reg query "HKCU\Software\Classes\ChemDraft.Structure.1" /s
reg query "HKCU\Software\Classes\ChemDraft.Structure" /s
```

Success means:

- `LocalServer32` is `"<install folder>\chemdraft.exe"`, quoted, in both views;
- `ProgID` is `ChemDraft.Structure.1` and `VersionIndependentProgID` is `ChemDraft.Structure`;
- the ProgID keys' `CLSID` is the CLSID above, and `ChemDraft.Structure\CurVer` is
  `ChemDraft.Structure.1`;
- Word's Insert > Object list shows "ChemDraft Structure".

After an upgrade, the same queries show one CLSID key whose `LocalServer32` is the new path. After
uninstalling, each query reports `ERROR: The system was unable to find the specified registry key or
value.` A dev build must leave the stable keys untouched, and the reverse.

Tests: `cargo test office_ole::registry` covers the flag parsing and scope selection, the
uninstall path check, and the hooks' phases and flags (it reads `installer-hooks.nsh`), and runs on
macOS and Windows. The registry writes themselves are checked only on Windows, by the queries above.

## Release-candidate checks

Two checks run only on the release-candidate installer built by
`.github/workflows/windows-release.yml`; branch builds must never replace the stable app, so they
cannot be checked earlier. Both are required before publishing (see
[three-builds.md](three-builds.md#before-publishing-release-candidate-only-checks)).

### Cold start of the Office editor

1. Install the release-candidate installer. Quit every ChemDraft process (check Task Manager).
2. In Word, choose Insert > Object > ChemDraft Structure. The editor window must show the light
   loading screen ("Opening structure from Word…") from its first frame, never a dark frame.
3. Record the time from the window appearing to the loading text, and from the window to the editor
   ready. Quit every ChemDraft process again and repeat once, so there are two cold starts in Word.
4. Do the same twice in PowerPoint.

### Installer registration

1. Per-user install of the release candidate. Run the `reg query` checks in
   [Verifying](#verifying); the stable class must be registered.
2. Reinstall over it. Run `reg query "HKCU\Software\Classes\CLSID\{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}\LocalServer32" /reg:64`
   and the `/reg:32` form: each shows exactly one `LocalServer32`, at the installed path.
3. Uninstall. The queries report the keys missing, Insert Object in Word and PowerPoint no longer
   lists ChemDraft, and documents saved earlier still show their pictures.
