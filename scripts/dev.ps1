<#
.SYNOPSIS
Runs the Zing backend and app together for local development.

.DESCRIPTION
Starts `api` (Next.js, port 3000) in its own window and `mobile` (Expo) in this
one, so Expo keeps the interactive TTY its keyboard menu needs.

The phone cannot reach `localhost`, so the app is pointed at this machine's LAN
address instead. That address is not stable - it changes when you move networks
- so the script re-detects it every run and rewrites the one line in
`mobile/.env` when it has drifted. Everything else in that file is preserved.

.PARAMETER Mock
Run the API with ZING_MOCK=1: no keys, no spend, canned agent responses.

.PARAMETER Chaos
Run the API with ZING_MOCK=chaos: same, plus the four deliberate failures that
exercise the drop-and-degrade paths. A healthy chaos batch is 3 groups.

.PARAMETER Tunnel
Start Expo with --tunnel (for cellular or hostile venue Wi-Fi). Note this
tunnels Metro only, NOT the API - with a LAN API URL the phone still has to be
on the same network. For a real tunnel demo, point the app at the Vercel URL.

.PARAMETER ApiOnly
Start only the backend, in this window.

.PARAMETER Clear
Pass --clear to Expo, forcing a Metro cache reset.

.PARAMETER CheckOnly
Run the preflight, detect the LAN address and sync mobile/.env, then stop
without starting anything. Useful after moving networks.

.EXAMPLE
.\scripts\dev.ps1 -Mock

.EXAMPLE
.\scripts\dev.ps1 -Chaos -Clear
#>
[CmdletBinding()]
param(
    [switch]$Mock,
    [switch]$Chaos,
    [switch]$Tunnel,
    [switch]$ApiOnly,
    [switch]$Clear,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $RepoRoot 'api'
$MobileDir = Join-Path $RepoRoot 'mobile'
$MobileEnv = Join-Path $MobileDir '.env'
$ApiPort = 3000

if ($Mock -and $Chaos) {
    throw 'Use -Mock or -Chaos, not both.'
}

$MockMode = ''
if ($Mock) { $MockMode = '1' }
if ($Chaos) { $MockMode = 'chaos' }

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Warn($Message) { Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Bad($Message) { Write-Host "  x $Message" -ForegroundColor Red }

# --- Preflight ---------------------------------------------------------------

foreach ($dir in @($ApiDir, $MobileDir)) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Bad "$dir has no node_modules. Run: cd $dir; npm install"
        exit 1
    }
}

