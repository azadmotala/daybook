#Requires -Version 5
<#
.SYNOPSIS
    Publish Daybook over SSH. Publishes immediately.

.DESCRIPTION
    Every release goes to a versioned folder and is then copied into place, so the URL she installs
    never changes and any earlier release can be put back with one command.

        <RemoteBase>/            <- live. This is what she adds to her home screen.
        <RemoteBase>/v/<stamp>/  <- every release ever pushed, for rollback.

    WHAT SHIPS IS DERIVED, NOT LISTED HERE. The file set is read out of PRECACHE in sw.js, which is
    already the tested definition of "everything the app needs with no network" and is guarded
    against the filesystem by test/precache.test.js. A hand-written second list would drift from it,
    and the failure would be a file missing offline, which is the one place offline was promised.

    Nothing else in this repo is deployable. tools/ and test/ are the workspace, and the specification is a
    design document, not something to publish under her name. A public URL is a different risk class
    from a local folder, so this uses an allowlist and refuses anything outside it.

    Her diary is unaffected. The app is static files; everything she writes stays in localStorage on
    her device. Serving it from a real HTTPS origin is what makes Add to Home Screen possible at
    all, which is what stops her notes being cleared.

.PARAMETER Preflight
    Read-only. Checks the target is what we think it is and writes nothing to
    the live site. Run this before the first deploy, and after changing any of
    the three constants below.

.PARAMETER List
    Show the releases already on the server and which one is live. Uploads nothing.

.PARAMETER Rollback
    Copy an existing v/<stamp>/ back into place. Uploads nothing.

.PARAMETER SkipTests
    Skip the node suite. Only for re-pushing a release that was already green.

.PARAMETER Force
    Skip the confirmation prompt.

.PARAMETER Pages
    Publish the same staged set to the public repository's gh-pages branch instead. Needs no target
    file and never touches the private host.

.PARAMETER Mirror
    Rebuild the public repository as one commit cut from HEAD, without .claude/, and verify it from a
    fresh clone. Never touches the private host, but reads its target to prove none of it is
    published.

.PARAMETER MirrorRemote
    Push the mirror somewhere else, such as a local bare repository, to rehearse it. Defaults to the
    public repository.

.EXAMPLE
    .\tools\release.ps1
.EXAMPLE
    .\tools\release.ps1 -List
.EXAMPLE
    .\tools\release.ps1 -Rollback 2026-08-08-962e964a7eed
.EXAMPLE
    .\tools\release.ps1 -Mirror
#>
param(
    [switch]$Preflight,
    [switch]$List,
    [string]$Rollback,
    [switch]$SkipTests,
    [switch]$Force,
    [switch]$Pages,
    [switch]$Mirror,
    [string]$MirrorRemote
)

$ErrorActionPreference = 'Stop'

$Root       = Split-Path $PSScriptRoot -Parent

# The deploy target lives in tools/release.local.ps1, which is git-ignored and
# never leaves this machine. It must define $SshHost, $RemoteBase and $SiteUrl.
# This repo has a public mirror; the target is a third party's server and is
# not the public mirror's business. The script refuses to run without the file
# rather than falling back to a default, because a default is a target.
# -Pages pushes to the public mirror over git and never touches the private host, so it does not
# need the target file. Everything else does.
$Local = Join-Path $PSScriptRoot 'release.local.ps1'
if (-not $Pages) {
if (-not (Test-Path $Local)) {
    Write-Host "tools/release.local.ps1 is missing. It holds the deploy target and is not committed." -ForegroundColor Red
    Write-Host "Create it from tools/release.local.example.ps1 and fill in the three values." -ForegroundColor Red
    exit 1
}
. $Local
foreach ($name in 'SshHost', 'RemoteBase', 'SiteUrl') {
    if (-not (Get-Variable -Name $name -ErrorAction SilentlyContinue) -or -not (Get-Variable -Name $name -ValueOnly)) {
        Write-Host "tools/release.local.ps1 does not set `$$name." -ForegroundColor Red
        exit 1
    }
}
}

# The live folder holds exactly these entries. Enumerated rather than globbed so the swap can clear
# the old release without ever touching v/, which is the only copy of anything older.
$LiveEntries = @('index.html', 'sw.js', 'manifest.webmanifest', '.htaccess', 'styles.css', 'js', 'fonts', 'icons')

