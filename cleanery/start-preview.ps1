$projectRoot = $PSScriptRoot
$previewUrl = 'http://127.0.0.1:4317'
try {
  $previewCheck = Invoke-WebRequest $previewUrl -TimeoutSec 2
  if ($previewCheck.StatusCode -eq 200 -and $previewCheck.Content -match 'CLEANERY') { Write-Output "이미 실행 중: $previewUrl"; exit 0 }
} catch {}
$previewProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput "$projectRoot/preview.log" -RedirectStandardError "$projectRoot/preview-error.log" -PassThru
$previewProcess.Id | Set-Content "$projectRoot/preview.pid"
for ($previewAttempt = 0; $previewAttempt -lt 30; $previewAttempt++) {
  Start-Sleep -Milliseconds 300
  try {
    $previewCheck = Invoke-WebRequest $previewUrl -TimeoutSec 2
    if ($previewCheck.StatusCode -eq 200 -and $previewCheck.Content -match 'CLEANERY') { Write-Output "미리보기 정상 실행: $previewUrl (PID $($previewProcess.Id))"; exit 0 }
  } catch {}
  if ($previewProcess.HasExited) { break }
}
throw '미리보기를 시작하지 못했습니다. preview-error.log를 확인해주세요.'
