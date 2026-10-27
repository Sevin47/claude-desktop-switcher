param([string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) 'claude-autoswitch.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Failover' }, $true)
if (-not $function) { throw 'Invoke-Failover missing' }
# Load only the real failover function. No top-level paths, process checks,
# watcher, warm-up, account state, or transcript code runs in this test.
. ([scriptblock]::Create($function.Extent.Text))
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('claude-autoswitch-integration-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureRoot -Force)
$ProfileScript = Join-Path $fixtureRoot 'fake-profile.ps1'
$FixtureMarker = Join-Path $fixtureRoot 'invocation.json'
@'
param([Parameter(Position=0)][string]$Command, [Parameter(Position=1)][string]$Name, [switch]$NoLaunch)
[IO.File]::WriteAllText($FixtureMarker, (@{Command=$Command; Name=$Name; NoLaunch=[bool]$NoLaunch} | ConvertTo-Json -Compress))
Write-Host 'History preserved: 4 added, 2 refreshed, 3 kept. Backup: synthetic-only.'
if ($Case -eq 'exit-failure') { exit 17 }
if ($Case -eq 'throw-failure') { throw 'Synthetic blocked graceful close' }
'@ | Set-Content -LiteralPath $ProfileScript -Encoding UTF8
function Write-Log { param([string]$Message,[string]$Color) [void]$script:Logs.Add($Message) }
function Show-Toast { param([string]$Title,[string]$Body) [void]$script:Toasts.Add("$Title $Body") }
function Get-LiveAccountUuid {
    $script:Reads++
    if ($script:Case -eq 'no-identity') { return $null }
    if ($script:Reads -eq 1 -or $script:Case -eq 'wrong-identity') { return 'uuid-source' }
    if ($script:Case -eq 'expired-login' -and $script:Reads -gt 2) { return 'uuid-source' }
    if ($script:Case -eq 'skip-limited') { return 'uuid-beta' }
    return 'uuid-alpha'
}
function Register-Cooldown { param($Uuid,$ResetsAt,$LimitType) $script:Cooldowns[$Uuid]=$ResetsAt; $script:Registers++ }
function Get-Cooldowns { return $script:Cooldowns }
function Get-NowEpoch { return 1000 }
function Get-ProfileMap { return @{ source='uuid-source'; alpha='uuid-alpha'; beta='uuid-beta' } }
function Get-ProfileLabel { param($Name) return "label-$Name" }
function Format-Epoch { param($Value) return "epoch-$Value" }
function Get-ClaudeAumid { return 'SyntheticClaude!Claude' }
function Start-Sleep { param($Seconds,$Milliseconds) }
function Start-Process { param([string]$FilePath) [void]$script:Launches.Add($FilePath) }
function Copy-ActiveSessionsToAccount { throw 'Unsafe old carry-over called' }
function Get-TranscriptPath { throw 'Unsafe transcript import path called' }
function Remove-Item { throw 'Unsafe session cleanup called' }
function Copy-Item { throw 'Unsafe live session copy called' }
function Assert { param($Condition,[string]$Message) if (-not $Condition) { throw "$script:Case : $Message" } }
$completed = @()
foreach ($scenario in @('success','dry-run','exit-failure','throw-failure','wrong-identity','no-target','skip-limited','expired-login','no-identity')) {
    $script:Case = $scenario
    $script:Logs = New-Object 'System.Collections.Generic.List[string]'
    $script:Toasts = New-Object 'System.Collections.Generic.List[string]'
    $script:Launches = New-Object 'System.Collections.Generic.List[string]'
    $script:Reads = 0; $script:Registers = 0
    $script:Cooldowns = @{}
    $DryRun = ($scenario -eq 'dry-run')
    if ($scenario -eq 'skip-limited') { $script:Cooldowns['uuid-alpha']=2000 }
    if ($scenario -eq 'no-target') { $script:Cooldowns['uuid-alpha']=2000; $script:Cooldowns['uuid-beta']=2000 }
    [IO.File]::WriteAllText($FixtureMarker, '')
    $LASTEXITCODE = 7 # a previous native command must not cause false failure
    Invoke-Failover -CliSessionId 'synthetic-session' -ResetsAt 1500 -LimitType 'seven_day'
    $invocation = [IO.File]::ReadAllText($FixtureMarker)
    $shouldCall = $scenario -notin @('dry-run','no-target','no-identity')
    Assert ([bool]$invocation -eq $shouldCall) 'Unexpected profile call behavior'
    Assert ($script:Registers -eq [int]($scenario -ne 'no-identity')) 'Cooldown behavior changed'
    if ($shouldCall) {
        $call = $invocation | ConvertFrom-Json
        Assert ($call.Command -eq 'switch' -and $call.NoLaunch) 'Expected profile switch -NoLaunch'
        $expected = if ($scenario -eq 'skip-limited') { 'beta' } else { 'alpha' }
        Assert ($call.Name -eq $expected) 'Profile selection changed'
        Assert (($script:Logs -join "`n") -match 'History preserved: 4 added, 2 refreshed, 3 kept') 'History result missing from log'
    }
    $shouldLaunch = $scenario -in @('success','skip-limited','expired-login')
    Assert ($script:Launches.Count -eq [int]$shouldLaunch) 'Unexpected app launch behavior'
    foreach ($launch in $script:Launches) { Assert ($launch -eq 'shell:AppsFolder\SyntheticClaude!Claude') 'Must use normal app launch without resume URI or prompts' }
    if ($scenario -in @('success','skip-limited')) { Assert (($script:Logs -join "`n") -match 'Open your conversation in Code and resend') 'Manual resume guidance missing' }
    if ($scenario -in @('exit-failure','throw-failure')) { Assert (($script:Logs -join "`n") -match 'Switch stopped safely') 'Failure not logged' }
    if ($scenario -eq 'expired-login') { Assert (($script:Logs -join "`n") -match 'could not confirm') 'Lost account identity not detected' }
    $completed += $scenario
}
[pscustomobject]@{PowerShell=$PSVersionTable.PSVersion.ToString(); Passed=$completed.Count; Scenarios=$completed} | ConvertTo-Json -Compress
