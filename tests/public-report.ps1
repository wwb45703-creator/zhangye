param([Parameter(Mandatory)][string]$Workbook, [Parameter(Mandatory)][string]$Expected,
    [ValidateSet('Registered','Microsoft')][string]$Engine = 'Registered')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'support/spreadsheet-engine.ps1')
$entries = [IO.File]::ReadAllText($Expected, [Text.Encoding]::UTF8) | ConvertFrom-Json
$session = Start-SpreadsheetTest $Engine $Workbook
$excel = $session.App
$report = $null
$sha = [Security.Cryptography.SHA256]::Create()

function Digest([string]$value) {
    [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant()
}

try {
    $engineLabel = $session.Label
    $excel.DisplayAlerts = $false
    $excel.AutomationSecurity = 3
    $report = Open-SpreadsheetReport $session $Workbook
    $changes = $report.Worksheets.Item('差异清单')
    $fields = $report.Worksheets.Item('字段前后值')
    if ($changes.UsedRange.Rows.Count -ne ($entries.Count + 1) -or
        $fields.UsedRange.Rows.Count -ne ($entries.Count + 1)) { throw 'Unexpected exported row count' }
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $row = $i + 2
        $expectedEntry = $entries[$i]
        if ($changes.Cells.Item($row, 3).Value2 -cne $expectedEntry.key -or
            $changes.Cells.Item($row, 2).Value2 -cne '字段变更' -or
            $fields.Cells.Item($row, 1).Value2 -ne $changes.Cells.Item($row, 1).Value2 -or
            $fields.Cells.Item($row, 2).Value2 -cne $expectedEntry.field) {
            throw "Incorrect exported key, type or field in row $row"
        }
        if ((Digest $fields.Cells.Item($row, 3).Value2) -ne $expectedEntry.beforeDigest -or
            (Digest $fields.Cells.Item($row, 4).Value2) -ne $expectedEntry.afterDigest) {
            throw "Excel text differs from the official table in row $row"
        }
    }
    "$engineLabel PASS: all 6 original text cells matched."
} finally {
    try {
        if ($report) { $report.Close($false) }
    } finally {
        $sha.Dispose()
        Close-SpreadsheetTest $session
    }
}