# A stale server on 3000 is the nastiest failure here: the smoke script has no
# idea which server answered, so an old process gives you a green run in the
# wrong mode. Refuse to start rather than silently reuse it.
$Occupied = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue
if ($null -ne $Occupied) {
    $ownerPid = ($Occupied | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $name = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
    if ($CheckOnly) {
        Write-Warn "Port $ApiPort is in use by PID $ownerPid ($name) - a dev server is already running."
    } else {
        Write-Bad "Port $ApiPort is already in use by PID $ownerPid ($name)."
        Write-Host "    That is probably an old dev server. It would answer requests in"
        Write-Host "    whatever mode it was started with, so this run would prove nothing."
        Write-Host "    Free it with:  Stop-Process -Id $ownerPid -Force"
        exit 1
    }
}

# --- LAN address -------------------------------------------------------------

# Pick the IPv4 address on the interface that actually carries the default
# route, so a VPN or a docker/WSL bridge does not win over Wi-Fi.
#
# Only interfaces that are *Up* are eligible. A disconnected adapter keeps both
# its last address and its default route, so route metric alone will happily
# return an address nothing answers on. That failure is silent and expensive:
# every check from this machine still passes, because an address assigned to a
# local interface answers over loopback whether or not the adapter is carrying
# traffic - so the phone is the only thing that can tell, and all it shows is a
# pipeline that hangs on the first stage and falls back 90s later.
function Get-LanAddress {
    # First, ask the stack the same question the phone's traffic will ask:
    # which local address does Windows actually source outbound traffic from?
    #
    # This matters when the laptop is on one network twice - a dock's Ethernet
    # and Wi-Fi, both on the same router, as here. Both interfaces then carry a
    # default route at the same metric, so sorting by metric alone picks between
    # them by input order, which is a coin flip. Expo meanwhile advertises the
    # OS's preferred address. When the two disagree the phone loads the bundle
    # from one address and is told to call the API on the other - and the reply
    # to that second address egresses the *other* NIC while still carrying the
    # first NIC's source IP, so the handshake never completes and every stage
    # hangs until the 90s deadline. Find-NetRoute resolves the tie exactly as
    # the kernel does, which is exactly what Expo will advertise.
    $preferred = Find-NetRoute -RemoteIPAddress '8.8.8.8' -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^\d{1,3}(\.\d{1,3}){3}$' -and
            $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
        } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if ($preferred) { return $preferred }

    # Fallbacks, for a machine with no route off the LAN at all. Only adapters
    # that are Up are eligible: a disconnected one keeps its last address and
    # its default route, and every check from this machine would still pass,
    # because a locally-assigned address answers over loopback whether or not
    # the adapter carries traffic.
    $up = @(
        Get-NetAdapter -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'Up' } |
            Select-Object -ExpandProperty ifIndex
    )
    if ($up.Count -eq 0) { return $null }

    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Where-Object { $up -contains $_.ifIndex } |
        Sort-Object RouteMetric, ifMetric |
        Select-Object -First 1
    if ($null -ne $route) {
        $addr = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.ifIndex -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Select-Object -First 1
        if ($null -ne $addr) { return $addr.IPAddress }
    }
    $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $up -contains $_.InterfaceIndex -and
            $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
        } |
        Select-Object -First 1
    if ($null -ne $fallback) { return $fallback.IPAddress }
    return $null
}

$Lan = Get-LanAddress
if ($null -eq $Lan) {
    Write-Bad 'No usable IPv4 address found. Are you connected to a network?'
    exit 1
}
$ApiUrl = "http://${Lan}:${ApiPort}"

# --- Point the app at it -----------------------------------------------------

# Rewrite only the active EXPO_PUBLIC_ZING_API_URL line. Comments, the commented
# Vercel URL, and anything else in the file survive untouched.
function Sync-MobileEnv($Url) {
    $line = "EXPO_PUBLIC_ZING_API_URL=$Url"

    if (-not (Test-Path $MobileEnv)) {
        $example = Join-Path $MobileDir '.env.example'
        if (Test-Path $example) {
            Copy-Item $example $MobileEnv
        } else {
            [System.IO.File]::WriteAllText($MobileEnv, "$line`n", (New-Object System.Text.UTF8Encoding $false))
            return $true
        }
    }

    # -Encoding UTF8 is required: without it PS 5.1 reads the file as ANSI and
    # writing it back out as UTF-8 double-encodes every non-ASCII character in
    # the surrounding comments.
    $lines = @(Get-Content $MobileEnv -Encoding UTF8)
    $current = $null
    $found = $false
    $out = foreach ($l in $lines) {
        if ($l -match '^\s*EXPO_PUBLIC_ZING_API_URL\s*=') {
            $found = $true
            $current = ($l -split '=', 2)[1].Trim()
            $line
        } else {
            $l
        }
    }
    if (-not $found) { $out = @($out) + $line }

    if ($current -eq $Url) { return $false }

    # No BOM - a BOM ahead of the first key breaks dotenv parsers. LF rather
    # than WriteAllLines' CRLF, to match the rest of the repo.
    $text = (($out -join "`n") + "`n")
    [System.IO.File]::WriteAllText($MobileEnv, $text, (New-Object System.Text.UTF8Encoding $false))
    return $true
}

$Changed = $false
if (-not $ApiOnly) {
    $Changed = Sync-MobileEnv $ApiUrl
}

# --- Banner ------------------------------------------------------------------

