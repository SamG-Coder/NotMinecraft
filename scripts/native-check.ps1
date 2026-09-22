$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$install = & $vswhere -latest -products * -property installationPath
if (!$install) { throw 'Visual Studio C++ build tools were not found.' }
New-Item -ItemType Directory -Force artifacts | Out-Null
$setup = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
$batch = "@echo off`r`ncall `"$setup`"`r`nif errorlevel 1 exit /b 1`r`nnvcc --fmad=false -O3 tests/native.cu -o artifacts/native-check.exe`r`nif errorlevel 1 exit /b 1`r`nartifacts\native-check.exe`r`n"
Set-Content -LiteralPath 'artifacts/native-check.cmd' -Value $batch -Encoding ascii
& cmd.exe /c artifacts\native-check.cmd
if ($LASTEXITCODE -ne 0) { throw 'Native CUDA check failed.' }
