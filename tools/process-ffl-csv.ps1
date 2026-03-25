# process-ffl-csv.ps1
# Processes a locally downloaded ATF FFL CSV file into per-state JSON files.
# Usage: powershell -ExecutionPolicy Bypass -File tools\process-ffl-csv.ps1 -CsvPath "C:\path\to\ffl.csv"

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath
)

$ROOT    = "C:\Users\jmali\OneDrive\Ideal Armory\New Deployment"
$OUT_DIR = "$ROOT\data\ffl"
$TMP     = "$env:TEMP\ideal-armory-ffl-$(Get-Random)"
$KEEP    = @('01','02','07','08')

Write-Host ""
Write-Host "========================================================"
Write-Host " FFL CSV Processor"
Write-Host "========================================================"

# ── Step 1: Validate CSV ────────────────────────────────────────────────────
if (-not (Test-Path $CsvPath)) {
    Write-Error "CSV file not found: $CsvPath"
    exit 1
}
Write-Host "Input: $CsvPath"

# ── Step 2: Download GeoNames ZIP centroids ──────────────────────────────────
Write-Host ""
Write-Host "Downloading GeoNames US ZIP centroids..."
New-Item -ItemType Directory -Force -Path $TMP | Out-Null
$geoZip = "$TMP\US.zip"
$geoDir = "$TMP\geonames"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://download.geonames.org/export/zip/US.zip" `
        -OutFile $geoZip -UseBasicParsing -TimeoutSec 60
    Expand-Archive -Path $geoZip -DestinationPath $geoDir -Force
} catch {
    Write-Error "Failed to download GeoNames data: $_"
    exit 1
}

$geoTxt = Get-ChildItem $geoDir -Filter "US.txt" | Select-Object -First 1
if (-not $geoTxt) {
    $geoTxt = Get-ChildItem $geoDir -Filter "*.txt" | Where-Object { $_.Name -notmatch 'readme' } | Select-Object -First 1
}
if (-not $geoTxt) { Write-Error "GeoNames US.txt not found"; exit 1 }

Write-Host "Building ZIP centroid lookup..."
$centroids = @{}
Get-Content $geoTxt.FullName | ForEach-Object {
    $parts = $_ -split "`t"
    if ($parts.Count -ge 11) {
        $zip = ($parts[1]).Trim()
        $lat = [double]($parts[9])
        $lng = [double]($parts[10])
        if ($zip -and -not $centroids.ContainsKey($zip)) {
            $centroids[$zip] = @{ lat = [Math]::Round($lat,4); lng = [Math]::Round($lng,4) }
        }
    }
}
Write-Host "  Centroids loaded: $($centroids.Count) ZIP codes"

# ── Step 3: Parse FFL CSV ────────────────────────────────────────────────────
Write-Host ""
Write-Host "Parsing FFL CSV..."
$rows = Import-Csv -Path $CsvPath
Write-Host "  Total rows: $($rows.Count)"

$byState  = @{}
$kept     = 0
$skipped  = 0

foreach ($row in $rows) {
    $type = ($row.LIC_TYPE).Trim().PadLeft(2,'0')
    if ($type -notin $KEEP) { $skipped++; continue }

    $state = ($row.PREMISE_STATE).Trim().ToUpper()
    if (-not $state -or $state.Length -ne 2) { $skipped++; continue }

    $zip   = ($row.PREMISE_ZIP_CODE).Trim().Substring(0, [Math]::Min(5, ($row.PREMISE_ZIP_CODE).Trim().Length))
    $coord = $centroids[$zip]
    if (-not $coord) { $skipped++; continue }

    $licName  = ($row.LICENSE_NAME).Trim()
    $bizName  = ($row.BUSINESS_NAME).Trim()
    $street   = ($row.PREMISE_STREET).Trim()
    $city     = ($row.PREMISE_CITY).Trim()
    $phone    = ($row.VOICE_PHONE).Trim() -replace '\D',''

    $entry = [ordered]@{
        n   = $licName
        b   = $bizName
        a   = $street
        c   = $city
        s   = $state
        z   = $zip
        p   = $phone
        t   = $type
        lat = $coord.lat
        lng = $coord.lng
    }

    if (-not $byState.ContainsKey($state)) { $byState[$state] = [System.Collections.ArrayList]@() }
    [void]$byState[$state].Add($entry)
    $kept++
}

Write-Host "  Kept: $kept  |  Skipped: $skipped"
Write-Host "  States: $($byState.Keys.Count)"

# ── Step 4: Write per-state JSON files ───────────────────────────────────────
Write-Host ""
Write-Host "Writing state files to $OUT_DIR ..."
New-Item -ItemType Directory -Force -Path $OUT_DIR | Out-Null

# Remove old state files (keep index.json)
Get-ChildItem $OUT_DIR -Filter "*.json" |
    Where-Object { $_.Name -ne 'index.json' } |
    Remove-Item -Force

$summary = [ordered]@{}
foreach ($state in ($byState.Keys | Sort-Object)) {
    $dealers  = $byState[$state]
    $outPath  = "$OUT_DIR\$state.json"
    $json     = ConvertTo-Json -InputObject @($dealers) -Depth 3 -Compress
    [System.IO.File]::WriteAllText($outPath, $json, [System.Text.Encoding]::UTF8)
    $summary[$state] = $dealers.Count
    Write-Host "  $state`: $($dealers.Count) dealers"
}

# Write index.json
$dateStr = (Get-Date -Format 'yyyy-MM-dd')
$total   = ($summary.Values | Measure-Object -Sum).Sum
$index   = [ordered]@{
    updated = $dateStr
    source  = "ATF FFL List $(Split-Path $CsvPath -Leaf)"
    states  = $summary
    total   = $total
}
$indexJson = ConvertTo-Json -InputObject $index -Depth 3
[System.IO.File]::WriteAllText("$OUT_DIR\index.json", $indexJson, [System.Text.Encoding]::UTF8)

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================================"
Write-Host " DONE"
Write-Host " Total FFL dealers: $total across $($summary.Keys.Count) states"
Write-Host " Updated: $dateStr"
Write-Host "========================================================"

# Clean up temp
Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
