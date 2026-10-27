[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('claude-profile-history-test-' + [guid]::NewGuid().ToString('N'))
$fakeHome = Join-Path $fixture 'home'
$fakeApp = Join-Path $fixture 'app'
$fakeStore = Join-Path $fakeHome '.claude-profiles'
$sourceAccount = '11111111-1111-4111-8111-111111111111'
$targetAccount = '22222222-2222-4222-8222-222222222222'
$org = '33333333-3333-4333-8333-333333333333'
$cli = '44444444-4444-4444-8444-444444444444'
$localId = 'local_55555555-5555-4555-8555-555555555555'
$oldFrame = '66666666-6666-4666-8666-666666666666'
$newFrame = '77777777-7777-4777-8777-777777777777'
$testScript = Join-Path $fixture 'claude-profile.ps1'
$engine = Join-Path $fixture 'claude-history-sync.mjs'
$sourceDir = Join-Path $fakeApp "claude-code-sessions\$sourceAccount\$org"
$targetDir = Join-Path $fakeApp "claude-code-sessions\$targetAccount\$org"
$sourceIndex = Join-Path $sourceDir ($localId + '.json')
$targetIndex = Join-Path $targetDir ($localId + '.json')
$transcript = Join-Path $fakeHome ".claude\projects\fixture\$cli.jsonl"
$journal = Join-Path $fakeStore '.history-switch-in-progress.json'
$authJournal = Join-Path $fakeStore '.switch-in-progress'
New-Item -ItemType Directory -Path $fixture,$fakeHome,$fakeApp,$fakeStore,$sourceDir,$targetDir,(Split-Path $transcript) -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'claude-history-sync.mjs') -Destination $engine

