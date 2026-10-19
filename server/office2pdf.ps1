# Save a document as PDF with Microsoft Office (PowerPoint/Word/Excel). Windows only.
# Usage: powershell -File office2pdf.ps1 -In <source path> -Out <pdf path>
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$In = [System.IO.Path]::GetFullPath($In)
$Out = [System.IO.Path]::GetFullPath($Out)
$ext = [System.IO.Path]::GetExtension($In).ToLowerInvariant()

function Release($obj) {
  if ($obj) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) }
}

$app = $null
$doc = $null
try {
  if ($ext -in '.ppt', '.pptx', '.odp') {
    $app = New-Object -ComObject PowerPoint.Application
    # Open(FileName, ReadOnly, Untitled, WithWindow): msoTrue = -1, msoFalse = 0
    $doc = $app.Presentations.Open($In, -1, 0, 0)
    $doc.SaveAs($Out, 32)  # ppSaveAsPDF
    $doc.Close()
  }
  elseif ($ext -in '.doc', '.docx', '.odt', '.rtf', '.txt') {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    # Open(FileName, ConfirmConversions, ReadOnly)
    $doc = $app.Documents.Open($In, $false, $true)
    $doc.ExportAsFixedFormat($Out, 17)  # wdExportFormatPDF
    $doc.Close($false)
  }
  elseif ($ext -in '.xls', '.xlsx', '.xlsm', '.ods', '.csv') {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $doc = $app.Workbooks.Open($In, 0, $true)
    # Fit each sheet on one page so tables are not split across pages
    foreach ($sheet in $doc.Worksheets) {
      try {
        $sheet.PageSetup.Zoom = $false
        $sheet.PageSetup.FitToPagesWide = 1
        $sheet.PageSetup.FitToPagesTall = 1
      } catch { }
      Release $sheet
    }
    $doc.ExportAsFixedFormat(0, $Out)  # xlTypePDF
    $doc.Close($false)
  }
  else {
    throw "Unsupported format: $ext"
  }
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
finally {
  Release $doc
  if ($app) { try { $app.Quit() } catch { } }
  Release $app
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
if (-not (Test-Path -LiteralPath $Out)) {
  [Console]::Error.WriteLine('PDF was not created.')
  exit 1
}
exit 0
