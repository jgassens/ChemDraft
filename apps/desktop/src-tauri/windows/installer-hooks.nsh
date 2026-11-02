; Tauri CLI 2.11.2's installer.nsi passes an unquoted executable path to APP_ASSOCIATE,
; and FileAssociation.nsh writes it verbatim. Quote the executable and document paths.
; Both installers use this hook; SHCTX writes to HKCU per-user and HKLM all-users.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\ChemDraft Document\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
!macroend
