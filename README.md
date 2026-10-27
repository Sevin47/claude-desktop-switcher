# Claude Desktop Account Switcher (Windows)

Keep two saved Claude account profiles and switch between them without
re-authenticating. Each switch backs up and synchronizes the latest local Claude
Code history before changing accounts. Optional rate-limit failover uses the
same switching path.

Built for the **Claude desktop app on Windows**. If you use the Claude Code CLI
instead, use [claude-swap](https://github.com/realiti4/claude-swap) — it targets
the CLI and VS Code extension, does far more, and is cross-platform. This project
exists because the desktop app stores its auth differently and claude-swap
doesn't reach it.

---

## What it does

- **Switch saved accounts**, with a normal app shutdown and no re-login
- **Synchronize local Claude Code history** between accounts in the same organization
- **Back up history before switching**, retaining newer destination work
- **Watch for rate limits** and fail over automatically when one is exhausted
- **A GUI**, so none of this needs a terminal

## Requirements

- Windows 10 or 11
- Claude desktop app, **MSIX/Store build** (the one that installs to
  `Program Files\WindowsApps`). A standalone-installer build won't work — paths
  and relaunch differ.
- Windows PowerShell 5.1 (ships with Windows)
- Node.js **18 or newer**, with `node.exe` available on `PATH`
- Two Claude accounts, each with its own subscription
- For history sync, both accounts must already have a local session directory
  for the **same organization UUID**. Open that organization in each account first.

## Install

Keep these files in one folder, e.g. `Documents\claude-switcher`:

```
claude-switcher-gui.ps1     the GUI
claude-profile.ps1          account switching
claude-sessions.ps1         moving conversations
claude-autoswitch.ps1       rate-limit watcher
claude-history-sync.mjs     history validation, backups, sync and recovery
README.md
LICENSE
```

They must stay together — the GUI and profile switcher resolve their companion
files relative to themselves. No npm packages are required. You can verify the
Node.js requirement with `node --version`.

Then, in PowerShell:

```powershell
cd path\to\claude-switcher
powershell -ExecutionPolicy Bypass -STA -File .\claude-switcher-gui.ps1
```

Make a Desktop shortcut so you never type that again:

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Claude Account Switcher.lnk")
$lnk.TargetPath = (Get-Command powershell.exe).Source
$lnk.Arguments  = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$PWD\claude-switcher-gui.ps1`""
$lnk.WorkingDirectory = "$PWD"
$lnk.Save()
```

### Giving the shortcut the Claude icon (optional)

Generate an icon file **once** from the installed package, then point the
shortcut at that file:

```powershell
Add-Type -AssemblyName System.Drawing
$src = Join-Path (Get-AppxPackage -Name 'Claude').InstallLocation 'assets\Square150x150Logo.scale-200.png'
$img = [System.Drawing.Image]::FromFile($src); $out = "$PWD\claude-switcher.ico"
$pngs = @(); foreach ($s in 256,48,32,16) {
  $b = New-Object System.Drawing.Bitmap($s,$s); $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode='HighQualityBicubic'; $g.DrawImage($img,0,0,$s,$s); $g.Dispose()
  $ms = New-Object System.IO.MemoryStream; $b.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,@($s,$ms.ToArray()); $b.Dispose(); $ms.Dispose()
}
$img.Dispose(); $fs=[System.IO.File]::Create($out); $bw=New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0);$bw.Write([uint16]1);$bw.Write([uint16]$pngs.Count); $off=6+16*$pngs.Count
foreach($p in $pngs){ $d = if($p[0] -ge 256){0}else{$p[0]}
  $bw.Write([byte]$d);$bw.Write([byte]$d);$bw.Write([byte]0);$bw.Write([byte]0)
  $bw.Write([uint16]1);$bw.Write([uint16]32);$bw.Write([uint32]$p[1].Length);$bw.Write([uint32]$off);$off+=$p[1].Length }
foreach($p in $pngs){ $bw.Write($p[1]) }; $bw.Close(); $fs.Close()

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Claude Account Switcher.lnk")
$s.IconLocation = "$out,0"; $s.Save()
```

**Do not point `IconLocation` at `claude.exe` inside `Program Files\WindowsApps`.**
That path contains the app's version number, so the next Claude update deletes it
and the shortcut silently reverts to a blank white page icon. The generated
`.ico` lives beside the scripts and survives updates. It is gitignored — it's
Anthropic's artwork, so generate it locally rather than committing it.

## First run

1. Open the GUI while signed into your **first** account
2. **Accounts** tab → *Save current as…* → name it (e.g. `personal`)
3. *Set label…* → your email, so you can tell them apart
4. *Add account…* → follow the prompts: it opens Claude, you log out and sign in
   as the second account, then it saves that one too

After that, **double-click an account to switch to it**.

Before saving or switching, exit Claude normally so its latest session data is
flushed. The switcher can request a normal window close, but it never force-kills
Claude. If the app stays in the tray, a quit confirmation remains open, or Claude
workers are still running, the operation stops. Use Claude's **File → Exit** and
retry after it has fully exited. A failed close does not change accounts or
history.

Every successful account change synchronizes all local Claude Code session
entries from the outgoing account into matching organization folders. Existing
destination IDs are retained, newer destination history is kept, and new local
entries are added. Claude launches normally afterward; open the desired Code
conversation to continue. The switcher does not send task prompts or use a
session-resume deep link. Claude's own task recovery is separate from switching.

## Auto-switching (optional)

On the **Auto-switch** tab:

- **Dry run** — detect and log, never switch. *Leave this on until you've seen it
  fire correctly once.*
- **Also switch on 5-hour limits** — off by default; it spends the other
  account's weekly budget to skip a wait. When on, it only switches if the
  window resets more than **N minutes** away (default 30) — a limit that clears
  in ten minutes is cheaper to wait out.
- **Start watcher** / **Stop watcher** — run it now
- **Run on login** — install a Startup entry so it runs hidden at every login

When a limit is hit, the watcher:

1. records the account's cooldown from `resetsAt`
2. requests a normal Claude shutdown and stops if the app or its workers remain
   running
3. validates and backs up the history, synchronizes all local Code sessions into
   matching organization folders, then switches profiles
4. relaunches Claude normally, with the synchronized sessions available in Code
5. raises a Windows toast saying what happened and which account you're on now

The rejected request is not re-sent automatically. Open the conversation and
review where it stopped before continuing. If every account is limited, the
watcher stays put and toasts the earliest reset time.

`-CarryOverMinutes` is still accepted so existing shortcuts and GUI settings
continue to work, but it no longer limits history sync. All outgoing local Code
session entries are considered, regardless of age.

Everything it sees goes to `%USERPROFILE%\.claude-profiles\autoswitch.log`.

### Start it from the shortcut, not from inside Claude

Launch the watcher from the **GUI's Start button**, the **Desktop shortcut**, or the
**login entry** — never from a shell hosted inside the Claude app itself.

A switch requires Claude to exit normally. Anything launched *from* a session
inside Claude may end with that session, including the watcher or GUI. Starting
the switcher independently lets it finish the backup and account change after
Claude closes.

To check what owns a running watcher:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*claude-autoswitch*' } |
  Select-Object ProcessId, ParentProcessId, CreationDate
```

A healthy watcher's parent is `explorer` (Desktop/login shortcut) or the GUI —
not `claude`.

### Reading the log

| Line | Meaning |
|---|---|
| `Watching N transcript(s). Live account: <uuid>` | a watcher **started**. `N` should be > 0 — `Watching 0` means it started blind |
| `alive - watching N transcript(s), on <uuid>` | heartbeat, every 30 min. Also the easiest way to see an account change |
| `New transcript: <file>` | a session created after the watcher started |
| `<type> limit hit on <uuid>... - cooling down until <time>` | a genuine rejection was detected |
| `DRY RUN: would switch to ...` | detected but not acting (dry run) |
| `Switched to <account>. Open your conversation in Code ...` | failover completed; the switcher sent no continuation prompt |
| `history sync completed through the profile switch ...` | history validation, backup and sync completed |
| `resets in N min (< M) - waiting ...` | five-hour limit too short to be worth switching |
| `POSSIBLE FORMAT CHANGE ...` | a Claude API-error record no longer matches the known shape — run `selftest` |
| `watch-loop error (continuing): ...` | a transient error was survived, not fatal |
| `The switcher scripts changed on disk ...` | the running watcher is on stale code; restart it |

A gap in the heartbeats with no other line can mean the watcher ended with its
parent process. Check whether it is still running; handled errors are logged.

To confirm a switch actually landed, don't rely on the log alone:

```powershell
.\claude-profile.ps1 whoami          # live account + matching profile
.\claude-profile.ps1 doctor          # paths, and any pending repair
```

## Keeping usage windows warm (optional)

A 5-hour window opens on **first use**, so if you start work at 09:00 your window
runs 09:00–14:00. Anchoring it earlier — while you're away — puts the window
boundaries where you want them during the working day, and means a second
account is ready to take over rather than starting cold.

Warming sends one tiny prompt per account, headlessly, using the bundled Claude
Code CLI:

```powershell
.\claude-autoswitch.ps1 warm-login personal      # one-time, per profile
.\claude-autoswitch.ps1 warm-login work
.\claude-autoswitch.ps1 warm-status              # what it would do; spends nothing
.\claude-autoswitch.ps1 warm-now personal        # prime one account immediately
```

Then enable it on the watcher:

```powershell
.\claude-autoswitch.ps1 install-startup -IncludeFiveHour -WarmWindows
```

**It only fires when all of these hold:**

- you've been idle for `-WarmIdleMinutes` (default 20; `0` disables the gate)
- that account's window is actually **closed** — no activity for 5 hours, so
  warming achieves something rather than being a no-op
- the account isn't rate limited
- at least `-WarmStaggerMinutes` (default 150) since the last account was warmed,
  so the two windows don't open *and expire* together

Because the windows are staggered, when the first account runs dry mid-morning
the second still has hours left on its window.

### Why this doesn't touch your credentials

Each account gets its own CLI config directory under `%USERPROFILE%\.claude-cli\`
via `CLAUDE_CONFIG_DIR`. That means:

- **No credential is ever read, copied or moved by this tool.** Each account's
  CLI credentials are created by Claude Code's own login and stay put; nothing
  enters the profile store and the switch set is unchanged.
- **No account switching to warm.** The CLI acts as whichever account we point
  it at regardless of which account the desktop app is on, so warming never
  closes the app or interrupts what you're doing.
- **No keystroke or focus automation.** It's a headless process, so it works
  whether the desktop is idle, locked or asleep.
- Warm sessions live in the isolated config directory, so they don't clutter
  your real session list and the watcher can't mistake them for activity.

Note the weekly windows are per-model (`seven_day_opus`, `seven_day_sonnet`), so
`-WarmModel` with a cheaper model may not anchor the window you actually care
about. Left unset it uses the CLI default.

## How it works

Your login lives in six places. After history validation and synchronization,
switching accounts swaps all six and relaunches the app:

| Path | Holds |
|---|---|
| `<AppRoot>\config.json` | `oauth:tokenCacheV2`, `lastKnownAccountUuid` |
| `<AppRoot>\Local State` | DPAPI-wrapped AES key for the cookies |
| `<AppRoot>\Network\` | cookie database |
| `<AppRoot>\Local Storage\` | web session state |
| `<AppRoot>\Session Storage\` | web session state |
| `%USERPROFILE%\.claude.json` | Claude Code CLI config |

Profiles are saved under `%USERPROFILE%\.claude-profiles\<name>\`.

`<AppRoot>` is detected from the current Store app data location. The resolver
prefers `%LOCALAPPDATA%\Claude-Data\<package-family>`, then checks
`%APPDATA%\Claude` and the legacy
`%LOCALAPPDATA%\Packages\<package-family>\LocalCache\Roaming\Claude` location.
Claude updates can migrate data between these paths.

**Conversation transcripts are already shared between accounts.** They live in
`%USERPROFILE%\.claude\projects\<project>\<cliSessionId>.jsonl`, which is not
account-scoped. The *session index* under
`<AppRoot>\claude-code-sessions\<accountUuid>\<orgUuid>\` is per-account.
The history engine updates these index entries while preserving their transcript,
compaction, rewind and model-history links. It does not rewrite or delete the
shared transcripts. Existing aliases keep their destination local ID, with
structural child-session references remapped to it.

Before updating any destination index, the engine validates the histories and
backs up both account index trees, the referenced shared transcripts and their
supporting session files. Backups are stored under:

```
%USERPROFILE%\.claude-profiles\.history-backups\
  transactions\<timestamp-and-id>\transaction.json
  blobs\sha256\<prefix>\<content-hash>
```

Each transaction records its original files, checksums, staged updates and
recovery state. Content-addressed blobs are shared between transactions, so
unchanged files are stored once. Checksums are verified before changes are
applied. Backups remain available after a successful switch and accumulate as
history changes; they are separate from the six-file account profile snapshot.

The engine refreshes an existing destination only when the source contains its
history. If the destination is newer, it is kept. Divergent branches, ambiguous
aliases, missing transcripts or matching organizations, deletion conflicts, and
distinct pending notes stop the switch for review. Source indices remain
unchanged. History sync covers **local desktop Claude Code sessions in matching
organization UUIDs**; it does not synchronize web chats, Cowork history, or remote
cloud session history.

**Rate-limit detection is reactive.** Claude Code writes a `quotaLimits` record
into the session transcript when a request is refused:

```json
{"status":"rejected","resetsAt":1788223800,"rateLimitType":"seven_day"}
```

The watcher responds to these rejection records rather than predicting remaining
quota. It does not re-send the rejected request after switching.

## Robustness

Switching mutates a live credential store the app doesn't know is being touched,
so the tool guards the failure modes that come with that:

- **One switch at a time.** A cross-process lock stops the watcher and a manual
  switch from mutating the same files at once (which could corrupt the store).
- **Normal shutdown only.** The switcher waits for Claude and its file handles
  to close. A tray-resident app or remaining worker stops the operation; there is
  no force-kill fallback.
- **Verified history backups.** Source and destination indices, referenced
  transcripts and supporting files are checksummed before destination changes.
  Changed files or conflicting histories stop the switch before account restore.
- **Crash recovery.** Account restores retain a recovery marker; history updates
  retain a transaction journal and verified originals. On a subsequent run with
  Claude closed, the tool completes or rolls back the interrupted history update
  according to the active account. Recovery refuses to overwrite newer changes.
- **Integrity checks.** A profile is only "ok" if its `config.json` parses with
  an account UUID and its cookie DB is non-empty — not merely that files exist.
- **Format-drift tripwire.** If a rate-limit line appears that the watcher
  doesn't recognise (e.g. after an app update changes the record), it warns and
  toasts instead of going silently blind. `selftest` proves the detector still
  works on demand.
- **Dead-session check.** After a switch it confirms the app stayed on the new
  account; if a saved session has expired it says so rather than looping.
- **Normal relaunch.** Every transcript size uses the same normal app launch.
  The switcher does not invoke a resume deep link or submit a continuation prompt.
- **Heartbeat.** The watcher logs an "alive" line periodically, so a hung one is
  visible in the log rather than looking healthy.

None of this removes the underlying fragility below — it makes the failures
loud and recoverable instead of silent.

## Limitations

- **Windows only.** Cookie encryption is DPAPI-bound.
- **Profiles are not portable.** They only decrypt for the same Windows user on
  the same machine, so they can't be exported, synced, or backed up elsewhere.
- **MSIX builds only.**
- **One account at a time.** The desktop app has no multi-account support —
  `lastKnownAccountUuid` is singular. This swaps the whole session; it doesn't
  run two at once.
- **Switching requires the app to close.** Backup and validation time depends on
  the amount of history and disk speed. Running tasks may be interrupted by a
  normal exit; the switcher does not resume or rerun them itself.
- **Matching local organizations only.** A missing destination organization or
  incompatible history stops switching. No web or remote cloud conversations are
  transferred.
- **The app's own account menu switches only the Chat/Cowork session**, not
  Claude Code. They authenticate separately. Use a full Log out to move both.
- Detection matches a private, undocumented record shape and could break with an
  app update. The format-drift tripwire makes that loud rather than silent, but
  it can only warn *after* an unrecognised limit line appears — run `selftest`
  after any Claude update to confirm the detector still works.
- **A saved session can still go stale.** If you sign into an account directly in
  the app (not through this tool) it rotates that account's token, leaving the
  saved profile's token dead until you re-save. Refresh tokens also expire with
  age. The dead-session check catches this after a switch, but the fix is to
  re-save the profile while signed into it.

## A note on rate limits

Automated failover to a second account when the first is exhausted is plausibly
the kind of thing Anthropic's policy language about circumventing rate limits is
aimed at. Two accounts you pay for, each used within its own limits, isn't
fraud — but the automation is the part that reads as evasion rather than "I have
a work account and a personal one."

Manual switching is far less ambiguous. Auto-switching is opt-in and ships in dry
run for that reason. Your call.

## Commands

The GUI covers everything, but each script runs standalone:

```powershell
.\claude-profile.ps1 list|whoami|doctor
.\claude-profile.ps1 switch <name>
.\claude-profile.ps1 save <name>
.\claude-profile.ps1 label <name> <text>
.\claude-profile.ps1 rename <old> <new>
.\claude-profile.ps1 delete <name>

.\claude-sessions.ps1 accounts
.\claude-sessions.ps1 list <account>
.\claude-sessions.ps1 copy <sessionId> <account>

.\claude-autoswitch.ps1 status|test|selftest|reset
.\claude-autoswitch.ps1 warm-status|warm-login <profile>|warm-now <profile>
.\claude-autoswitch.ps1 run [-DryRun] [-IncludeFiveHour] [-MinFiveHourWaitMinutes N] [-CarryOverMinutes N]
.\claude-autoswitch.ps1 stop
.\claude-autoswitch.ps1 install-startup [-DryRun] [-IncludeFiveHour] [-MinFiveHourWaitMinutes N] [-CarryOverMinutes N]
.\claude-autoswitch.ps1 uninstall-startup
```

`doctor` prints resolved paths and whether each source file is readable — start
there if something doesn't work.

`claude-sessions.ps1 copy` remains a manual command for a selected index entry.
The full validation, backup and latest-history synchronization described above
run through `claude-profile.ps1 switch`, including switches initiated by the GUI
or watcher. Use `switch <name> -NoLaunch` to leave Claude closed afterward.

## Tests

From a repository checkout that includes the `tests` directory, run the three
synthetic suites:

```powershell
node --test .\tests\history-sync.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\profile-history.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\autoswitch-history.test.ps1
```

These use temporary fixtures and mocked lifecycle calls. They do not stop Claude,
switch real accounts, or modify live sessions. They cover history ancestry and
aliases, backups and recovery, profile integration, and watcher delegation.

## Credits

Inspired by [claude-swap](https://github.com/realiti4/claude-swap), which does
this properly for the CLI.
