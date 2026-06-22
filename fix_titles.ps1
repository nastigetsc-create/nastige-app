$viewDir = "C:\Users\J SHARMA\Desktop\NastigeApp\views"
$files = Get-ChildItem "$viewDir\*.ejs"
foreach ($f in $files) {
    $text = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    $newText = $text
    
    # Fix broken chars between words in <title>
    # Match <title>...</title> and fix any non-ASCII between word chars
    $newText = [regex]::Replace($newText, '<title>(.*?)</title>', {
        param($m)
        $title = $m.Groups[1].Value
        # Replace any non-ASCII char that's between word chars with " | "
        $fixed = [regex]::Replace($title, '(?<=[a-zA-Z0-9>])[^a-zA-Z0-9<\s]+(?=[a-zA-Z0-9<])', ' | ')
        # Also replace standalone non-ASCII with |
        $fixed = [regex]::Replace($fixed, '[^\x00-\x7F]+', '|')
        return "<title>$fixed</title>"
    })
    
    if ($newText -ne $text) {
        [System.IO.File]::WriteAllText($f.FullName, $newText, [System.Text.Encoding]::UTF8)
        Write-Host "Fixed: $($f.Name)"
    }
}
