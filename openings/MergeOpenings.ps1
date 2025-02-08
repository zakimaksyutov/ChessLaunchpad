# MergeOpenings.ps1
# This script downloads a.tsv, b.tsv, c.tsv, d.tsv, e.tsv from GitHub
# and merges them into a single openings.tsv (skipping extra headers).

$urls = @(
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/a.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/b.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/c.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/d.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/e.tsv"
)

$mergedFile = "openings.tsv"

if (Test-Path $mergedFile) {
    Remove-Item $mergedFile
}

# We'll keep track if we've added the header yet.
$headerWritten = $false

foreach ($url in $urls) {
    Write-Host "Downloading $url..."
    $content = Invoke-WebRequest -Uri $url -UseBasicParsing
    $lines = $content.Content -split "`r?`n"

    # We'll skip the header if we've already written it
    # The header line typically is "eco    name    pgn"
    foreach ($idx in (0..($lines.Count - 1))) {
        $line = $lines[$idx]

        if ($idx -eq 0) {
            if (-not $headerWritten) {
                # Write the first file's header
                Add-Content -Path $mergedFile -Value $line
                $headerWritten = $true
            } else {
                # Skip the header on subsequent files
                continue
            }
        } else {
            # Normal line: append it
            Add-Content -Path $mergedFile -Value $line
        }
    }
}

Write-Host "All files merged into $mergedFile."
