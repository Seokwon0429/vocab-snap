$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22.13 이상을 설치한 뒤 다시 실행해 주세요.'
}

if (-not (Test-Path -LiteralPath '.env.server')) {
  Write-Host '.env.server가 없어 기본 설정으로 실행합니다.' -ForegroundColor Yellow
  Write-Host '초대 코드나 저장 경로를 바꾸려면 .env.server.example을 .env.server로 복사해 수정하세요.'
}

& node --env-file-if-exists=.env.server server/index.mjs
