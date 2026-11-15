; Stop our Xray core before installing or uninstalling, otherwise Windows keeps
; tunnel-browser-core.exe locked and the update cannot replace it. The name is unique
; to this app, so other Xray clients (v2rayN etc.) are never touched.

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "tunnel-browser-core.exe"'
  Pop $0
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "tunnel-browser-core.exe"'
  Pop $0
!macroend
