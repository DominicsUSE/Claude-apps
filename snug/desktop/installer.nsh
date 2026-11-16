; Snug's additions to the electron-builder NSIS script (design 0.10 section 3.5).
; Before uninstalling, offer to save the encrypted data file to the Desktop. Silent runs (the updater's
; installs) and updates never ask. AppData keeps its copy either way (deleteAppDataOnUninstall stays false).
!macro customUnInit
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Save your Snug data file first?$\r$\n$\r$\nIt goes on your Desktop, and a copy stays in AppData." IDNO snug_no_export
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --export-vault'
    snug_no_export:
  ${EndIf}
!macroend
