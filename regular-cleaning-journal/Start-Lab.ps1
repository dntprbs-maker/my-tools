param([int]$Port = 8791)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$labPython = 'C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe'
if (-not (Test-Path -LiteralPath $labPython)) { $labPython = (Get-Command python -ErrorAction Stop).Source }
Write-Host "독립 테스트 앱: http://127.0.0.1:$Port (이 PC 전용)"
Write-Host '합성 데이터 전용입니다. 운영 데이터·실제 사진은 입력하지 마세요.'
& $labPython (Join-Path $PSScriptRoot 'server.py') --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
