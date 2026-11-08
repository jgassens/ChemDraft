# Windows installer scope audit (#252)

This is a source review, not Windows runtime verification. Ground truth is the saved Tauri CLI
2.11.2 template `installer-tauri-cli-v2.11.2.nsi` and updater 2.12.0 source `updater-windows.rs`
under `/Users/jeremiahgassensmith/programming/chemdraw-wt/_master-scratch/b1-tauri-nsis/`.
References to those basenames below mean those read-only files. This adapts the earlier audit in
commit `140d2030` to two installers with separate feeds.

## Separate installers and update feeds

The base `tauri.conf.json` remains `currentUser`; `tauri.windows.conf.json` retains the existing
`latest.json` endpoint, public key and passive updater mode. The released per-user filename remains
`ChemDraft_<ver>_x64-setup.exe`.

The release workflow adds `--config src-tauri/tauri.allusers.conf.json` for a second build. This
overlay sets `bundle.windows.nsis.installMode` to `perMachine` and replaces
only the updater endpoint with `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest-allusers.json`.
It inherits the public key, passive update mode, quoting hook and Windows-only `.chemdraft` association. The workflow
stages this installer as `ChemDraft_<ver>_x64-allusers-setup.exe` before signing. Each feed is generated
with the existing `release:windows-manifest` script using its own installer and `.sig`; both feeds
must be committed to `main` together after the release assets are downloadable.

Each installer has a fixed scope. The template emits `RequestExecutionLevel admin` for `perMachine`
and `user` for `currentUser` (`installer-tauri-cli-v2.11.2.nsi:98`–`105`). On x64 it defaults the
machine install to `$PROGRAMFILES64\${PRODUCTNAME}`, normally `C:\Program Files\ChemDraft`; the
per-user default remains `$LOCALAPPDATA\${PRODUCTNAME}` (`:491`–`512`). `SetContext` selects the
scope used by `SHCTX` and shell folders. Shortcuts use `$SMPROGRAMS` (`:940`–`946`), so the machine
installer creates an all-users Start Menu shortcut. Existing installation locations are restored
from the selected scope's registry (`:893`–`897`).

Installing both produces two copies. Neither installer migrates or removes the other copy. They
share the stable application identifier; settings and plugins remain per account. Uninstall the
other scope before switching, including to avoid a retained HKCU file association overriding HKLM.

## Program Files and writable state

No application-owned write into the executable or bundled-resource directory was found in the
audited paths. All-users installation shares program files; application data remains per account.

| Area | Source evidence |
| --- | --- |
| Toolbar settings and document session | `apps/desktop/src-tauri/src/lib.rs:8930`–`8953` resolves files through `app_data_dir()`. |
| Plugin storage | `apps/desktop/src-tauri/src/lib.rs:2885`–`2898` resolves `plugins/<id>/storage.json` through `app_data_dir()`. |
| Installed-plugin serving | `apps/desktop/src-tauri/src/installed_plugins.rs:74`–`78` uses app data; `:151`–`163` reads validated paths beneath it. `:48`–`55` retains Windows origin `http://tauri.localhost`, independently of the installation path. |
| Naming and OCSR installation | `apps/desktop/src-tauri/src/naming_engine/mod.rs:550`–`559` and `apps/desktop/src-tauri/src/ocsr_engine/mod.rs:814`–`825` inject app data; `apps/desktop/src-tauri/src/local_engine/install.rs:30`–`45` derives final, staging and previous directories from it. |
| External tools | `apps/desktop/src-tauri/src/external_tools/mod.rs:424`–`428` uses `app_local_data_dir()/external-tools`. |
| Downloaded app updater | `updater-windows.rs:962`–`969` and `:1006`–`1025` write the installer to a temporary directory. |

OPSIN resolves bundled Java resources and strips Windows verbatim drive prefixes
(`apps/desktop/src-tauri/src/opsin.rs:124`–`167`). It launches Java with `Command::new`, the jar's
parent as cwd, and the jar basename as one argument (`:348`–`367`): no shell splits Program Files
at its space, and these operations read the bundle rather than writing to it.

