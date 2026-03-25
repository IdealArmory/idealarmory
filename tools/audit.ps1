# =============================================================================
# Ideal Armory - Site Audit Script
# =============================================================================
param([string]$ChangedFile = "")

$ROOT = "C:\Users\jmali\OneDrive\Ideal Armory\New Deployment"
$errors   = [System.Collections.ArrayList]@()
$warnings = [System.Collections.ArrayList]@()
$passes   = [System.Collections.ArrayList]@()

function Fail($msg) { [void]$errors.Add($msg) }
function Warn($msg) { [void]$warnings.Add($msg) }
function Pass($msg) { [void]$passes.Add($msg) }

Write-Host ""
Write-Host "========================================================"
Write-Host " Ideal Armory Site Audit - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Write-Host "========================================================"

# =============================================================================
# 1. HOLSTERS.HTML - Eclipse card name vs URL handle consistency
# =============================================================================
Write-Host ""
Write-Host "-- [1] Eclipse Holsters: card name vs URL handle -------"

$holstersPath = "$ROOT\holsters.html"
if (Test-Path $holstersPath) {
    $html = Get-Content $holstersPath -Raw

    # Pattern for Eclipse entries: id, name, handle
    $pat1 = [regex]::new('\{id:(\d+),brand:''Eclipse Holsters'',name:''([^'']+)''.*?url:''https://eclipseholsters\.com/products/([^?'']+)')
    $eclipseMatches = $pat1.Matches($html)

    $seenIds = @{}
    $mismatchCount = 0
    foreach ($m in $eclipseMatches) {
        $id     = $m.Groups[1].Value
        $name   = $m.Groups[2].Value
        $handle = $m.Groups[3].Value

        if ($seenIds.ContainsKey($id)) {
            Fail "Duplicate product ID: $id (name: '$name')"
        }
        $seenIds[$id] = $true

        # True mismatch: handle contains a DIFFERENT gun brand than the name prefix
        # Eclipse uses generic sequential handles (e.g., ulticlip-in-the-waistband-holsters-5)
        # for many variants — these are OK. Only flag when handle explicitly names a different gun.
        $prefix = if ($name -match '^([^-]+)-') { $Matches[1].Trim().ToLower() } else { '' }
        $knownBrands = @('palmetto','walther','taurus','springfield','sig','ruger','fnh','canik',
                         '1911','polymer80','glock','shadow','smith','wesson','beretta','cz','sccy',
                         'kimber','ruger','hk','h&k')

        if ($prefix) {
            $handleLower = $handle.ToLower()
            # 'copy-of-' handles are Shopify duplicate artifacts — the handle IS the
            # correct URL even though it references another gun. Skip these.
            $isCopyOf = $handleLower -match '^copy-of-'
            if (-not $isCopyOf) {
                foreach ($brand in $knownBrands) {
                    $prefixHasBrand = $prefix -match [regex]::Escape($brand)
                    $handleHasBrand = $handleLower -match [regex]::Escape($brand)
                    if ($handleHasBrand -and -not $prefixHasBrand) {
                        Warn "Name/handle conflict - ID:$id | Name:'$name' but handle references '$brand': $handle"
                        $mismatchCount++
                        break
                    }
                }
            }
        }
    }

    if ($eclipseMatches.Count -eq 0) {
        Warn "No Eclipse entries found in holsters.html"
    } elseif ($mismatchCount -eq 0) {
        Pass "Eclipse: all $($eclipseMatches.Count) card names align with URL handles"
    } else {
        Warn "Eclipse: $mismatchCount possible name/handle mismatches (see above)"
    }

    # Carry field validity
    $carryPat = [regex]::new('brand:''Eclipse Holsters''.*?carry:''([^'']+)''')
    $badCarry  = $carryPat.Matches($html) | Where-Object { $_.Groups[1].Value -notin @('IWB','OWB','') }
    if ($badCarry.Count -eq 0) {
        Pass "Eclipse: all carry values are IWB or OWB"
    } else {
        foreach ($b in $badCarry) { Fail "Invalid carry '$($b.Groups[1].Value)' on an Eclipse entry" }
    }

    # Fit = 'Other' check
    $fitPat   = [regex]::new('\{id:(\d+),brand:''Eclipse Holsters''.*?fit:''Other''')
    $otherFit = $fitPat.Matches($html)
    if ($otherFit.Count -gt 0) {
        foreach ($o in $otherFit) { Warn "Eclipse ID $($o.Groups[1].Value): fit='Other' - not mapped to firearm filter" }
    } else {
        Pass "Eclipse: no unmapped fit values"
    }

    # Affiliate link check
    $urlPat  = [regex]::new('url:''(https://eclipseholsters[^'']+)''')
    $allUrls = $urlPat.Matches($html)
    $badAff  = $allUrls | Where-Object { $_.Groups[1].Value -notmatch 'sca_ref=10899101' }
    if ($badAff.Count -eq 0) {
        Pass "Eclipse: all $($allUrls.Count) retailer URLs have affiliate tracking"
    } else {
        foreach ($b in $badAff) { Fail "Missing affiliate params: $($b.Groups[1].Value)" }
    }

    # Brand in filter allowlist
    if ($html -match 'Eclipse Holsters.*indexOf|indexOf.*Eclipse Holsters') {
        Pass "Eclipse: brand present in filterProducts() allowlist"
    } else {
        Warn "Eclipse brand may be missing from filterProducts() allowlist - verify manually"
    }

} else {
    Warn "holsters.html not found - skipping Eclipse checks"
}

