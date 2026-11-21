; Tauri CLI 2.11.2's installer.nsi passes an unquoted executable path to APP_ASSOCIATE,
; and FileAssociation.nsh writes it verbatim. Quote the executable and document paths.
; SHCTX is HKCU in a per-user install and HKLM in an all-users one, matching where Tauri wrote
; the association.

; ChemDraft's Office object (docs/architecture/office-editing.md section 4, "Class and
; registration"; docs/releasing/windows-updates.md, "Office object registration"). The executable
; picks its own class from its compiled bundle identifier: the stable app registers only
; ChemDraft.Structure, a dev build only ChemDraft.DevStructure. It writes and removes only that
; class's CLSID and ProgID keys. This file names no class and no other program's keys.
;
; Scope follows the installer: INSTALLMODE "currentUser" -> per-user (HKCU), "perMachine" ->
; all-users (HKLM), "both" -> whichever the user chose on the install-mode page.
!macro CHEMDRAFT_OFFICE_SCOPE _OUT
  !if "${INSTALLMODE}" == "perMachine"
    StrCpy ${_OUT} "all-users"
  !else if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      StrCpy ${_OUT} "all-users"
    ${Else}
      StrCpy ${_OUT} "per-user"
    ${EndIf}
  !else
    StrCpy ${_OUT} "per-user"
  !endif
!macroend

; Runs "<exe> --<action>-office-object=<scope>" and logs the outcome. A failure is logged in the
; installer's details and never aborts the install or uninstall: the app works without the object.
!macro CHEMDRAFT_OFFICE_OBJECT _ACTION
  Push $0
  Push $1
  !insertmacro CHEMDRAFT_OFFICE_SCOPE $1
  ClearErrors
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --${_ACTION}-office-object=$1' $0
  ${If} ${Errors}
    DetailPrint "ChemDraft Office object: could not run $INSTDIR\${MAINBINARYNAME}.exe --${_ACTION}-office-object=$1"
  ${ElseIf} $0 <> 0
    DetailPrint "ChemDraft Office object: --${_ACTION}-office-object=$1 failed (exit code $0); continuing"
  ${Else}
    DetailPrint "ChemDraft Office object: --${_ACTION}-office-object=$1 succeeded"
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

; After the files are installed. Registration overwrites this class's keys in place, so an upgrade
; leaves one registration whose LocalServer32 names the new executable.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\ChemDraft Document\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  !insertmacro CHEMDRAFT_OFFICE_OBJECT register
!macroend

; Before the files are removed, while the executable still exists. Unregistering removes the keys
; only when LocalServer32 names this executable, so it never removes another copy's registration.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CHEMDRAFT_OFFICE_OBJECT unregister
!macroend