$modeLabel = 'real keys (this run costs money)'
if ($MockMode -eq '1') { $modeLabel = 'ZING_MOCK=1 - canned, no spend' }
if ($MockMode -eq 'chaos') { $modeLabel = 'ZING_MOCK=chaos - failures injected, expect 3 groups' }

Write-Host ''
Write-Host '  zing dev' -ForegroundColor Green
Write-Host "  mode     $modeLabel"
Write-Host "  api      $ApiUrl"
if (-not $ApiOnly) {
    if ($Changed) {
        Write-Host "  app      mobile/.env updated to $ApiUrl" -ForegroundColor Yellow
    } else {
        Write-Host "  app      mobile/.env already correct"
    }
}
Write-Host ''

if ($CheckOnly) {
    Write-Step 'Check only - nothing started.'
    exit 0
}

# --- Start the API -----------------------------------------------------------

$envPrefix = ''
if ($MockMode -ne '') { $envPrefix = "`$env:ZING_MOCK='$MockMode'; " }

if ($ApiOnly) {
    Write-Step 'Starting API in this window. Ctrl-C to stop.'
    Write-Host ''
    if ($MockMode -ne '') { $env:ZING_MOCK = $MockMode }
    Set-Location $ApiDir
    & npm run dev
    exit $LASTEXITCODE
}

Write-Step 'Starting API in a new window...'
$apiCommand = "$envPrefix Set-Location '$ApiDir'; npm run dev"
$ApiProcess = Start-Process powershell -PassThru -ArgumentList @(
    '-NoExit', '-NoProfile', '-Command', $apiCommand
)

# --- Wait for it, and prove the phone can reach it ---------------------------

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($ApiProcess.HasExited) {
        Write-Bad 'The API window exited. Check it for the error.'
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$ApiPort/api/fallback" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # not up yet
    }
}

if (-not $ready) {
    Write-Warn "API did not answer on localhost:$ApiPort within 30s. Continuing anyway."
} else {
    Write-Step "API ready on localhost:$ApiPort"

    # localhost working but the LAN address not is the Windows Firewall
    # signature, and it presents on the phone as a generic network error.
    try {
        $r = Invoke-WebRequest -Uri "$ApiUrl/api/fallback" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { Write-Step "Reachable on $ApiUrl - the phone can see it" }
    } catch {
        Write-Warn "$ApiUrl is NOT reachable even though localhost is."
        Write-Host '    That is almost always Windows Firewall blocking inbound Node.'
        Write-Host '    The phone will fail every stage and the app will silently show'
        Write-Host '    the bundled fallback batch. Allow it with (admin):'
        Write-Host ''
        Write-Host "      New-NetFirewallRule -DisplayName 'Zing API' -Direction Inbound -Protocol TCP -LocalPort $ApiPort -Action Allow"
        Write-Host ''
    }
}

# --- Start Expo in this window ----------------------------------------------

$expoArgs = @('expo', 'start')
if ($Tunnel) { $expoArgs += '--tunnel' }
# Metro bakes EXPO_PUBLIC_* in at bundle time, so a changed URL needs a reset.
if ($Clear -or $Changed) { $expoArgs += '--clear' }

if ($Tunnel) {
    Write-Warn '--tunnel tunnels Metro, not the API. The phone still needs LAN access'
    Write-Warn 'to the API URL above, or point mobile/.env at the Vercel deployment.'
}

Write-Step 'Starting Expo here. Ctrl-C stops both.'
Write-Host ''

try {
    Set-Location $MobileDir
    & npx @expoArgs
} finally {
    Write-Host ''
    Write-Step 'Shutting down the API...'
    # npm spawns next as a child, so killing the window alone orphans the
    # listener and the next run trips the port-in-use guard.
    $listeners = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $listeners) {
        foreach ($listenerPid in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
            try { Stop-Process -Id $listenerPid -Force -ErrorAction Stop } catch {}
        }
    }
    if (-not $ApiProcess.HasExited) {
        try { Stop-Process -Id $ApiProcess.Id -Force -ErrorAction Stop } catch {}
    }
    Write-Step 'Done.'
}