# =============================================================================
# 2. MANUAL-PRODUCTS.JSON - required fields, affiliate URLs, count match
# =============================================================================
Write-Host ""
Write-Host "-- [2] manual-products.json cross-file integrity -------"

$manualPath = "$ROOT\data\manual-products.json"
if (Test-Path $manualPath) {
    $manual        = Get-Content $manualPath | ConvertFrom-Json
    $eclipseManual = $manual | Where-Object { $_.brand -eq 'Eclipse Holsters' }
    $houdiniManual = $manual | Where-Object { $_.brand -eq 'Houdini Holsters' }

    Write-Host "   Total: $($manual.Count)  |  Eclipse: $($eclipseManual.Count)  |  Houdini: $($houdiniManual.Count)"

    $reqFields = @('id','brand','name','img','price','sellers','category')
    $fieldErrors = @()
    foreach ($p in $eclipseManual) {
        foreach ($f in $reqFields) {
            if (-not $p.$f) { $fieldErrors += "ID $($p.id): missing field '$f'" }
        }
        if ($p.sellers -and $p.sellers[0].url -notmatch 'sca_ref=10899101') {
            $fieldErrors += "ID $($p.id) '$($p.name)': seller URL missing affiliate params"
        }
    }
    if ($fieldErrors.Count -eq 0) {
        Pass "manual-products.json: all Eclipse entries have required fields and affiliate URLs"
    } else {
        foreach ($fe in $fieldErrors) { Fail $fe }
    }

    # Count match with holsters.html
    if (Test-Path $holstersPath) {
        $htmlEcCount = ([regex]::Matches((Get-Content $holstersPath -Raw), 'brand:''Eclipse Holsters''')).Count
        if ($htmlEcCount -eq $eclipseManual.Count) {
            Pass "Eclipse count matched: holsters.html ($htmlEcCount) = manual-products.json ($($eclipseManual.Count))"
        } else {
            Fail "Eclipse count mismatch: holsters.html=$htmlEcCount vs manual-products.json=$($eclipseManual.Count) - files are out of sync"
        }
    }

    # Duplicate IDs
    $dupIds = $manual | Group-Object id | Where-Object { $_.Count -gt 1 }
    if ($dupIds.Count -eq 0) {
        Pass "manual-products.json: no duplicate IDs"
    } else {
        foreach ($d in $dupIds) { Fail "Duplicate ID in manual-products.json: $($d.Name)" }
    }

} else {
    Warn "manual-products.json not found"
}

# =============================================================================
# 3. CATEGORY PAGES - EuroOptic filter bypass check
# =============================================================================
Write-Host ""
Write-Host "-- [3] Category pages: EuroOptic filter bypass check ---"

$catPages = @('handguns.html','rifles.html','shotguns.html','optics.html',
              'ammunition.html','ar-parts.html','magazines.html','holsters.html',
              'cleaning.html','gun-safes.html')

