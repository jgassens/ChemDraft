; Tauri CLI 2.11.2's installer.nsi passes an unquoted executable path to APP_ASSOCIATE,
; and FileAssociation.nsh writes it verbatim. Quote the executable and document paths.
; Both installers use this hook; SHCTX writes to HKCU per-user and HKLM all-users.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\ChemDraft Document\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
!macroend

Var ChemDraftAssociationProgId
Var ChemDraftAssociationHadDefault

; APP_UNASSOCIATE restores a backup unconditionally. Keep the current owner,
; including a missing default value, across Tauri's own association cleanup.
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $ChemDraftAssociationHadDefault 0
  ClearErrors
  ReadRegStr $ChemDraftAssociationProgId SHCTX "Software\Classes\.chemdraft" ""
  ${IfNot} ${Errors}
    StrCpy $ChemDraftAssociationHadDefault 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's optional app-data removal switches the shell context to current.
  ; Restore the install scope before using SHCTX (especially for all-users).
  !insertmacro SetContext

  ${If} $ChemDraftAssociationHadDefault = 1
    WriteRegStr SHCTX "Software\Classes\.chemdraft" "" "$ChemDraftAssociationProgId"
  ${Else}
    DeleteRegValue SHCTX "Software\Classes\.chemdraft" ""
  ${EndIf}

  DeleteRegKey SHCTX "Software\Classes\ChemDraft Document"
  DeleteRegValue SHCTX "Software\Classes\.chemdraft" "ChemDraft Document_backup"
  DeleteRegValue SHCTX "Software\Classes\.chemdraft\OpenWithProgids" "ChemDraft Document"

  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\.chemdraft" ""
  ; StrCmpS requires an exact, case-sensitive match before deleting the key.
  StrCmpS $0 "ChemDraft Document" 0 +2
    DeleteRegKey SHCTX "Software\Classes\.chemdraft"
  Pop $0

  !insertmacro UPDATEFILEASSOC
!macroend
