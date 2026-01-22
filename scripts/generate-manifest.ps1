[CmdletBinding()]
param(
  # Directory containing config .json files.
  [Parameter(Mandatory = $false)]
  [string]$ConfigsDir,

  # Output manifest path.
  [Parameter(Mandatory = $false)]
  [string]$ManifestPath
)

$ErrorActionPreference = "Stop"

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

if (-not $ConfigsDir) {
  $ConfigsDir = Join-Path $scriptRoot "..\configs"
}

if (-not $ManifestPath) {
  $ManifestPath = Join-Path $ConfigsDir "manifest.json"
}

if (-not (Test-Path -LiteralPath $ConfigsDir)) {
  throw "ConfigsDir does not exist: $ConfigsDir"
}

$files = Get-ChildItem -LiteralPath $ConfigsDir -File -Filter "*.json" |
  Where-Object { $_.Name -ne "manifest.json" } |
  Sort-Object -Property Name |
  Select-Object -ExpandProperty Name

# Ensure deterministic formatting and UTF-8 output.
$json = $files | ConvertTo-Json -Depth 10

$manifestDir = Split-Path -Parent $ManifestPath
if (-not (Test-Path -LiteralPath $manifestDir)) {
  New-Item -ItemType Directory -Path $manifestDir | Out-Null
}

Set-Content -LiteralPath $ManifestPath -Value ($json + "`n") -Encoding utf8

Write-Host "Wrote manifest: $ManifestPath"
Write-Host ("Count: {0}" -f $files.Count)
