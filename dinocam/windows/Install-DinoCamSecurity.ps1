<#
.SYNOPSIS
  Installs DinoCamSecurity as a real Windows desktop app: copies the app to a stable
  per-user location, and creates ONE Desktop shortcut and ONE Start Menu shortcut,
  both using the dinosaur icon, both pointing at the current versioned launcher.

.DESCRIPTION
  Run this script from inside the "windows" folder of the DinoCamSecurity app (it
  expects "..\index.html", ".\Launch-DinoCamSecurity.cmd" and ".\dinosaur.ico" to sit
  next to it - that's how they ship in the repo/zip).

  Re-running this script (e.g. after an update) is safe and expected: it deletes any
  DinoCamSecurity shortcut it previously created before making the new one, so you
  never end up with two, three, four confusing icons pointing at different old
  versions. It does NOT touch any other app on your machine.

  What this is: a script that sets up ordinary Windows shortcuts (.lnk files) to a
  local HTML file opened in an app-style browser window. What this is NOT: a signed,
  compiled installer (.msi/.exe) - DinoCamSecurity ships as a single self-contained
  HTML file with no build step, so there is nothing to compile. This script is the
  straightforward way to get a real icon and a real Desktop/Start Menu entry out of
  that without inventing a packaging pipeline the project doesn't otherwise need.

.USAGE
  Right-click this file -> "Run with PowerShell".
  Or, from a PowerShell prompt in this folder:
    powershell -ExecutionPolicy Bypass -File .\Install-DinoCamSecurity.ps1
#>

$ErrorActionPreference = 'Stop'
$AppName    = 'DinoCamSecurity'
$AppVersion = 'v2.0'
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceHtml = Join-Path (Split-Path -Parent $ScriptDir) 'index.html'
$SourceIco  = Join-Path $ScriptDir 'dinosaur.ico'
$SourceCmd  = Join-Path $ScriptDir 'Launch-DinoCamSecurity.cmd'
$InstallDir = Join-Path $env:LOCALAPPDATA 'DinoCamSecurity'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Fail($msg)  { Write-Host "ERROR: $msg" -ForegroundColor Red }

Write-Step "Installing $AppName $AppVersion"

foreach ($f in @($SourceHtml, $SourceIco, $SourceCmd)) {
  if (-not (Test-Path $f)) {
    Write-Fail "Required file not found: $f"
    Write-Fail "Run this script from the 'windows' folder as it ships in the app (index.html must be one folder up)."
    exit 1
  }
}

Write-Step "Copying app files to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path $SourceHtml -Destination (Join-Path $InstallDir 'index.html') -Force
Copy-Item -Path $SourceIco  -Destination (Join-Path $InstallDir 'dinosaur.ico') -Force
Copy-Item -Path $SourceCmd  -Destination (Join-Path $InstallDir 'Launch-DinoCamSecurity.cmd') -Force

$DesktopDir   = [Environment]::GetFolderPath('Desktop')
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$LnkTarget    = Join-Path $InstallDir 'Launch-DinoCamSecurity.cmd'
$IcoPath      = Join-Path $InstallDir 'dinosaur.ico'

Write-Step "Removing any previous DinoCamSecurity shortcuts (so only the current build is launchable)"
$oldPatterns = @('DinoCamSecurity*.lnk', 'Dino Cam Security*.lnk', 'DinoCam*.lnk')
foreach ($dir in @($DesktopDir, $StartMenuDir)) {
  foreach ($pattern in $oldPatterns) {
    Get-ChildItem -Path $dir -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host "   removing old shortcut: $($_.FullName)"
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

function New-DinoShortcut($lnkPath) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = $LnkTarget
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.IconLocation = "$IcoPath,0"
  $shortcut.Description = "$AppName $AppVersion - private local camera monitoring with automatic plate recognition"
  $shortcut.Save()
}

Write-Step "Creating Desktop shortcut"
New-DinoShortcut (Join-Path $DesktopDir "$AppName.lnk")

Write-Step "Creating Start Menu shortcut"
New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null
New-DinoShortcut (Join-Path $StartMenuDir "$AppName.lnk")

Write-Host ""
Write-Host "Done. $AppName $AppVersion is installed at:" -ForegroundColor Green
Write-Host "  $InstallDir"
Write-Host "A dinosaur-icon shortcut was placed on your Desktop and in the Start Menu." -ForegroundColor Green
Write-Host "Double-click either one to launch it - no need to run any .cmd or .ps1 file again"
Write-Host "unless you're installing an update, in which case just run this installer again."
