# 新しいバージョンを GitHub に公開する: ビルド → ZIP 作成 → GitHub リリースに添付
# 事前に server.py の VERSION と version_info.txt を上げておく。gh (GitHub CLI) にログインしている必要がある
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = 'flowercircle0304/SteamWorkshop'

$version = (Select-String -Path server.py -Pattern '^VERSION = "(.+)"').Matches[0].Groups[1].Value
$name = "WorkshopManager_v$version"
& powershell -NoProfile -ExecutionPolicy Bypass -File .\package.ps1
if ($LASTEXITCODE) { throw 'パッケージ作成に失敗しました' }

$notes = Read-Host "v$version の変更内容（1 行。空欄なら自動）"
if (-not $notes) { $notes = "Workshop Manager v$version" }
gh release create "v$version" "release\$name.zip" "release\$name.sha256.txt" -R $repo --title "v$version" --notes $notes
if ($LASTEXITCODE) { throw 'GitHub への公開に失敗しました' }
Write-Host "公開しました: https://github.com/$repo/releases/tag/v$version"