function Put([string]$File, $Value) {
    $parent = Split-Path $File
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $text = if ($Value -is [string]) { $Value } else { $Value | ConvertTo-Json -Depth 30 }
    [IO.File]::WriteAllText($File, $text)
}
function Check([string]$Label, [bool]$Condition) {
    if (-not $Condition) { throw "FAIL: $Label" }
    Write-Host "PASS: $Label"
}
function Read-Json([string]$File) { Get-Content -LiteralPath $File -Raw | ConvertFrom-Json }
function Fake-State([string]$Root, [string]$Account, [switch]$Live) {
    foreach ($part in 'Network','Local Storage','Session Storage') { New-Item -ItemType Directory -Path (Join-Path $Root $part) -Force | Out-Null }
    Put (Join-Path $Root 'Local State') @{syntheticAccount=$Account}
    Put (Join-Path $Root 'Network\Cookies') "synthetic-cookie-db-$Account"
    Put (Join-Path $Root 'Local Storage\fixture.txt') "synthetic-local-storage-$Account"
    Put (Join-Path $Root 'Session Storage\fixture.txt') "synthetic-session-storage-$Account"
    Put (Join-Path $Root 'config.json') @{lastKnownAccountUuid=$Account}
    $file = if ($Live) { Join-Path $fakeHome '.claude.json' } else { Join-Path $Root 'claude.json' }
    Put $file @{oauthAccount=@{accountUuid=$Account;emailAddress='synthetic@example.invalid'}}
}
function Reset-Fixture {
    foreach ($marker in @($journal,$authJournal)) {
        if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    }
    Fake-State (Join-Path $fakeStore 'A') $sourceAccount
    Fake-State (Join-Path $fakeStore 'B') $targetAccount
    Fake-State $fakeApp $sourceAccount -Live
    Put (Join-Path $fakeStore 'current.txt') 'A'
    $base = @{sessionId=$localId;cliSessionId=$cli;cwd=(Join-Path $fixture 'project');title='Synthetic';lastActivityAt=1;lastAssistantUuid=$oldFrame}
    Put $targetIndex $base
    $base.lastAssistantUuid=$newFrame;$base.lastActivityAt=2
    Put $sourceIndex $base
    $rows = @(@{type='assistant';uuid=$oldFrame;parentUuid=$null},@{type='assistant';uuid=$newFrame;parentUuid=$oldFrame})
    Put $transcript (($rows | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join "`n")
}

# Exercise the real command dispatch and real Node engine. Replace only OS/app
# discovery, process controls and the mutex name, all confined to this fixture.
$sourcePath = Join-Path $repo 'claude-profile.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
Check "profile script parses in PowerShell $($PSVersionTable.PSVersion)" ($errors.Count -eq 0)

# Exercise the real graceful-close function in an isolated function scope.
# Every process, sleep and file-lock result is synthetic; no OS process query
# or application action can occur in these cases.
$stopFunction=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-ClaudeApp'},$true)
& {
    param([string]$Definition)
    . ([scriptblock]::Create($Definition))
    function Get-Process {
        param([string]$Name,[string]$ErrorAction)
        if ($Name -ne 'claude') { throw 'Unexpected process query in graceful-close fixture' }
        if ($state.Running) { return $process }
        return $null
    }
    function Start-Sleep { param([int]$Milliseconds) $state.Sleeps++ }
    function Test-FileUnlocked {
        param([string]$Path)
        $state.UnlockChecks++
        if ($state.Mode -eq 'normal') { return $state.UnlockChecks -ge 2 }
        return $state.Mode -eq 'already-closed'
    }
    function Stop-Process { $state.ForceAttempt=$true; throw 'A graceful close must never force-kill a process' }
    $CookieDb='synthetic-cookie-db-path'
    foreach ($mode in @('normal','tray-remains','cookies-locked','already-closed')) {
        $state=@{Mode=$mode;Running=($mode -in @('normal','tray-remains'));CloseCalls=0;Sleeps=0;UnlockChecks=0;ForceAttempt=$false}
        $handle=if ($mode -eq 'tray-remains') { [IntPtr]::Zero } else { [IntPtr]1 }
        $process=[pscustomobject]@{MainWindowHandle=$handle;State=$state}
        $process | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {
            $this.State.CloseCalls++
            $this.State.Running=$false
            return $true
        }
        $failure=$null
        try { Stop-ClaudeApp } catch { $failure=$_.Exception.Message }
        Check "graceful close ($mode) never force-kills" (-not $state.ForceAttempt)
        switch ($mode) {
            'normal' { Check 'normal close requests the main window once and waits for cookie unlock' (-not $failure -and $state.CloseCalls -eq 1 -and $state.UnlockChecks -eq 2) }
            'tray-remains' { Check 'tray process times out with manual exit instructions and no close attempt' ($failure -like '*File > Exit*' -and $state.CloseCalls -eq 0 -and $state.Sleeps -eq 40 -and $state.UnlockChecks -eq 0) }
            'cookies-locked' { Check 'locked cookies block switching after all graceful-close retries' ($failure -like '*still locked*' -and $state.CloseCalls -eq 0 -and $state.UnlockChecks -eq 40) }
            'already-closed' { Check 'closed app with unlocked cookies needs no application action' (-not $failure -and $state.CloseCalls -eq 0 -and $state.UnlockChecks -eq 1) }
        }
    }
} $stopFunction.Extent.Text

$source=[IO.File]::ReadAllText($sourcePath)
foreach($name in 'Assert-ClaudeClosed') {
    $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    $source=$source.Replace($function.Extent.Text, ('function ' + $name + ' { }'))
}
$source=$source.Replace($stopFunction.Extent.Text, 'function Stop-ClaudeApp { [IO.File]::AppendAllText((Join-Path $env:USERPROFILE ''stop-calls.txt''), ''called'') }')
$source=$source.Replace('$AppRoot = Resolve-AppRoot', ('$AppRoot = ''' + $fakeApp.Replace("'","''") + "'"))
$source=$source.Replace('$Aumid   = Get-ClaudeAumid', '$Aumid = ''fixture!Claude''')
$fixtureLockName='Local\ClaudeHistoryFixture-' + [guid]::NewGuid().ToString('N')
$source=$source.Replace("'Global\ClaudeSwitcherProfileOp'", ("'" + $fixtureLockName + "'"))
$source=$source.Replace("Get-Process -Name 'claude' -ErrorAction SilentlyContinue", '$null')
Put $testScript $source
$runner = if ($PSVersionTable.PSEdition -eq 'Desktop') { Join-Path $PSHOME 'powershell.exe' } else { Join-Path $PSHOME 'pwsh.exe' }
function Run-Profile([string]$Command='switch', [string]$Name='B', [string]$Script=$testScript) {
    $previous=$ErrorActionPreference
    try { $ErrorActionPreference='Continue'; $log=& $runner -NoProfile -ExecutionPolicy Bypass -File $Script $Command $Name -NoLaunch 2>&1 | Out-String; $code=$LASTEXITCODE }
    finally { $ErrorActionPreference=$previous }
    return [pscustomobject]@{Code=$code;Log=$log}
}
function Engine([string]$Mode,[string]$Transaction='') {
    $params=@($engine,'--mode',$Mode)
    if($Mode -eq 'prepare'){$params+=@('--app-root',$fakeApp,'--user-root',$fakeHome,'--source',$sourceAccount,'--target',$targetAccount)}
    else{$params+=@('--transaction',$Transaction)}
    $result=& node.exe @params
    if($LASTEXITCODE -ne 0){throw 'Synthetic engine command failed'}
    return $result|ConvertFrom-Json
}
function Journal([string]$Transaction) { Put $journal @{transactionPath=$Transaction;sourceAccount=$sourceAccount;targetAccount=$targetAccount;targetProfile='B';phase='switching-auth'} }
$originalHome=$env:USERPROFILE
try {
    $env:USERPROFILE=$fakeHome
    Reset-Fixture
    $originalSourceHash=(Get-FileHash -LiteralPath $sourceIndex).Hash
    $result=Run-Profile
    Check 'full switch succeeds with history preparation before auth restore' ($result.Code -eq 0)
    Check 'target history has the latest message' ((Read-Json $targetIndex).lastAssistantUuid -eq $newFrame)
    Check 'live account changes only after history succeeded' ((Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $targetAccount)
    Check 'source history remains unchanged' ((Get-FileHash -LiteralPath $sourceIndex).Hash -eq $originalSourceHash)
    Check 'successful switch clears history journal' (-not (Test-Path -LiteralPath $journal))
    Check 'switch reports history verification' ($result.Log.Contains('History preserved:'))

    Reset-Fixture
    Put (Join-Path $fakeStore 'current.txt') 'B'
    Put (Join-Path $fakeApp 'config.json') @{lastKnownAccountUuid=$sourceAccount;payload='fresh-source'}
    Put (Join-Path (Join-Path $fakeStore 'B') 'config.json') @{lastKnownAccountUuid=$targetAccount;payload='saved-target'}
    $result=Run-Profile
    Check 'stale current marker equal to target does not skip a real switch' ($result.Code -eq 0 -and (Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $targetAccount)
    Check 'outgoing checkpoint follows live account rather than stale marker' ((Read-Json (Join-Path (Join-Path $fakeStore 'A') 'config.json')).payload -eq 'fresh-source' -and (Read-Json (Join-Path (Join-Path $fakeStore 'B') 'config.json')).payload -eq 'saved-target')
    Put (Join-Path $fakeStore 'current.txt') 'A'
    $stopsBefore=[IO.File]::ReadAllText((Join-Path $fakeHome 'stop-calls.txt'))
    $targetBefore=(Get-FileHash -LiteralPath $targetIndex).Hash
    $result=Run-Profile
    Check 'already active target repairs stale marker without closing Claude' ($result.Code -eq 0 -and [IO.File]::ReadAllText((Join-Path $fakeStore 'current.txt')) -eq 'B' -and [IO.File]::ReadAllText((Join-Path $fakeHome 'stop-calls.txt')) -eq $stopsBefore)
    Check 'already active target leaves session history untouched' ((Get-FileHash -LiteralPath $targetIndex).Hash -eq $targetBefore -and -not (Test-Path -LiteralPath $journal))

    Reset-Fixture
    Put $transcript '{broken-json'
    $originalTargetHash=(Get-FileHash -LiteralPath $targetIndex).Hash
    $result=Run-Profile
    Check 'invalid transcript prevents switching' ($result.Code -ne 0)
    Check 'failed validation keeps original account selected' ((Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $sourceAccount)
    Check 'failed validation leaves destination untouched' ((Get-FileHash -LiteralPath $targetIndex).Hash -eq $originalTargetHash)

    Reset-Fixture
    $failureScript=Join-Path $fixture 'profile-restore-failure.ps1'
    $mockAst=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
    $restore=$mockAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Restore-Profile'},$true)
    Put $failureScript ($source.Replace($restore.Extent.Text, 'function Restore-Profile { param([string]$ProfileName) throw ''Synthetic restore failure'' }'))
    $originalTargetHash=(Get-FileHash -LiteralPath $targetIndex).Hash
    $result=Run-Profile -Script $failureScript
    Check 'auth failure is reported' ($result.Code -ne 0)
    Check 'auth failure rolls back newly installed destination history' ((Get-FileHash -LiteralPath $targetIndex).Hash -eq $originalTargetHash)
    Check 'completed rollback clears history journal' (-not (Test-Path -LiteralPath $journal))

    Reset-Fixture
    $originalTargetHash=(Get-FileHash -LiteralPath $targetIndex).Hash
    $prepared=Engine prepare
    $null=Engine apply $prepared.transactionPath
    Journal $prepared.transactionPath
    $result=Run-Profile -Command list -Name ''
    Check 'interrupted switch recovers when source account is still active' ($result.Code -eq 0 -and (Get-FileHash -LiteralPath $targetIndex).Hash -eq $originalTargetHash -and -not (Test-Path -LiteralPath $journal))

    Reset-Fixture
    $prepared=Engine prepare
    $null=Engine apply $prepared.transactionPath
    Fake-State $fakeApp $targetAccount -Live
    Journal $prepared.transactionPath
    $result=Run-Profile -Command list -Name ''
    Check 'interrupted switch keeps installed history when target is active' ($result.Code -eq 0 -and (Read-Json $targetIndex).lastAssistantUuid -eq $newFrame -and -not (Test-Path -LiteralPath $journal))

    # Both journals must recover authentication first. The mixed synthetic
    # state still identifies as source, so recovering history first would
    # incorrectly roll back the history already installed for the target.
    Reset-Fixture
    $prepared=Engine prepare
    $null=Engine apply $prepared.transactionPath
    Journal $prepared.transactionPath
    Put $authJournal 'B'
    Put (Join-Path $fakeApp 'Local State') @{syntheticAccount=$targetAccount}
    $result=Run-Profile -Command list -Name ''
    Check 'partial auth restoration with both journals recovers successfully' ($result.Code -eq 0)
    $authMatches=$true
    foreach ($part in @('Local State','Network\Cookies','Local Storage\fixture.txt','Session Storage\fixture.txt','config.json','claude.json')) {
        $stored=Join-Path (Join-Path $fakeStore 'B') $part
        $live=if ($part -eq 'claude.json') { Join-Path $fakeHome '.claude.json' } else { Join-Path $fakeApp $part }
        if ((Get-FileHash -LiteralPath $stored).Hash -ne (Get-FileHash -LiteralPath $live).Hash) { $authMatches=$false }
    }
    Check 'partial auth recovery restores every authentication component consistently' $authMatches
    Check 'auth recovery precedes history recovery and retains latest target history' ((Read-Json $targetIndex).lastAssistantUuid -eq $newFrame -and $result.Log.IndexOf('Repair complete') -ge 0 -and $result.Log.IndexOf('Repair complete') -lt $result.Log.IndexOf('Recovered the interrupted session-history transfer'))
    Check 'completed combined recovery clears both journals' (-not (Test-Path -LiteralPath $authJournal) -and -not (Test-Path -LiteralPath $journal))

    Reset-Fixture
    $prepared=Engine prepare
    $null=Engine apply $prepared.transactionPath
    Journal $prepared.transactionPath
    Put $authJournal 'B'
    Put (Join-Path (Join-Path $fakeStore 'B') 'config.json') '{}'
    $originalTargetHash=(Get-FileHash -LiteralPath $targetIndex).Hash
    $result=Run-Profile -Command list -Name ''
    Check 'incomplete target profile blocks interrupted auth recovery' ($result.Code -ne 0 -and $result.Log.Contains('Cannot auto-repair'))
    Check 'incomplete target retains both recovery journals' ((Test-Path -LiteralPath $authJournal) -and (Test-Path -LiteralPath $journal) -and [IO.File]::ReadAllText($authJournal) -eq 'B')
    Check 'incomplete target does not change auth or roll history back prematurely' ((Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $sourceAccount -and (Get-FileHash -LiteralPath $targetIndex).Hash -eq $originalTargetHash)

    # Inject a marker-delete failure after all real authentication copies.
    # History recovery must remain available until auth recovery completes.
    Reset-Fixture
    $markerFailureScript=Join-Path $fixture 'profile-marker-failure.ps1'
    $markerDelete='Remove-Item -LiteralPath $SwitchMarker -Force -ErrorAction Stop'
    Check 'auth marker failure injection matches required cleanup' ($source.Contains($markerDelete))
    Put $markerFailureScript ($source.Replace($markerDelete, "throw 'Synthetic auth-marker deletion failure'"))
    $result=Run-Profile -Script $markerFailureScript
    Check 'auth marker deletion failure is reported and retains both journals' ($result.Code -ne 0 -and (Test-Path -LiteralPath $authJournal) -and (Test-Path -LiteralPath $journal))
    Check 'auth marker deletion failure preserves installed target auth and history' ((Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $targetAccount -and (Read-Json $targetIndex).lastAssistantUuid -eq $newFrame)
    $result=Run-Profile -Command list -Name ''
    Check 'later retry completes recovery after auth marker deletion failure' ($result.Code -eq 0 -and -not (Test-Path -LiteralPath $authJournal) -and -not (Test-Path -LiteralPath $journal))

    # Keep the real closed-app guard, but replace its process query with a
    # synthetic process that appears only after the target history is applied.
    # The test never reads, closes, or launches a real Claude process.
    Reset-Fixture
    $originalTargetHash=(Get-FileHash -LiteralPath $targetIndex).Hash
    $originalTranscriptHash=(Get-FileHash -LiteralPath $transcript).Hash
    $guard=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-ClaudeClosed'},$true)
    $guardSource=$guard.Extent.Text.Replace("Get-Process -Name 'claude' -ErrorAction SilentlyContinue", 'Get-FixtureClaudeProcess')
    $fakeProcess=@'
function Get-FixtureClaudeProcess {
    if ((Test-Path -LiteralPath $HistorySwitchMarker) -and
        ((Get-Content -LiteralPath '__TARGET_INDEX__' -Raw | ConvertFrom-Json).lastAssistantUuid -eq '__NEW_FRAME__')) {
        return [pscustomobject]@{ProcessName='synthetic-Claude'}
    }
    return $null
}
'@
    $fakeProcess=$fakeProcess.Replace('__TARGET_INDEX__',$targetIndex.Replace("'","''")).Replace('__NEW_FRAME__',$newFrame)
    $reopenedScript=Join-Path $fixture 'profile-reopened.ps1'
    Put $reopenedScript ($source.Replace('function Assert-ClaudeClosed { }', ($guardSource + "`r`n" + $fakeProcess)))
    $result=Run-Profile -Script $reopenedScript
    Check 'reopened Claude blocks auth replacement after history apply' ($result.Code -ne 0 -and $result.Log.Contains('Claude reopened during the switch') -and (Read-Json (Join-Path $fakeApp 'config.json')).lastKnownAccountUuid -eq $sourceAccount)
    Check 'reopened Claude leaves history recovery pending without an auth marker' ((Test-Path -LiteralPath $journal) -and -not (Test-Path -LiteralPath $authJournal))
    Check 'reopened Claude prevents unsafe live history rollback' ((Read-Json $targetIndex).lastAssistantUuid -eq $newFrame -and (Get-FileHash -LiteralPath $transcript).Hash -eq $originalTranscriptHash)
    $result=Run-Profile -Command list -Name ''
    Check 'closing Claude permits pending history rollback on the next run' ($result.Code -eq 0 -and (Get-FileHash -LiteralPath $targetIndex).Hash -eq $originalTargetHash -and -not (Test-Path -LiteralPath $journal))

    # A separate reader must not classify another process's staging directory
    # as abandoned until the writer releases this fixture-only named mutex.
    Reset-Fixture
    $staging=Join-Path $fakeStore '.staging-active'
    Put (Join-Path $staging 'sentinel.txt') 'synthetic writer still active'
    $startupBoundary="Enter-ProfileLock`ntry {`n    Repair-Saves"
    $normalized=$source.Replace("`r`n","`n")
    Check 'startup recovery remains protected by the profile mutex' ($normalized.Contains($startupBoundary))
    $entered=Join-Path $fakeHome 'startup-entered.txt'
    $readerScript=Join-Path $fixture 'profile-startup-lock.ps1'
    $startupSignal='[IO.File]::WriteAllText((Join-Path $env:USERPROFILE ''startup-entered.txt''), ''entered'')' + "`n"
    Put $readerScript ($normalized.Replace($startupBoundary, ($startupSignal + $startupBoundary)))
    $writerMutex=$null;$writerLocked=$false;$reader=$null
    try {
        $writerMutex=New-Object System.Threading.Mutex($false,$fixtureLockName)
        $writerLocked=$writerMutex.WaitOne(0)
        Check 'synthetic writer acquires the fixture mutex' $writerLocked
        $arguments='-NoProfile -ExecutionPolicy Bypass -File "' + $readerScript + '" list'
        $reader=Start-Process -FilePath $runner -WindowStyle Hidden -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $fixture 'reader.stdout.txt') -RedirectStandardError (Join-Path $fixture 'reader.stderr.txt')
        [void]$reader.Handle
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $entered) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
        Check 'concurrent reader reaches startup while the writer holds its mutex' (Test-Path -LiteralPath $entered)
        Start-Sleep -Milliseconds 300
        Check 'concurrent reader waits without deleting an active staging snapshot' (-not $reader.HasExited -and (Test-Path -LiteralPath (Join-Path $staging 'sentinel.txt')))
        $writerMutex.ReleaseMutex();$writerLocked=$false
        Check 'reader finishes after the writer releases its mutex' ($reader.WaitForExit(30000))
        $reader.Refresh()
        Check 'reader safely cleans orphan staging after lock release' ($reader.ExitCode -eq 0 -and -not (Test-Path -LiteralPath $staging))
    } finally {
        if ($writerLocked) { $writerMutex.ReleaseMutex() }
        if ($writerMutex) { $writerMutex.Dispose() }
        if ($reader -and -not $reader.HasExited -and -not $reader.WaitForExit(5000)) { $reader.Kill() }
        if ($reader) { $reader.Dispose() }
    }
    Write-Host 'All isolated profile/history integration checks passed.'
} finally {
    $env:USERPROFILE=$originalHome
    Write-Host "Synthetic fixture: $fixture"
}
