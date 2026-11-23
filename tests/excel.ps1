param([ValidateSet('Registered','Microsoft')][string]$Engine = 'Registered')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'support/spreadsheet-engine.ps1')
$root = Split-Path -Parent $PSScriptRoot
$artifactDir = Join-Path $root '.test-artifacts'
$fixture = [IO.File]::ReadAllText((Join-Path $artifactDir 'baseline-input.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json

function Check($condition, [string]$message) {
    if (-not $condition) { throw $message }
}

function Write-Table($sheet, $table) {
    $rows = @($table.headers)
    $lastCol = [char](64 + $table.headers.Count)
    $sheet.Range(('A1:{0}{1}' -f $lastCol, ($table.rows.Count + 1))).NumberFormat = '@'
    for ($col = 0; $col -lt $rows.Count; $col++) {
        $sheet.Cells.Item(1, $col + 1).Value2 = [string]$rows[$col]
    }
    for ($row = 0; $row -lt $table.rows.Count; $row++) {
        for ($col = 0; $col -lt $rows.Count; $col++) {
            $sheet.Cells.Item($row + 2, $col + 1).Value2 = [string]$table.rows[$row][$col]
        }
    }
}

$session = Start-SpreadsheetTest $Engine (Join-Path $artifactDir 'edge.xlsx')
$excel = $session.App
$comparison = $null
$report = $null
try {
    $engineLabel = $session.Label
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AutomationSecurity = 3
    $comparison = $excel.Workbooks.Add(-4167)
    $prior = $comparison.Worksheets.Item(1)
    $prior.Name = 'Prior'
    Write-Table $prior $fixture.before
    $current = $comparison.Worksheets.Add()
    $current.Name = 'Current'
    Write-Table $current $fixture.after
    $oracle = $comparison.Worksheets.Add()
    $oracle.Name = 'Oracle'
    $priorKey = [Array]::IndexOf($fixture.before.headers, $fixture.rule.beforeKey)
    $currentKey = [Array]::IndexOf($fixture.after.headers, $fixture.rule.afterKey)
    $priorColumn = [char](65 + $priorKey)
    $currentColumn = [char](65 + $currentKey)
    $priorRef = 'Prior!${0}$2:${0}${1}' -f $priorColumn, ($fixture.before.rows.Count + 1)
    $currentRef = 'Current!${0}$2:${0}${1}' -f $currentColumn, ($fixture.after.rows.Count + 1)
    $keys = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($row in $fixture.before.rows) {
        $key = ([string]$row[$priorKey]).Trim()
        if (($key -eq '') -or $seen.Add($key)) { $keys.Add($key) }
    }
    foreach ($row in $fixture.after.rows) {
        $key = ([string]$row[$currentKey]).Trim()
        if (($key -eq '') -or $seen.Add($key)) { $keys.Add($key) }
    }
    $oracle.Range(('A2:A{0}' -f ($keys.Count + 1))).NumberFormat = '@'
    $checks = foreach ($field in $fixture.rule.fields) {
        $p = [char](65 + [Array]::IndexOf($fixture.before.headers, $field))
        $c = [char](65 + [Array]::IndexOf($fixture.after.headers, $field))
        'EXACT(INDEX(Prior!{0}:{0},D{{0}}),INDEX(Current!{1}:{1},E{{0}}))' -f $p, $c
    }
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $row = $i + 2
        $oracle.Cells.Item($row, 1).Value2 = [string]$keys[$i]
        $oracle.Cells.Item($row, 2).Formula = '=SUMPRODUCT(--EXACT(A{0},{1}))' -f $row, $priorRef
        $oracle.Cells.Item($row, 3).Formula = '=SUMPRODUCT(--EXACT(A{0},{1}))' -f $row, $currentRef
        $oracle.Cells.Item($row, 4).Formula = '=IF(B{0}=1,SUMPRODUCT(--EXACT(A{0},{1}),ROW({1})),0)' -f $row, $priorRef
        $oracle.Cells.Item($row, 5).Formula = '=IF(C{0}=1,SUMPRODUCT(--EXACT(A{0},{1}),ROW({1})),0)' -f $row, $currentRef
        $allFields = ($checks -join ',') -f $row
        $oracle.Cells.Item($row, 6).Formula = '=IF(OR(A{0}="",B{0}>1,C{0}>1),"待复核",IF(B{0}=0,"仅本期有",IF(C{0}=0,"本期未见",IF(AND({1}),"无变化","字段变更"))))' -f $row, $allFields
    }
    $excel.Calculate()
    $oracleEntries = @()
    $oracleFields = @()
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $row = $i + 2
        $result = [string]$oracle.Cells.Item($row, 6).Value2
        Check ($result -in @('待复核', '仅本期有', '本期未见', '无变化', '字段变更')) "Spreadsheet baseline formula failed at row ${row}: $result"
        $oracleEntries += [pscustomobject]@{ Key = $keys[$i]; Type = $result }
        if ($result -cne '字段变更') { continue }
        $priorRow = [int]$oracle.Cells.Item($row, 4).Value2
        $currentRow = [int]$oracle.Cells.Item($row, 5).Value2
        foreach ($field in $fixture.rule.fields) {
            $p = 1 + [Array]::IndexOf($fixture.before.headers, $field)
            $c = 1 + [Array]::IndexOf($fixture.after.headers, $field)
            $old = [string]$prior.Cells.Item($priorRow, $p).Value2
            $new = [string]$current.Cells.Item($currentRow, $c).Value2
            if ($old -cne $new) {
                $oracleFields += [pscustomobject]@{ Key = $keys[$i]; Field = $field; Old = $old; New = $new }
            }
        }
    }

    $expectedFields = $oracleFields
    foreach ($name in @('edge', 'chrome')) {
        $remainingFields = $expectedFields
        $filename = Join-Path $artifactDir ($name + '.xlsx')
        Check (Test-Path -LiteralPath $filename) "Missing report $filename. Run browser verification first."
        $report = Open-SpreadsheetReport $session $filename
        Check ($report.Worksheets.Count -eq 3) "$name workbook should have three sheets"
        $details = $report.Worksheets.Item('差异清单')
        $expected = @($oracleEntries | Where-Object { $_.Type -ne '无变化' })
        $actual = @()
        $textKey = $false
        $ids = @{}
        for ($i = 2; $i -le $details.UsedRange.Rows.Count; $i++) {
            $key = $details.Cells.Item($i, 3).Value2
            $ids[[string]$details.Cells.Item($i, 1).Value2] = [string]$key
            if ($key -ceq '0007') { $textKey = $key -is [string] }
            $actual += ('{0}|{1}' -f [string]$key, [string]$details.Cells.Item($i, 2).Value2)
        }
        $expectedKeys = @($expected | ForEach-Object { '{0}|{1}' -f $_.Key, $_.Type } | Sort-Object -CaseSensitive)
        $actualKeys = @($actual | Sort-Object -CaseSensitive)
        Check (($expectedKeys -join "`n") -ceq ($actualKeys -join "`n")) "$name rows differ from the Excel EXACT baseline"
        Check $textKey "$name changed 0007 from a text identifier"
        $values = $report.Worksheets.Item('字段前后值')
        $safeFormula = $false
        Check (($values.UsedRange.Rows.Count - 1) -eq $expectedFields.Count) "$name field change count differs"
        for ($i = 2; $i -le $values.UsedRange.Rows.Count; $i++) {
            $key = $ids[[string]$values.Cells.Item($i, 1).Value2]
            $field = [string]$values.Cells.Item($i, 2).Value2
            $old = [string]$values.Cells.Item($i, 3).Value2
            $cell = $values.Cells.Item($i, 4)
            $new = [string]$cell.Value2
            $match = @($remainingFields | Where-Object {
                $_.Key -ceq $key -and $_.Field -ceq $field -and $_.Old -ceq $old -and $_.New -ceq $new
            })
            Check ($match.Count -eq 1) "$name Excel report field $key / $field differs from source rows"
            $remainingFields = @($remainingFields | Where-Object { $_ -ne $match[0] })
            if ($cell.Value2 -ceq '=1+1') {
                $safeFormula = (-not $cell.HasFormula) -and ($old -ceq '_x0041_')
            }
        }
        Check $safeFormula "$name did not preserve the two formula-like note strings exactly"
        $notes = $report.Worksheets.Item('核对说明')
        $checked = $false
        for ($i = 2; $i -le $notes.UsedRange.Rows.Count; $i++) {
            if ($notes.Cells.Item($i, 1).Value2 -ceq '无变化') {
                $checked = $notes.Cells.Item($i, 2).Value2 -eq @($oracleEntries | Where-Object Type -eq '无变化').Count
            }
        }
        Check $checked "$name unchanged count differs from Excel baseline"
        "$engineLabel PASS for ${name}: $($actual.Count) differences, $($expectedFields.Count) field changes, exact 0007 and formula-like text."
        $report.Close($false)
        $report = $null
    }

    $comparison.Close($false)
    $comparison = $null
    $delivery = [IO.File]::ReadAllText((Join-Path $artifactDir 'delivery-input.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $comparison = $excel.Workbooks.Add(-4167)
    $prior = $comparison.Worksheets.Item(1)
    $prior.Name = 'Prior'
    Write-Table $prior $delivery.before
    $current = $comparison.Worksheets.Add()
    $current.Name = 'Current'
    Write-Table $current $delivery.after
    $oracle = $comparison.Worksheets.Add()
    $oracle.Name = 'Oracle'
    $oracle.Range('A1:B50').NumberFormat = '@'

    $tuples = @(
        @('CG-2408', '010'), @('CG-2408', '020'), @('CG-2408', '030'),
        @('CG-2410', '001'), @('CG-2411', '001'), @('CG-2412', ''), @('CG-2413', '001')
    )
    $expected = @()
    for ($i = 0; $i -lt $tuples.Count; $i++) {
        $row = $i + 2
        $order, $line = $tuples[$i]
        $oracle.Cells.Item($row, 1).Value2 = [string]$order
        $oracle.Cells.Item($row, 2).Value2 = [string]$line
        $oracle.Cells.Item($row, 3).Formula = '=SUMPRODUCT(--EXACT(A{0},Prior!$A$2:$A$8),--EXACT(B{0},Prior!$B$2:$B$8))' -f $row
        $oracle.Cells.Item($row, 4).Formula = '=SUMPRODUCT(--EXACT(A{0},Current!$C$2:$C$6),--EXACT(B{0},Current!$B$2:$B$6))' -f $row
        $oracle.Cells.Item($row, 5).Formula = '=IF(C{0}=1,SUMPRODUCT(--EXACT(A{0},Prior!$A$2:$A$8),--EXACT(B{0},Prior!$B$2:$B$8),ROW(Prior!$A$2:$A$8)),0)' -f $row
        $oracle.Cells.Item($row, 6).Formula = '=IF(D{0}=1,SUMPRODUCT(--EXACT(A{0},Current!$C$2:$C$6),--EXACT(B{0},Current!$B$2:$B$6),ROW(Current!$C$2:$C$6)),0)' -f $row
        $oracle.Cells.Item($row, 7).Formula = '=IF(OR(A{0}="",B{0}="",C{0}>1,D{0}>1),"待复核",IF(C{0}=0,"仅本期有",IF(D{0}=0,"本期未见",IF(AND(EXACT(INDEX(Prior!C:C,E{0}),INDEX(Current!D:D,F{0})),EXACT(INDEX(Prior!D:D,E{0}),INDEX(Current!E:E,F{0})),EXACT(INDEX(Prior!E:E,E{0}),INDEX(Current!A:A,F{0}))),"无变化","字段变更"))))' -f $row
        $excel.Calculate()
        $type = [string]$oracle.Cells.Item($row, 7).Value2
        Check ($type -in @('待复核','仅本期有','本期未见','字段变更','无变化')) "Delivery oracle failed for $order / $line"
        if ($type -cne '无变化') { $expected += ('{0}|{1}|{2}' -f $order, $line, $type) }
    }

    foreach ($name in @('edge', 'chrome')) {
        $filename = Join-Path $artifactDir ($name + '-delivery.xlsx')
        $report = Open-SpreadsheetReport $session $filename
        $details = $report.Worksheets.Item('差异清单')
        Check ($details.Cells.Item(1, 4).Value2 -ceq '明细编号') "Missing separate text column for the line identifier"
        $actual = @()
        for ($i = 2; $i -le $details.UsedRange.Rows.Count; $i++) {
            $line = $details.Cells.Item($i, 4).Value2
            Check (($null -eq $line) -or ($line -is [string])) "Detail identifier became a number"
            $actual += ('{0}|{1}|{2}' -f $details.Cells.Item($i, 3).Value2, $line, $details.Cells.Item($i, 2).Value2)
        }
        Check (((@($expected | Sort-Object) -join '|') -ceq (@($actual | Sort-Object) -join '|'))) "$name compound-key rows differ from the Excel EXACT baseline"
        $values = $report.Worksheets.Item('字段前后值')
        Check (($values.UsedRange.Rows.Count - 1) -eq 2) "Expected two changed cells for CG-2408 / 010"
        Check (($values.Range('B2').Value2 -ceq '交期') -and
            ($values.Range('C2').Value2 -ceq $prior.Range('D2').Value2) -and
            ($values.Range('D2').Value2 -ceq $current.Range('E6').Value2) -and
            ($values.Range('B3').Value2 -ceq '未收量') -and
            ($values.Range('C3').Value2 -ceq $prior.Range('E2').Value2) -and
            ($values.Range('D3').Value2 -ceq $current.Range('A6').Value2)) "Delivery cell values differ from the Excel source"
        "$engineLabel PASS for ${name} delivery: $($actual.Count) differences, 2 field changes, preserved text line identifiers."
        $report.Close($false)
        $report = $null
    }

    foreach ($period in @('before', 'after')) {
        $csvBook = $excel.Workbooks.Add(-4167)
        try {
            $sheet = $csvBook.Worksheets.Item(1)
            $table = $delivery.$period
            $sheet.Range(('A1:E{0}' -f ($table.rows.Count + 3))).NumberFormat = '@'
            Write-Table $sheet $table
            $target = Join-Path $artifactDir ('excel-export-' + $period + '.csv')
            $csvFormat = if ($engineLabel -like 'Microsoft Excel 16.*') { 62 } else { 6 }
            $csvBook.SaveAs($target, $csvFormat)
        } finally {
            $csvBook.Close($false)
        }
    }
} finally {
    try {
        if ($report) { $report.Close($false) }
        if ($comparison) { $comparison.Close($false) }
    } finally {
        Close-SpreadsheetTest $session
    }
}
& node (Join-Path $PSScriptRoot 'check-csv-roundtrip.mjs')
exit $LASTEXITCODE
