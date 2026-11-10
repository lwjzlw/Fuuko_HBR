$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$snapshotDir = Join-Path $taskRoot ('work\catalog-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $snapshotDir | Out-Null
foreach ($table in @('characters','styles','zhTW','latent_abilities','support_skills','accessories','boosters','chips')) {
    Invoke-WebRequest -Uri ('https://master.hbr.quest/v1/' + $table + '.json') -OutFile (Join-Path $snapshotDir ($table + '.json'))
}
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExe = $nodeCommand.Source
& $nodeExe (Join-Path $taskRoot 'scripts\build-catalog.mjs') $snapshotDir
if ($LASTEXITCODE -ne 0) { throw 'Catalog build failed; inspect downloaded snapshots.' }
& $nodeExe (Join-Path $taskRoot 'scripts\build-equipment.mjs') $snapshotDir
if ($LASTEXITCODE -ne 0) { throw 'Equipment build failed; inspect downloaded snapshots.' }
& (Join-Path $taskRoot 'Update-Images.ps1')
