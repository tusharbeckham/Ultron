$ErrorActionPreference = 'Stop'
$Prefix = if ($env:ULTRON_PREFIX) { $env:ULTRON_PREFIX } else { Join-Path $HOME '.ultron' }
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $Prefix 'app'
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Recurse -Force (Join-Path $Root '*') $Target
$Wrapper = "@echo off`r`nnode `"$Target\bin\ultron.mjs`" %*`r`n"
Set-Content -Path (Join-Path $Prefix 'ultron.cmd') -Value $Wrapper -Encoding Ascii
Write-Host "Installed Ultron CLI to $Prefix\ultron.cmd"
