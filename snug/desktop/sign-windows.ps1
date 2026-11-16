# Authenticode signing and checking for Snug's Windows files, in CI only (build-snug-windows.yml); not part of
# the app. Runs on a GitHub Windows runner (signtool from the Windows SDK, PowerShell's own signature check).
#   pwsh sign-windows.ps1 sign <file>...    sign with a PFX certificate: WIN_CSC_LINK (the .pfx file, base64)
#                                           and WIN_CSC_KEY_PASSWORD, from the protected `release` environment;
#                                           then checks each file as below
#   pwsh sign-windows.ps1 verify <file>...  every file must carry a valid, timestamped Authenticode signature
#                                           (SignPath-signed files are checked this way too)
# The certificate is written to the runner's temp folder only for signtool and deleted straight after.
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('sign', 'verify')][string]$Mode,
  [Parameter(Mandatory, Position = 1, ValueFromRemainingArguments)][string[]]$Files
)
$ErrorActionPreference = 'Stop'
foreach ($f in $Files) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "sign-windows: missing ${f}" } }

if ($Mode -eq 'sign') {
  if (-not $env:WIN_CSC_LINK) { throw 'sign-windows: WIN_CSC_LINK is not set' }
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw 'sign-windows: signtool.exe not found (Windows SDK)' }
  $pfx = Join-Path ([IO.Path]::GetTempPath()) "snug-sign-$([guid]::NewGuid()).pfx"
  try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WIN_CSC_LINK))
    # SHA-256 file digest and an RFC 3161 timestamp, so the signature stays valid after the certificate expires.
    & $signtool.FullName sign /f $pfx /p "$env:WIN_CSC_KEY_PASSWORD" /fd sha256 /tr http://timestamp.digicert.com /td sha256 /d Snug $Files
    if ($LASTEXITCODE -ne 0) { throw "sign-windows: signtool failed ($LASTEXITCODE)" }
  } finally {
    Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
  }
}

foreach ($f in $Files) {
  $s = Get-AuthenticodeSignature -LiteralPath $f
  if ($s.Status -ne 'Valid') { throw "sign-windows: ${f}: signature is $($s.Status) ($($s.StatusMessage))" }
  if (-not $s.TimeStamperCertificate) { throw "sign-windows: ${f}: signed without a timestamp" }
  Write-Host "${f}: signed by $($s.SignerCertificate.Subject), timestamped by $($s.TimeStamperCertificate.Subject)"
}
