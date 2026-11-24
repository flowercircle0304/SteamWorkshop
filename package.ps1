# 配布用パッケージを作る: exe をビルドし、説明書と一緒に release\ に ZIP 化する
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path server.py -Pattern '^VERSION = "(.+)"').Matches[0].Groups[1].Value
$name = "WorkshopManager_v$version"
Write-Host "== $name をビルドします"

python -m pip install --quiet --upgrade pyinstaller pywebview
if ($LASTEXITCODE) { throw 'pip install に失敗しました' }
python -m PyInstaller --noconfirm --clean --onefile --noconsole --name WorkshopManager `
  --icon icon.ico --version-file version_info.txt --add-data "static;static" server.py
if ($LASTEXITCODE) { throw 'ビルドに失敗しました' }

# 配布フォルダを作る（個人の設定や data フォルダは含めない）
# release\ 内の展開済みフォルダから起動中でもぶつからないよう、作業用フォルダは build\ に置く
$stage = Join-Path 'build\package' $name
New-Item -ItemType Directory 'build\package' -Force | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item dist\WorkshopManager.exe $stage
# メモ帳で文字化けしないよう BOM 付き UTF-8 で書き出す
$readme = Get-Content 'dist_files\はじめにお読みください.txt' -Raw -Encoding UTF8
[IO.File]::WriteAllText((Join-Path (Resolve-Path $stage) 'はじめにお読みください.txt'), $readme, (New-Object Text.UTF8Encoding $true))

$zip = "release\$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
"$hash  $name.zip" | Set-Content "release\$name.sha256.txt" -Encoding ASCII

Write-Host ""
Write-Host "完了: $zip"
Write-Host "SHA256: $hash"
