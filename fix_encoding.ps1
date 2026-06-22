$viewDir = "C:\Users\J SHARMA\Desktop\NastigeApp\views"
$files = Get-ChildItem "$viewDir\*.ejs"
foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    # Fix common broken encoding patterns
    $newContent = $content
    $newContent = $newContent -replace ' � ', ' | '
    $newContent = $newContent -replace '◆', '|'
    if ($newContent -ne $content) {
        [System.IO.File]::WriteAllText($f.FullName, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "Fixed: $($f.Name)"
    }
}
