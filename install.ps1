# Copies every mod in plugins\ into ~\.claude\skills\, where Claude Code loads it
# in every session and every project (desktop app, terminal, VS Code). In PowerShell:
#   Remove-Item -Recurse -Force "$env:TEMP\claude-mods" -ErrorAction SilentlyContinue
#   git clone --depth 1 https://github.com/JPanna/claude-mods "$env:TEMP\claude-mods"
#   powershell -ExecutionPolicy Bypass -File "$env:TEMP\claude-mods\install.ps1"
$ErrorActionPreference = 'Stop'

$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$target = Join-Path $configDir 'skills'
New-Item -ItemType Directory -Force -Path $target | Out-Null

Get-ChildItem -Directory (Join-Path $PSScriptRoot 'plugins') | ForEach-Object {
  $dest = Join-Path $target $_.Name
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $_.FullName $dest
  Write-Host "claude-mods: installed $($_.Name) -> $dest"
}
