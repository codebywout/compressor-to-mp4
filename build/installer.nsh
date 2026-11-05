; Custom NSIS hooks for a clean, versioned uninstall.
; FFmpeg wordt in $INSTDIR gezet; die map wist electron-builder al.
; Electron-caches in AppData worden hier extra opgeruimd.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
    !ifdef APP_FILENAME
      RMDir /r "$APPDATA\${APP_FILENAME}"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
    !endif
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      RMDir /r "$LOCALAPPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    ; Oude locatie uit eerdere builds (AppData\VideoCompressor).
    RMDir /r "$APPDATA\VideoCompressor"
    RMDir /r "$LOCALAPPDATA\VideoCompressor"
  ${endIf}

  Delete "$DESKTOP\Video Compressor.lnk"
  Delete "$SMPROGRAMS\Video Compressor.lnk"
!macroend