foreach ($page in $catPages) {
    $path = "$ROOT\$page"
    if (Test-Path $path) {
        $content = Get-Content $path -Raw
        # Check for the bypass pattern: if(p.src==='eurooptic') return true
        # Must be: if condition containing 'eurooptic' on same logical line as 'return true'
        if ($content -match "if\s*\([^)]*eurooptic[^)]*\)\s*return\s*true") {
            Fail "$page`: EuroOptic filter BYPASS active - all EuroOptic products skip filters"
        } else {
            Pass "$page`: no EuroOptic filter bypass"
        }
    }
}

# =============================================================================
# 4. RIFLES.HTML - price floor and product cap
# =============================================================================
Write-Host ""
Write-Host "-- [4] rifles.html: price floor / product cap ----------"

$riflesPath = "$ROOT\rifles.html"
if (Test-Path $riflesPath) {
    $riflesHtml = Get-Content $riflesPath -Raw
    if ($riflesHtml -match 'eo\.price<(\d+)') {
        $floor = [int]$Matches[1]
        if ($floor -le 500) {
            Pass "rifles.html: price floor = `$$floor (OK - at or below `$500)"
        } else {
            Warn "rifles.html: price floor = `$$floor - consider lowering to `$500 to capture Tikka entry-level models"
        }
    } else {
        Warn "rifles.html: price floor pattern not detected"
    }

    if ($riflesHtml -match '\.slice\(0,(\d+)\)') {
        $cap = [int]$Matches[1]
        if ($cap -ge 500) {
            Pass "rifles.html: product cap = $cap (OK)"
        } else {
            Warn "rifles.html: product cap = $cap - may cut off valid products"
        }
    }
}

# =============================================================================
# 5. FETCH-EUROOPTIC.JS - key brands in whitelist
# =============================================================================
Write-Host ""
Write-Host "-- [5] fetch-eurooptic.js: rifles brand whitelist ------"

$fetchPath = "$ROOT\.github\scripts\fetch-eurooptic.js"
if (Test-Path $fetchPath) {
    $fetchJs = Get-Content $fetchPath -Raw
    $mustHave = @('tikka','bergara','ruger','sig sauer','christensen','barrett','savage','mossberg')
    foreach ($b in $mustHave) {
        if ($fetchJs -match [regex]::Escape($b)) {
            Pass "fetch-eurooptic.js: '$b' in rifles whitelist"
        } else {
            Warn "fetch-eurooptic.js: '$b' NOT in rifles brand whitelist - products will be excluded from catalog"
        }
    }
}

# =============================================================================
# 6. SEARCH DATA - key brands in searchable data files
# =============================================================================
Write-Host ""
Write-Host "-- [6] Search: key brands in product data files --------"

$staticPath = "$ROOT\data\static-products.json"
$manualRaw  = if (Test-Path $manualPath) { Get-Content $manualPath -Raw } else { "" }
$staticRaw  = if (Test-Path $staticPath) { Get-Content $staticPath -Raw } else { "" }
$combined   = $manualRaw + $staticRaw

$searchBrands = @('Houdini Holsters','Eclipse Holsters')
foreach ($b in $searchBrands) {
    if ($combined -match [regex]::Escape($b)) {
        Pass "Search: '$b' found in product data files - will appear in site search"
    } else {
        Fail "Search: '$b' NOT in data files - products will be invisible to site-wide search"
    }
}

# =============================================================================
# SUMMARY
# =============================================================================
Write-Host ""
Write-Host "========================================================"
Write-Host " AUDIT RESULTS"
Write-Host "========================================================"
Write-Host ""

if ($errors.Count -gt 0) {
    Write-Host "  [FAIL] ERRORS - $($errors.Count) issue(s) that must be fixed:"
    foreach ($e in $errors) { Write-Host "      * $e" }
    Write-Host ""
}

if ($warnings.Count -gt 0) {
    Write-Host "  [WARN] WARNINGS - $($warnings.Count) item(s) to review:"
    foreach ($w in $warnings) { Write-Host "      ~ $w" }
    Write-Host ""
}

Write-Host "  [PASS] $($passes.Count) check(s) passed"
Write-Host ""

if ($errors.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "  STATUS: ALL CLEAR - safe to commit and deploy"
} elseif ($errors.Count -eq 0) {
    Write-Host "  STATUS: WARNINGS ONLY - review above before deploying"
} else {
    Write-Host "  STATUS: ERRORS FOUND - fix before committing"
}

Write-Host "========================================================"
Write-Host ""
exit 0