function Fail([string]$message) { Write-Host $message -ForegroundColor Red; exit 1 }
function Ok([string]$m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  warn  $m" -ForegroundColor Yellow }

if ($Mirror -and ($Pages -or $Preflight -or $List -or $Rollback)) { Fail '-Mirror runs on its own.' }

# Windows' own tar, by full path. A bare `tar` is whichever comes first on PATH, and Git's GNU tar reads
# C:\... as a remote host and fails. Found by rehearsing -Mirror from a shell that put Git's tools
# first; the deploy's archive step had the same dependency and had only ever met this machine's
# PowerShell, where Windows' tar is the only one.
#
# $TarExe, never $Tar: PowerShell variable names ignore case. This was $Tar for one rehearsal, and
# -Mirror's `$tar = <the archive>` overwrote it, so the extract step "ran" the archive, Windows opened
# it with its file association, reported success, and the export stayed empty.
$TarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $TarExe)) { Fail "Windows' tar is not at $TarExe." }

<#
    IS THE TARGET OURS?

    $RemoteBase is deleted from and written to. If it ever points at a live
    document root instead of a folder of ours, this script removes someone's
    website. Two things make that impossible rather than unlikely:

      1. $RemoteBase must be at least two segments deep, so a typo that leaves
         it as 'public_html' is refused before any SSH runs.
      2. The folder must be either empty or contain ONLY entries this script
         put there. Anything unrecognised means we are pointing somewhere else,
         and the run stops without writing.

    Both are checked on every deploy, not only under -Preflight, because a
    guard you have to remember to run is not a guard.
