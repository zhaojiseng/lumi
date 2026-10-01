# Adapted from electron-builder's MIT-licensed portable.nsi.
# Cache identity is the SHA-256 of the complete packaged application, including architecture.
!include "common.nsh"
!include "extractAppPackage.nsh"
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}
Var cacheRoot
Var cacheMutex
Var smoke

Function .onInit
  InitPluginsDir
  ReadEnvStr $smoke "LUMI_SMOKE"
  ${If} $smoke == "1"
    SetSilent silent
  ${EndIf}
  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir
  ${If} $smoke != "1"
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  ${EndIf}
FunctionEnd

Section
  HideWindow
  StrCpy $cacheRoot "$LOCALAPPDATA\Lumi\portable\${UNPACK_DIR_NAME}"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\Lumi-extract-${UNPACK_DIR_NAME}") p.r2'
  StrCpy $cacheMutex $2
  System::Call 'kernel32::WaitForSingleObject(p r2, i 120000) i.r3'
  ${If} $3 != 0
  ${AndIf} $3 != 128
    MessageBox MB_OK|MB_ICONEXCLAMATION "Lumi is still preparing. Please try again."
    Quit
  ${EndIf}
  IfFileExists "$cacheRoot\.complete" 0 extract
  IfFileExists "$cacheRoot\${APP_EXECUTABLE_FILENAME}" 0 extract
  IfFileExists "$cacheRoot\resources\app.asar" 0 extract
  Goto ready

  extract:
    # Only extract into NSIS's private temporary directory. Never remove shared caches or user data.
    StrCpy $INSTDIR "$PLUGINSDIR\app"
    SetOutPath $INSTDIR
    !insertmacro extractEmbeddedAppPackage
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 failed
    IfFileExists "$INSTDIR\resources\app.asar" 0 failed
    CreateDirectory "$cacheRoot"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\*.*" "$cacheRoot"
    IfErrors failed
    FileOpen $4 "$cacheRoot\.complete" w
    IfErrors failed
    FileWrite $4 "${UNPACK_DIR_NAME}"
    FileClose $4

  ready:
    StrCpy $INSTDIR $cacheRoot
    System::Call 'kernel32::ReleaseMutex(p $cacheMutex)'
    System::Call 'kernel32::CloseHandle(p $cacheMutex)'
    SetOutPath $INSTDIR
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
    ${StdUtils.GetAllParameters} $R0 0
    ${StdUtils.ExecShellWaitEx} $0 $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$R0"
    ${If} $0 == "ok"
      # Keep the native splash until Electron can show its own lightweight loading window.
      System::Call 'user32::WaitForInputIdle(p r1, i 15000) i.r2'
      ${If} $smoke != "1"
        BgImage::Destroy
      ${EndIf}
      ${If} $smoke == "1"
        ${StdUtils.WaitForProcEx} $0 $1
        SetErrorLevel $0
      ${Else}
        System::Call 'kernel32::CloseHandle(p r1)'
      ${EndIf}
      Quit
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Lumi could not start. Please download the portable app again."
    SetErrorLevel 1
    Quit

  failed:
    Delete "$cacheRoot\.complete"
    System::Call 'kernel32::ReleaseMutex(p $cacheMutex)'
    System::Call 'kernel32::CloseHandle(p $cacheMutex)'
    ${If} $smoke != "1"
      BgImage::Destroy
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Lumi could not be extracted. Please check disk space and try again."
    SetErrorLevel 1
SectionEnd
