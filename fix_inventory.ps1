$db = Get-Content "C:\Users\J SHARMA\Desktop\NastigeApp\data\db.json" | ConvertFrom-Json

# Step 1: Calculate franchise_given_stock per product
$franchiseStock = @{}
foreach ($f in $db.franchises) {
  $stock = $f.stock | ConvertFrom-Json
  foreach ($prop in $stock.PSObject.Properties) {
    $pid = [int]($prop.Name -replace 'p', '')
    $qty = [int]$prop.Value
    if (-not $franchiseStock.ContainsKey($pid)) { $franchiseStock[$pid] = 0 }
    $franchiseStock[$pid] += $qty
  }
}

Write-Host "Franchise current stock per product:"
$franchiseStock

# Step 2: Calculate sold per product from pin packages
$soldByProduct = @{}
foreach ($pin in ($db.pin_packages | Where-Object { $_.status -eq 'used' })) {
  $pids = $pin.product_ids -replace '\[', '' -replace '\]', '' -split ','
  foreach ($pidStr in $pids) {
    $pid = [int]($pidStr.Trim())
    if (-not $soldByProduct.ContainsKey($pid)) { $soldByProduct[$pid] = 0 }
    $soldByProduct[$pid]++
  }
}

# Count paid orders
foreach ($o in ($db.orders | Where-Object { $_.payment_status -eq 'paid' })) {
  $pid = [int]$o.product_id
  $qty = [int]($o.quantity ?? 1)
  if (-not $soldByProduct.ContainsKey($pid)) { $soldByProduct[$pid] = 0 }
  $soldByProduct[$pid] += $qty
}

Write-Host "`nSold per product:"
$soldByProduct

# Step 3: Calculate franchise activations per product
$franchiseActivations = @{}
foreach ($pin in ($db.pin_packages | Where-Object { $_.status -eq 'used' -and $_.assigned_to_franchise -eq 1 })) {
  $pids = $pin.product_ids -replace '\[', '' -replace '\]', '' -split ','
  foreach ($pidStr in $pids) {
    $pid = [int]($pidStr.Trim())
    if (-not $franchiseActivations.ContainsKey($pid)) { $franchiseActivations[$pid] = 0 }
    $franchiseActivations[$pid]++
  }
}

Write-Host "`n=== PROPOSED UPDATES ==="
$changes = @{}
foreach ($p in $db.products) {
  $pid = [int]$p.id
  $curTotal = [int]($p.total_stock ?? 0)
  $curSold = [int]($p.sold_stock ?? 0)
  $fStock = if ($franchiseStock.ContainsKey($pid)) { $franchiseStock[$pid] } else { 0 }
  $actualSold = if ($soldByProduct.ContainsKey($pid)) { $soldByProduct[$pid] } else { 0 }
  $fAct = if ($franchiseActivations.ContainsKey($pid)) { $franchiseActivations[$pid] } else { 0 }
  
  # Amount given to franchise = current franchise stock + activations by franchise
  $givenToFranchise = $fStock + $fAct
  # Reconstruct total = current_total + given_to_franchise (since old code decremented it)
  $newTotal = $curTotal + $givenToFranchise
  
  Write-Host "$($p.name): Total $curTotal -> $newTotal | Sold $curSold -> $actualSold | FranchiseGiven $fStock | GivenToFranchise=$givenToFranchise"
  $changes[$pid] = @{ total = $newTotal; sold = $actualSold; franchise = $fStock }
}

Write-Host "`nApply changes? (y/n): " -NoNewline
$answer = Read-Host
if ($answer -eq 'y') {
  foreach ($p in $db.products) {
    $pid = [int]$p.id
    if ($changes.ContainsKey($pid)) {
      $c = $changes[$pid]
      $p.total_stock = $c.total
      $p.sold_stock = $c.sold
      $p.franchise_given_stock = $c.franchise
      Write-Host "Updated $($p.name)"
    }
  }
  $db | ConvertTo-Json -Depth 10 | Set-Content "C:\Users\J SHARMA\Desktop\NastigeApp\data\db.json" -Encoding UTF8
  Write-Host "Saved to db.json"
}
