Start-Sleep -Seconds 2
try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3002/admin/franchise/pin-reports' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($r.Content -match 'Failed') {
        Write-Host 'ERROR page shown'
        Write-Host $r.Content.Substring(0, [Math]::Min(500, $r.Content.Length))
    } else {
        Write-Host 'Page OK - length:' $r.Content.Length
    }
} catch {
    Write-Host 'Request failed:' $_.Exception.Message
}
