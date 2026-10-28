param([string[]]$Write, [string]$Dump)
$ErrorActionPreference = 'Stop'
if (($null -eq $Write) -eq ([string]::IsNullOrEmpty($Dump))) { throw 'Use -Write <format=file>... or -Dump <directory>' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpikeClipboard {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClipboardFormatName(uint format, System.Text.StringBuilder name, int capacity);
  [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr memory);
  [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr memory);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr memory);
  [DllImport("gdi32.dll")] public static extern IntPtr SetEnhMetaFileBits(uint size, byte[] data);
  [DllImport("gdi32.dll")] public static extern uint GetEnhMetaFileBits(IntPtr handle, uint size, byte[] data);
  [DllImport("gdi32.dll")] public static extern bool DeleteEnhMetaFile(IntPtr handle);
}
'@
function Open-Board {
  for ($i = 0; $i -lt 10; $i++) { if ([SpikeClipboard]::OpenClipboard([IntPtr]::Zero)) { return }; Start-Sleep -Milliseconds 100 }
  throw 'OpenClipboard failed after retries'
}
function Make-Dib([string]$path) {
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap($path)
  try {
    $width = $bitmap.Width; $height = $bitmap.Height
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([uint32]124); $writer.Write([int32]$width); $writer.Write([int32](-$height)); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]3); $writer.Write([uint32]($width * $height * 4))
    1..4 | ForEach-Object { $writer.Write([uint32]0) }
    $writer.Write([uint32]0x00ff0000); $writer.Write([uint32]0x0000ff00); $writer.Write([uint32]0x000000ff); $writer.Write([uint32]4278190080)
    $writer.Write([uint32]0x73524742)
    1..16 | ForEach-Object { $writer.Write([uint32]0) }
    for ($y = 0; $y -lt $height; $y++) { for ($x = 0; $x -lt $width; $x++) { $p = $bitmap.GetPixel($x, $y); $writer.Write($p.B); $writer.Write($p.G); $writer.Write($p.R); $writer.Write($p.A) } }
    return ,$stream.ToArray()
  } finally { $bitmap.Dispose(); if ($writer) { $writer.Dispose() }; if ($stream) { $stream.Dispose() } }
}
Open-Board
try {
  if ($Write) {
    if (-not [SpikeClipboard]::EmptyClipboard()) { throw 'EmptyClipboard failed' }
    foreach ($spec in $Write) {
      $parts = $spec.Split(@('='), 2); if ($parts.Count -ne 2) { throw "Invalid format=file: $spec" }
      $name = $parts[0]; $path = $parts[1]; $format = 0; $emf = $false
      switch ($name) {
        'CF_UNICODETEXT' { $format = 13; $text = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $path)); $bytes = [System.Text.Encoding]::Unicode.GetBytes(($text -replace "`r?`n", "`r`n") + [char]0) }
        'CF_DIBV5' { $format = 17; $bytes = Make-Dib $path }
        'CF_ENHMETAFILE' { $format = 14; $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $path)); $emf = $true }
        default {
          if ($name -notin @('PNG', 'image/png', 'image/svg+xml', 'application/x-chemdraft-selection+json')) { throw "Unsupported write format: $name" }
          $format = [SpikeClipboard]::RegisterClipboardFormat($name); $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $path))
        }
      }
      if ($format -eq 0) { throw "Cannot register $name" }
      if ($emf) { $handle = [SpikeClipboard]::SetEnhMetaFileBits($bytes.Length, $bytes) }
      else {
        $handle = [SpikeClipboard]::GlobalAlloc(2, [UIntPtr]::new([uint64]$bytes.Length)); if ($handle -eq [IntPtr]::Zero) { throw 'GlobalAlloc failed' }
        $ptr = [SpikeClipboard]::GlobalLock($handle); if ($ptr -eq [IntPtr]::Zero) { [void][SpikeClipboard]::GlobalFree($handle); throw 'GlobalLock failed' }
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length); [void][SpikeClipboard]::GlobalUnlock($handle)
      }
      if ($handle -eq [IntPtr]::Zero -or [SpikeClipboard]::SetClipboardData($format, $handle) -eq [IntPtr]::Zero) {
        if ($handle -ne [IntPtr]::Zero) { if ($emf) { [void][SpikeClipboard]::DeleteEnhMetaFile($handle) } else { [void][SpikeClipboard]::GlobalFree($handle) } }
        throw "SetClipboardData failed: $name"
      }
    }
  } else {
    [void][System.IO.Directory]::CreateDirectory($Dump); $records = @(); $format = [uint32]0
    while (($format = [SpikeClipboard]::EnumClipboardFormats($format)) -ne 0) {
      $builder = New-Object System.Text.StringBuilder 256; [void][SpikeClipboard]::GetClipboardFormatName($format, $builder, $builder.Capacity)
      $name = $builder.ToString(); if (-not $name) { $name = "CF_$format" }
      $record = [ordered]@{ id = $format; name = $name }; $handle = [SpikeClipboard]::GetClipboardData($format); $bytes = $null
      if ($handle -eq [IntPtr]::Zero) { $record.note = 'No handle' }
      elseif ($format -eq 14) {
        $size = [SpikeClipboard]::GetEnhMetaFileBits($handle, 0, $null)
        if ($size -gt 0 -and $size -le 209715200) { $bytes = New-Object byte[] $size; if ([SpikeClipboard]::GetEnhMetaFileBits($handle, $size, $bytes) -ne $size) { $bytes = $null } }
      } elseif ($format -in @(2, 3, 9, 14, 15)) { $record.note = 'Handle-based format, not HGLOBAL' }
      else {
        $size = [SpikeClipboard]::GlobalSize($handle).ToUInt64()
        if ($size -gt 0 -and $size -le 209715200) { $ptr = [SpikeClipboard]::GlobalLock($handle); if ($ptr -ne [IntPtr]::Zero) { $bytes = New-Object byte[] ([int]$size); [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, [int]$size); [void][SpikeClipboard]::GlobalUnlock($handle) } }
      }
      if ($null -ne $bytes) {
        $safe = $name -replace '[^A-Za-z0-9._-]', '_'; $filename = "$format-$safe.bin"; $file = Join-Path $Dump $filename
        [System.IO.File]::WriteAllBytes($file, $bytes); $record.file = $filename; $record.size = $bytes.Length; $record.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
      } elseif (-not $record.note) { $record.note = 'Not readable as HGLOBAL or exceeds 200 MB' }
      $records += [pscustomobject]$record
    }
    [System.IO.File]::WriteAllText((Join-Path $Dump 'index.json'), (ConvertTo-Json -InputObject @($records) -Depth 4), (New-Object System.Text.UTF8Encoding $false))
  }
} finally { [void][SpikeClipboard]::CloseClipboard() }
