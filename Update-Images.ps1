$ErrorActionPreference = 'Stop'
$pythonCommand = Get-Command python -ErrorAction Stop
& $pythonCommand.Source -B (Join-Path $PSScriptRoot 'scripts\download_images.py') @args
if ($LASTEXITCODE -ne 0) { throw 'Some public images could not be cached. Existing files and source manifest were preserved; inspect the reported paths and retry.' }