Naming also strips verbatim drive prefixes (`apps/desktop/src-tauri/src/naming_engine/mod.rs:574`–`595`).
Its Python command uses `-I -B`, the writable engine directory as cwd, bundled JRE as `JAVA_HOME`,
and app-data cache (`apps/desktop/src-tauri/src/naming_engine/process.rs:104`–`119`). The sidecar
checks `<JAVA_HOME>/bin/server/jvm.dll` and host-supplied jars before requiring a working JPype JVM
(`apps/desktop/src-tauri/resources/naming/orthonym_sidecar.py:96`–`164`). The host requests no copying
or writing of the JVM. DLL loading from Program Files still needs a Windows pass.

The 3D sidecar is found beside the executable using path joins
(`apps/desktop/src-tauri/src/lib.rs:6394`–`6417`) and launched directly with piped stdio
(`:6483`–`6489`). The reviewed native sidecar source uses the stdio protocol, with no application-state
file write beside its executable.

## File association quoting: both installers

The template passes an unquoted executable to `APP_ASSOCIATE`
(`installer-tauri-cli-v2.11.2.nsi:660`). Its matching
[FileAssociation.nsh:79](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/FileAssociation.nsh#L79)
writes that command verbatim, making a Program Files path ambiguous. The shared hook
`apps/desktop/src-tauri/windows/installer-hooks.nsh` rewrites the command with both paths
quoted, using `SHCTX` (HKCU per-user, HKLM all-users):

```text
"C:\Program Files\ChemDraft\chemdraft.exe" "%1"
```

The template calls `NSIS_HOOK_POSTINSTALL` after associations and shortcuts (`:727`–`729`). The hook
is wired by the Windows config for both installers, and changes only the `ChemDraft Document` class's open
command. The existing uninstaller removes that class. No `.cdxml` association is added. The config
test checks the hook wiring and resulting command with spaces in both paths.

## Updates require administrator rights for the machine install

Updater 2.12.0 launches the temporary installer with `ShellExecuteW("open", ...)`
(`updater-windows.rs:854`–`882`). Parameters include passive-mode arguments, `/UPDATE` and restart
arguments (`:885`–`914`). `/UPDATE` avoids uninstalling before replacement
(`installer-tauri-cli-v2.11.2.nsi:312`–`315`); restart uses `RunAsUser` (`:735`–`746`).

The all-users feed always delivers a `perMachine` installer, whose `RequestExecutionLevel admin`
manifest requests elevation even for passive updates. **Every machine update needs admin rights.**
An unelevated administrator sees the normal UAC consent prompt; a standard user sees an
admin-credentials UAC prompt. Passive mode is not an elevation bypass. If no administrator can
supply credentials, defer the update for managed deployment. A process already elevated does not
need another prompt. Test cancellation and restoration in the original account on Windows.

Because each feed delivers an installer with the same fixed scope as the installed app, an all-users
update cannot choose the per-user destination. No updater scope flags or native updater changes are
needed. This depends on release discipline: never put the per-user artifact URL in `latest-allusers.json`.

## Integration handoff

On macOS, the focused config tests passed (8 tests), as did the existing manifest-generator tests
(5 tests), using existing dependencies without installing packages. The workflow YAML and all
embedded PowerShell blocks parsed successfully; `git diff --check` passed. No native app, installer,
Rust check or full suite was run. Windows runtime behavior remains unverified. Test CI-built
installers only: both scopes' UAC/update destination,
HKCU/HKLM associations, all-users Start Menu, `/S` from an elevated prompt, normal-user runtime use
under Program Files (OPSIN, naming/JVM, installed plugins, 3D), administrator-credential updates,
cancellation, session restoration to the original account, no duplicate per-user copy, and uninstall.
No macOS native build is needed for these Windows-only packaging changes; macOS runtime was not run.
The recommended next task is this CI-built Windows installer and update pass.

Before a signed CI run, update any existing single-installer SignPath artifact configuration to
select both installers, as documented in `docs/releasing/windows-signing.md`. The workflow verifies
the exact returned filename set and requires a valid Authenticode signature on each installer.

The build stamp in `apps/desktop/src/MainWindow.tsx` is bumped so the build is identifiable; `scripts/ci/require-build-stamp-bump.sh` alone would not require it, since the only change under `apps/desktop/src` is a test file.