#>
function Assert-TargetIsOurs {
    $segments = $RemoteBase.Trim('/').Split('/') | Where-Object { $_ -ne '' }
    if ($segments.Count -lt 2) {
        Fail "RemoteBase '$RemoteBase' is a document root, not a folder of ours. Refusing: this script deletes from it."
    }

    $listing = ssh $SshHost "test -d '$RemoteBase' && ls -A1 '$RemoteBase' 2>/dev/null || echo '__MISSING__'"
    if (-not $?) { Fail "Could not reach $SshHost over SSH." }

    $entries = @($listing -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

    if ($entries -contains '__MISSING__') {
        Warn "$RemoteBase does not exist yet. It will be created on first deploy."
        return @{ Exists = $false; Foreign = @() }
    }

    $known   = @($LiveEntries) + @('v', '.release')
    $foreign = @($entries | Where-Object { $known -notcontains $_ })

    if ($foreign.Count -gt 0) {
        Write-Host ''
        Write-Host "  $RemoteBase contains files this script did not put there:" -ForegroundColor Red
        $foreign | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
        Write-Host ''
        Fail 'Refusing to touch it. Either RemoteBase is wrong, or something else lives there.'
    }

    Ok "$RemoteBase holds only Daybook's own files ($($entries.Count) entries)"
    return @{ Exists = $true; Foreign = @() }
}

<#
    THE SUITE GATE

    The exit code alone is not the claim. `node --test` exits 0 when the glob matches NOTHING, so a
    suite that never ran is indistinguishable from a green one, and that is how a gate deploys over
    zero tests and reports success.

    So the count is asserted rather than a threshold. "More than zero tests ran" is the invariant the
    gate depends on; a floor like 50 would describe today's suite rather than the claim.

    It takes a folder because -Mirror runs it away from the working tree, twice: on the export before
    pushing and on a fresh clone after. The suite that counts is the one in the files that ship.

    The TAP reporter, because its summary is plain ASCII. The default reporter prefixes each count
    with an info glyph, and a console that does not decode UTF-8 turns that one character into
    several, so the count could not be read at all. Found by the -Mirror rehearsal; the deploy had
    only ever run from a console where it happened to decode.
#>
function Invoke-Suite([string]$dir, [string]$doing, [string]$hint = '') {
    Push-Location $dir
    $output = node --test --test-reporter=tap "test/*.test.js" 2>&1 | Out-String
    $exit = $LASTEXITCODE
    Pop-Location

    if ($output -notmatch '(?m)^# tests (\d+)')  { Fail "Could not read the test count. Not $doing." }
    $ran = [int]$Matches[1]
    if ($output -notmatch '(?m)^# fail (\d+)')   { Fail "Could not read the failure count. Not $doing." }
    $failed = [int]$Matches[1]

    if ($ran -eq 0)     { Fail "The suite ran ZERO tests - the glob matched nothing. Not $doing." }
    if ($failed -gt 0)  { Fail "$failed test(s) failing. Not $doing.$hint" }
    if ($exit -ne 0)    { Fail "Test runner exited non-zero. Not $doing." }
    return $ran
}

<#
    WHAT MUST NEVER REACH THE PUBLIC REPOSITORY

    The private host's target, the specification, the workspace, and her exports. Every file is read,
    binaries included, and the three target values are matched ignoring case. A hit is reported by
    file name only, never by the value that matched: a refusal's output can end up anywhere a
    terminal's can.
#>
function Find-Private([string]$dir) {
    $needles = @($SshHost, $RemoteBase, ([Uri]$SiteUrl).Host) | Where-Object { $_ }
    if ($needles.Count -ne 3) { Fail 'Could not read all three target values, so there is nothing to check for. Refusing.' }

    $base = (Get-Item -LiteralPath $dir).FullName.TrimEnd('\')
    $hits = @()
    $scanned = 0
    if (Test-Path (Join-Path $base '.claude')) { $hits += '.claude/  (the workspace)' }
    foreach ($f in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
        $rel = $f.FullName.Substring($base.Length + 1) -replace '\\', '/'
        if ($rel -like '.git/*') { continue }
        $scanned++
        if ($f.Name -match '^spec\.|^release\.local\.ps1$|^daybook-backup-.*\.json$|\.csv$') {
            $hits += "$rel  (by its name)"; continue
        }
        $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($f.FullName))
        if (@($needles | Where-Object { $text.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count) {
            $hits += "$rel  (names the private host)"; continue
        }
        if ($text -cmatch '\bSPEC\b') { $hits += "$rel  (names the specification)" }
    }
    # It reported an empty export clean once. A check over nothing is not a check.
    if ($scanned -eq 0) { Fail "Found no files to check in $dir. Refusing." }
    return ,$hits
}

if ($Preflight) {
    Write-Host "Preflight - nothing is written to the live site." -ForegroundColor Cyan
    Write-Host ''
    Write-Host "  host   : $SshHost"
    Write-Host "  path   : $RemoteBase"
    Write-Host "  url    : $SiteUrl"
    Write-Host ''

    $whoami = (ssh $SshHost 'whoami; pwd' 2>&1) -join ' / '
    if (-not $?) { Fail "Could not reach $SshHost over SSH." }
    Ok "SSH works - $whoami"

    # What else is on this account? The neighbours are the production sites we
    # must not disturb, so they are shown rather than assumed.
    $parent = Split-Path $RemoteBase -Parent
    if (-not $parent) { $parent = '.' }
    Write-Host ''
    Write-Host "  Siblings in $parent (these are other live sites - do not touch):" -ForegroundColor Cyan
    ssh $SshHost "ls -A1 '$parent' 2>/dev/null | sed 's/^/      /'"
    Write-Host ''

    $state = Assert-TargetIsOurs

    # Does the URL actually serve that folder? The only honest way to know is to
    # put a marker in OUR folder and fetch it. Runs only after the check above
    # has established the folder is ours or absent, so nothing else can be hit.
    $token = [guid]::NewGuid().ToString('N').Substring(0, 12)
    # A .txt, not a dotfile: many Apache configs deny anything starting with a
    # dot, which would fail the probe for a reason that has nothing to do with
    # the mapping. Removed again a few lines below either way.
    $probe = "_preflight-$token.txt"
    ssh $SshHost "mkdir -p '$RemoteBase' && printf '%s' '$token' > '$RemoteBase/$probe'" | Out-Null
    if (-not $?) { Fail 'Could not write the probe file.' }

    $served = $null
    $transportError = $null
    try {
        $raw = (Invoke-WebRequest -Uri "$SiteUrl$probe" -UseBasicParsing -TimeoutSec 20).Content
        # Windows PowerShell hands back a byte[] when the response has no text
        # content type, and .txt is not always mapped on shared hosting. Calling
        # .Trim() on that throws, and the catch below then reports a mapping
        # failure that never happened.
        $served = if ($raw -is [byte[]]) { [Text.Encoding]::UTF8.GetString($raw).Trim() } else { "$raw".Trim() }
    } catch {
        $transportError = $_.Exception.Message
    }

    ssh $SshHost "rm -f '$RemoteBase/$probe'" | Out-Null

    Write-Host ''
    if ($served -eq $token) {
        Ok "$SiteUrl serves $RemoteBase - the URL and the path agree"
    } elseif ($transportError) {
        Write-Host "  COULD NOT CHECK THE MAPPING" -ForegroundColor Yellow
        Write-Host "      $transportError" -ForegroundColor Yellow
        Write-Host ''
        Write-Host "  The probe was written and removed, but the URL could not be fetched." -ForegroundColor Yellow
        Write-Host "  That is a network or server response problem, not proof of a mismatch." -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host "  MISMATCH" -ForegroundColor Red
        Write-Host "      wrote token : $token" -ForegroundColor Red
        Write-Host "      URL returned: $served" -ForegroundColor Red
        Write-Host ''
        Write-Host "  $SiteUrl does not serve $RemoteBase, so a deploy would publish" -ForegroundColor Red
        Write-Host "  to the wrong place. Find the document root for that domain and" -ForegroundColor Red
        Write-Host "  point RemoteBase at a folder inside it." -ForegroundColor Red
        exit 1
    }

    Write-Host ''
    Write-Host '  On deploy, these paths would be removed and replaced:' -ForegroundColor DarkGray
    $LiveEntries | ForEach-Object { Write-Host "      $RemoteBase/$_" -ForegroundColor DarkGray }
    Write-Host "  v/ and .release are never touched by the swap." -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Preflight passed. Nothing was changed.' -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------------------------
# -List / -Rollback: neither reads the working tree, so both run before any of the build work.
# ---------------------------------------------------------------------------------------------

if ($List) {
    Write-Host "Releases on $SshHost`:" -ForegroundColor Cyan
    ssh $SshHost "ls -1 $RemoteBase/v 2>/dev/null || echo '  (none yet)'"
    Write-Host "`nLive now:" -ForegroundColor Cyan
    ssh $SshHost "cat $RemoteBase/.release 2>/dev/null || echo '  (unknown - no .release marker)'"
    return
}

if ($Rollback) {
    $exists = (ssh $SshHost "test -d $RemoteBase/v/$Rollback; echo `$?").Trim()
    if ($exists -ne '0') { Fail "No release '$Rollback' on the server. Run -List to see what is there." }

    if (-not $Force) {
        Write-Host "This puts release '$Rollback' LIVE at $SiteUrl immediately." -ForegroundColor Yellow
        if ((Read-Host "Type 'yes' to continue") -ne 'yes') { Write-Host 'Aborted.'; return }
    }

    Assert-TargetIsOurs | Out-Null

    $clear = ($LiveEntries | ForEach-Object { "rm -rf '$RemoteBase/$_'" }) -join '; '
    ssh $SshHost "set -e; mkdir -p $RemoteBase; $clear; cp -a $RemoteBase/v/$Rollback/. $RemoteBase/; echo $Rollback > $RemoteBase/.release"
    Write-Host "Rolled back to $Rollback." -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------------------------
# -Mirror: the public repository
# ---------------------------------------------------------------------------------------------
<#
    The public repository is one commit: the app and its tests, nothing of the workspace. It is never
    a filtered history, because every private commit before 2026-10-03 carries the deploy target, so
    it is cut fresh from HEAD each time and force-pushed. Its history is disposable by design; the
    private repository's is never rewritten.

    It reads HEAD, not the working tree, so like -List and -Rollback it runs before any build work.
    It also ships a different set from a release (the whole repository minus .claude/, not the
    PRECACHE set), so the release forbid-list does not describe it and it carries its own check.

    It needs release.local.ps1 although it never touches the private host: the check cannot look for
    values it does not know, and "I could not check" is not "clean".
#>
if ($Mirror) {
    $MirrorRepo = if ($MirrorRemote) { $MirrorRemote } else { 'https://github.com/azadmotala/daybook.git' }

    # HEAD is what ships. An uncommitted change would not, which is a surprise worth stopping for here
    # rather than finding in the public repository.
    $dirty = @(git -C $Root status --porcelain --untracked-files=no)
    if ($dirty.Count -gt 0) { Fail "Uncommitted changes to tracked files. -Mirror publishes HEAD, so commit first:`n  $($dirty -join "`n  ")" }
    $head = "$(git -C $Root rev-parse --short HEAD)".Trim()

    $work = Join-Path ([IO.Path]::GetTempPath()) "daybook-mirror-$head"
    if (Test-Path $work) { Remove-Item $work -Recurse -Force }
    $export = Join-Path $work 'export'
    New-Item -ItemType Directory -Path $export -Force | Out-Null

    # Through a file, not a pipe: Windows PowerShell hands native output down a pipeline as text,
    # which corrupts a tar stream.
    $archive = Join-Path $work 'head.tar'
    git -C $Root archive --format=tar -o $archive HEAD
    if (-not $?) { Fail 'git archive failed.' }
    & $TarExe -xf $archive -C $export
    if (-not $?) { Fail 'Could not unpack the archive.' }
    Remove-Item $archive -Force
    $workspace = Join-Path $export '.claude'
    if (Test-Path $workspace) { Remove-Item $workspace -Recurse -Force }

    # An exit code says the unpack ran, not that it produced anything. Count what arrived against
    # what HEAD holds, before any check runs over it: every check below passes on an empty folder.
    $expected = @(git -C $Root ls-tree -r --name-only HEAD | Where-Object { $_ -notlike '.claude/*' }).Count
    $have     = @(Get-ChildItem -LiteralPath $export -Recurse -File -Force).Count
    if ($have -ne $expected) { Fail "The export holds $have files; HEAD minus .claude/ holds $expected. Refusing." }

    $found = Find-Private $export
    if ($found.Count -gt 0) {
        Write-Host '  The export holds what must never be public:' -ForegroundColor Red
        $found | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
        Remove-Item $work -Recurse -Force
        Fail 'Refusing to publish. Nothing was pushed.'
    }
    Ok 'nothing in the export names the private host, the specification or the workspace'

    Write-Host 'Running the node suite on the export...' -ForegroundColor DarkGray
    $ran = Invoke-Suite $export 'mirroring'
    Ok "the export is green on its own ($ran tests)"

    $message = @'
Daybook: a private, offline blood sugar diary

A diary for one person to note blood sugar, sleep, movement, food and stress
each day, so that they and their doctor can see what tends to go together.
It records what was written down and reflects it back. It never says what a
reading means; a doctor does that.

Eight constraints govern the code and are not waivable:

  B1  Readings are canonical mmol/L; mg/dL exists only at the render boundary.
  B2  Derived values are computed, never stored.
  B3  Local-only. No telemetry, no analytics, no asset from another origin.
  B4  The notes are irreplaceable. Every write is verified by reading it back.
  B5  A day is the user's local civil date.
  B6  Export always works, offline, round-tripping losslessly.
  B7  The app never interprets a reading.
  B8  Nothing is shown that the data cannot support.

An installable web app, mobile-first, no framework, no build step, zero
dependencies runtime and dev. Served from GitHub Pages and from a second host
whose target is not part of this repository.

Public mirror of a private repository, which holds the build history and the
second host's target. This one holds the app and its tests.

Tests: {TESTS} under node --test, and more in a browser at test/browser/.
'@
    $msgFile = Join-Path $work 'message.txt'
    [IO.File]::WriteAllText($msgFile, $message.Replace('{TESTS}', "$ran"), (New-Object Text.UTF8Encoding($false)))

    Push-Location $export
    git init -q -b main
    git add -A
    git commit -q -F $msgFile
    $committed = $?
    Pop-Location
    if (-not $committed) { Fail 'Could not commit the export.' }

    # The commit must be HEAD minus .claude/, byte for byte: the same paths, modes and blobs. That also
    # proves the suite left nothing behind in the files it was testing.
    $want = @(git -C $Root ls-tree -r HEAD | Where-Object { $_ -notmatch "`t\.claude/" })
    $got  = @(git -C $export ls-tree -r HEAD)
    if (($want -join "`n") -ne ($got -join "`n")) { Fail 'The commit is not HEAD minus .claude/. Refusing to publish.' }
    $tree = "$(git -C $export rev-parse 'HEAD^{tree}')".Trim()
    Ok "the commit is HEAD minus .claude/: $($got.Count) files, tree $($tree.Substring(0, 12))"

    Write-Host ''
    Write-Host "Mirror  : private $head  ->  one commit, $($got.Count) files, $ran tests"
    Write-Host "Target  : $MirrorRepo  (main, force-pushed)"
    Write-Host ''
    Write-Host 'This REPLACES the public repository with this one commit, immediately.' -ForegroundColor Yellow
    if (-not $Force) {
        if ((Read-Host "Type 'yes' to publish") -ne 'yes') {
            Write-Host 'Aborted.'; Remove-Item $work -Recurse -Force; return
        }
    }

    git -C $export push -q --force $MirrorRepo HEAD:main
    if (-not $?) { Fail 'The push reported an error. Clone the public repository to see what it now holds.' }

    # The push reporting success is a claim about git. The artifact is what a stranger gets from the
    # public URL, so that is what gets checked.
    $clone = Join-Path $work 'clone'
    git clone -q --branch main $MirrorRepo $clone
    if (-not $?) { Fail "Pushed, but could not clone $MirrorRepo to check it. It is unverified; check it by hand." }
    $commits   = "$(git -C $clone rev-list --count HEAD)".Trim()
    $cloneTree = "$(git -C $clone rev-parse 'HEAD^{tree}')".Trim()
    if ($commits -ne '1')     { Fail "VERIFY FAILED: the public main holds $commits commits, not one." }
    if ($cloneTree -ne $tree) { Fail "VERIFY FAILED: the public tree is $cloneTree, not the $tree that was built." }
    Ok 'a fresh clone holds one commit, with exactly the tree that was built'

    $found = Find-Private $clone
    if ($found.Count -gt 0) {
        Write-Host '  The PUBLIC repository holds what must never be public:' -ForegroundColor Red
        $found | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
        Fail 'VERIFY FAILED. It is public now: fix HEAD and run -Mirror again, which replaces it.'
    }
    Ok 'nothing in the fresh clone names the private host, the specification or the workspace'

    Write-Host 'Running the node suite on the fresh clone...' -ForegroundColor DarkGray
    $ranClone = Invoke-Suite $clone 'trusting the mirror'
    Ok "the fresh clone is green ($ranClone tests)"

    Remove-Item $work -Recurse -Force
    Write-Host ''
    Write-Host "Mirrored: $MirrorRepo  (private $head, verified from a fresh clone)" -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------------------------
# Build the shipping set
# ---------------------------------------------------------------------------------------------

# The stamp must be current or the file list below describes a different build, and the browser
# would never install the new worker. stamp-sw.mjs is idempotent, so this is a no-op when nothing
# changed.
Write-Host 'Stamping service worker...' -ForegroundColor DarkGray
node (Join-Path $Root 'tools\stamp-sw.mjs')
if (-not $?) { Fail 'stamp-sw.mjs failed.' }

if (-not $SkipTests) {
    Write-Host 'Running the node suite...' -ForegroundColor DarkGray
    $ran = Invoke-Suite $Root 'deploying' ' (-SkipTests to override, deliberately.)'
    Write-Host "  green ($ran tests)" -ForegroundColor Green
}

$swPath = Join-Path $Root 'sw.js'
$sw     = [IO.File]::ReadAllText($swPath, [Text.Encoding]::UTF8)

# The release name is the worker's cache stamp, which stamp-sw.mjs derives from a fingerprint of
# everything in PRECACHE. Identical content therefore produces an identical release name: the
# version is derived rather than remembered, the same reason the cache name is.
if ($sw -notmatch "var CACHE = 'daybook-([0-9a-f]+)'") { Fail 'Could not read the cache stamp from sw.js.' }
$stamp = '{0}-{1}' -f (Get-Date -Format 'yyyy-MM-dd'), $Matches[1]

if ($sw -notmatch '(?s)var PRECACHE = \[(.*?)\n\];') { Fail 'Could not find PRECACHE in sw.js.' }
$files = [regex]::Matches($Matches[1], "'([^']+)'") |
    ForEach-Object { $_.Groups[1].Value -replace '^\./', '' } |
    Where-Object { $_ -ne '' } |
    Select-Object -Unique
# sw.js itself is never in its own precache list, and the licence rides along with the fonts.
$files = @($files) + 'sw.js' + 'fonts/OFL.txt' | Select-Object -Unique

if ($files.Count -lt 15) { Fail "PRECACHE parsed to only $($files.Count) entries - the parse is wrong." }

# Belt and braces. PRECACHE should never name any of these, and if it ever does the mistake must
# stop here rather than on a public URL.
$forbidden = $files | Where-Object { $_ -match '^(test/|tools/|\.claude/)|\.md$' }
if ($forbidden) { Fail "Refusing to publish: $($forbidden -join ', ')" }

$missing = $files | Where-Object { -not (Test-Path (Join-Path $Root $_)) }
if ($missing) { Fail "Missing locally: $($missing -join ', ')" }

# ---------------------------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------------------------

$staging = Join-Path ([IO.Path]::GetTempPath()) "daybook-release-$stamp"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

foreach ($f in $files) {
    $dst = Join-Path $staging $f
    $dstDir = Split-Path $dst -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Copy-Item (Join-Path $Root $f) $dst
}

# ---------------------------------------------------------------------------------------------
# GitHub Pages: the second host
# ---------------------------------------------------------------------------------------------
# The same staged set the private host gets, pushed as one commit to gh-pages on the public mirror.
# Pages serves that branch root, so the live site is exactly these files and nothing else: no specification,
# no tests, no tools, the rule the forbid-list enforces above. It sits after staging on purpose, so
# it inherits the stamp, the suite, the forbid-list and the missing-file check without restating
# them. The public repo's URL is public, so it is a constant here. The private host's never is.
if ($Pages) {
    $PagesRepo = 'https://github.com/azadmotala/daybook.git'
    $PagesUrl  = 'https://azadmotala.github.io/daybook/'

    # Pages runs Jekyll unless told not to, and Jekyll quietly drops files it does not understand.
    [IO.File]::WriteAllText((Join-Path $staging '.nojekyll'), '', (New-Object Text.UTF8Encoding($false)))

    Write-Host ""
    Write-Host "Release : $stamp"
    Write-Host "Files   : $($files.Count) + .nojekyll"
    Write-Host "Target  : $PagesRepo  (gh-pages)  ->  $PagesUrl"
    Write-Host ""
    Write-Host "This PUBLISHES to GitHub Pages immediately." -ForegroundColor Yellow
    if (-not $Force) {
        if ((Read-Host "Type 'yes' to deploy") -ne 'yes') {
            Write-Host 'Aborted.'; Remove-Item $staging -Recurse -Force; return
        }
    }

    # A fresh single-commit branch each release, force-pushed. gh-pages is a deploy artifact, not a
    # record: the versioned record is the private host's v/ folder, and the source is the mirror's
    # main. Rolling Pages back is running -Pages from an older checkout.
    Push-Location $staging
    git init -q -b gh-pages
    git add -A
    git commit -q -m "Release $stamp"
    if (-not $?) { Pop-Location; Fail 'Could not commit the release.' }
    git push -q --force $PagesRepo HEAD:gh-pages
    $pushed = $?
    Pop-Location
    if (-not $pushed) { Fail 'Push to gh-pages failed. Pages is unchanged.' }
    Remove-Item $staging -Recurse -Force

    Write-Host ""
    Write-Host "Pushed to gh-pages: $PagesUrl  ($stamp)" -ForegroundColor Green
    Write-Host "Pages rebuilds in about a minute. Check with:" -ForegroundColor Cyan
    Write-Host "  curl -sI ${PagesUrl}sw.js | findstr /i `"200`""
    return
}

# A deploy artifact, not part of the app, which is why it is generated here rather than committed.
# Every directive is guarded: an .htaccess referencing a module the host has not loaded returns 500
# for the whole folder, and this one goes live unattended.
$htaccess = @'
# Generated by tools/release.ps1. Do not edit on the server - the next deploy overwrites it.

# A private diary should not be in search results.
<IfModule mod_headers.c>
    Header set X-Robots-Tag "noindex, nofollow"
</IfModule>

# Shared hosting often does not know these. Without the manifest type the browser ignores the file
# and Add to Home Screen quietly loses its name and icon - which is the whole reason it is here.
# Without the woff2 type the fonts may be served as octet-stream and refused.
<IfModule mod_mime.c>
    AddType application/manifest+json .webmanifest
    AddType image/svg+xml            .svg
    AddType font/woff2               .woff2
</IfModule>

# The service worker must never be served stale: it is the only thing that can replace itself, so a
# cached copy freezes every future update.
#
# The app's own files need revalidating too, and this used to say they did not - "everything else is
# content-stamped by the cache name". The cache NAME is stamped; the file URLs are not. index.html,
# js/*.js and styles.css keep the same address forever and only their contents change, so with no
# Cache-Control at all a browser falls back to heuristic caching and can hand a stale copy to the
# service worker's own install. The worker then precaches the previous release under a new cache
# name. "no-cache" still allows a 304, so this costs a conditional request, not a download.
<IfModule mod_headers.c>
    <FilesMatch "\.(html|js|css|webmanifest)$">
        Header set Cache-Control "no-cache"
    </FilesMatch>
    # After the rule above, so the stricter one wins for the worker itself.
    <FilesMatch "sw\.js$">
        Header set Cache-Control "no-cache, no-store, must-revalidate"
    </FilesMatch>
    # Fonts are immutable: their names change when their contents do.
    <FilesMatch "\.woff2$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</IfModule>

# v/ holds every past release. Nothing there is secret, but it is not for browsing.
Options -Indexes
'@
[IO.File]::WriteAllText((Join-Path $staging '.htaccess'), $htaccess, (New-Object Text.UTF8Encoding($false)))

$tgz = Join-Path ([IO.Path]::GetTempPath()) "daybook-$stamp.tgz"
if (Test-Path $tgz) { Remove-Item $tgz -Force }
# One archive, one upload. A file-per-scp would be a fresh SSH handshake each time.
& $TarExe -czf $tgz -C $staging .
if (-not $?) { Fail 'tar failed.' }

$sizeKb = [math]::Round((Get-Item $tgz).Length / 1KB, 1)

# ---------------------------------------------------------------------------------------------
# Confirm, upload, swap
# ---------------------------------------------------------------------------------------------

Write-Host ""
Write-Host "Release : $stamp"
Write-Host "Files   : $($files.Count) + .htaccess"
Write-Host "Upload  : $sizeKb KB compressed"
Write-Host "Target  : $SshHost`:$RemoteBase/v/$stamp/  ->  copied live to $SiteUrl"
Write-Host ""
Write-Host "This PUBLISHES to the LIVE site immediately." -ForegroundColor Yellow
if (-not $Force) {
    if ((Read-Host "Type 'yes' to deploy") -ne 'yes') {
        Write-Host 'Aborted.'; Remove-Item $staging -Recurse -Force; Remove-Item $tgz -Force; return
    }
}

# The same guard the preflight runs. Checked here too, because a guard you have
# to remember to run is not a guard.
Assert-TargetIsOurs | Out-Null

scp $tgz "${SshHost}:daybook-upload.tgz"
if (-not $?) { Fail 'Upload failed. Nothing on the server has changed.' }

# Unpack into the versioned folder first. Until the swap below runs, the live site is untouched.
ssh $SshHost "set -e; mkdir -p $RemoteBase/v/$stamp; rm -rf $RemoteBase/v/$stamp/*; tar -xzf ~/daybook-upload.tgz -C $RemoteBase/v/$stamp; rm -f ~/daybook-upload.tgz"
if (-not $?) { Fail "Unpack failed. The live site is unchanged; v/$stamp may be partial." }

$clear = ($LiveEntries | ForEach-Object { "rm -rf '$RemoteBase/$_'" }) -join '; '
ssh $SshHost "set -e; mkdir -p $RemoteBase; $clear; cp -a $RemoteBase/v/$stamp/. $RemoteBase/; echo $stamp > $RemoteBase/.release"
if (-not $?) { Fail "Swap failed. Put a known-good release back with: .\tools\release.ps1 -Rollback <stamp>" }

Remove-Item $staging -Recurse -Force
Remove-Item $tgz -Force

Write-Host ""
Write-Host "Live: $SiteUrl  ($stamp)" -ForegroundColor Green
Write-Host ""
Write-Host "Check before handing it to her:" -ForegroundColor Cyan
Write-Host "  curl -sI $SiteUrl | findstr /i `"200 x-robots`""
Write-Host "  curl -sI ${SiteUrl}manifest.webmanifest | findstr /i `"content-type`""
Write-Host "  curl -sI ${SiteUrl}sw.js | findstr /i `"cache-control`""
Write-Host ""
Write-Host "Roll back with: .\tools\release.ps1 -Rollback <stamp>   (-List to see them)" -ForegroundColor DarkGray
