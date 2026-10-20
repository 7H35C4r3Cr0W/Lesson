<#
Copy Star Cards to the Raspberry Pi and (re)install it there, in one go.

    .\deploy\deploy-from-windows.ps1                      # uses starcards.local and user pi
    .\deploy\deploy-from-windows.ps1 -PiHost 192.168.1.50 -User pi
    .\deploy\deploy-from-windows.ps1 -InstallVoices       # also install the natural voice (Piper, ~200 MB, once)

Needs: Windows OpenSSH (ssh, scp: built into Windows 11), and ssh login on the Pi.
First time, you will be asked for the Pi password twice. To stop that, run once:
    ssh-keygen -t ed25519
    type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@starcards.local "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
#>
param(
  [string]$PiHost = "starcards.local",
  [string]$User = "pi",
  [switch]$SkipTests,
  [switch]$InstallVoices
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipTests) {
  Write-Host "==> Running the server tests here first" -ForegroundColor Cyan
  python -m unittest discover -s tests
  if ($LASTEXITCODE -ne 0) { throw "Tests failed; not deploying." }
}

Write-Host "==> Checking the card content" -ForegroundColor Cyan
python tools/validate_content.py
if ($LASTEXITCODE -ne 0) { throw "Content has errors; not deploying." }

$target = "$User@$PiHost"
Write-Host "==> Copying to $target (~/starcards-src)" -ForegroundColor Cyan
# $ErrorActionPreference does not cover ssh/scp (native programs), so check each one by hand:
# a half-copied tree must never be installed.
ssh $target "rm -rf ~/starcards-src && mkdir -p ~/starcards-src"
if ($LASTEXITCODE -ne 0) { throw "Could not reach $target over ssh; nothing was changed on the Pi." }
scp -r -q server.py web content tools tests deploy README.md CONTENT.md "${target}:starcards-src/"
if ($LASTEXITCODE -ne 0) { throw "Copying to the Pi failed part-way; not installing." }

Write-Host "==> Installing on the Pi (sudo)" -ForegroundColor Cyan
# Windows may have saved the script with CRLF line endings, which bash cannot run; fix that first.
ssh -t $target "sed -i 's/\r`$//' ~/starcards-src/deploy/install.sh && sudo bash ~/starcards-src/deploy/install.sh"
if ($LASTEXITCODE -ne 0) { throw "install.sh reported an error on the Pi (see above)." }

if ($InstallVoices) {
  Write-Host "==> Installing the natural voice on the Pi (Piper + 3 voices, ~200 MB download, sudo)" -ForegroundColor Cyan
  ssh -t $target "sed -i 's/\r`$//' ~/starcards-src/deploy/install-voices.sh && sudo bash ~/starcards-src/deploy/install-voices.sh"
  if ($LASTEXITCODE -ne 0) { throw "install-voices.sh reported an error on the Pi (see above)." }
}
