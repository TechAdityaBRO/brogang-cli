# Bro Gang AI CLI installer for Windows (PowerShell)
$ErrorActionPreference = 'Stop'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$url = "https://github.com/TechAdityaBRO/brogang-cli/releases/latest/download/brogang-windows-$arch.zip"
$tmp = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'brogang.zip'
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$bin = Join-Path $tmp 'brogang.exe'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\brogang'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $bin -Destination (Join-Path $dest 'brogang.exe') -Force
$env:PATH += ";$dest"
Write-Host "Installed brogang.exe to $dest"
Write-Host "Add '$dest' to your PATH permanently to use brogang everywhere."
