param([Parameter(Mandatory=$true)][string]$OutputPath)
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(440, 240)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([Drawing.ColorTranslator]::FromHtml('#f5f7f8'))
$accent = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#286b54'))
$light = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#c6e5d0'))
$ink = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#1e3029'))
$muted = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#697b73'))
$graphics.FillRectangle($accent, 194, 40, 52, 52)
$pen = [Drawing.Pen]::new([Drawing.Color]::White, 5)
$pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLines($pen, [Drawing.Point[]]@([Drawing.Point]::new(211,54),[Drawing.Point]::new(211,77),[Drawing.Point]::new(232,77)))
$graphics.FillEllipse($light, 227, 49, 10, 10)
$format = [Drawing.StringFormat]::new()
$format.Alignment = [Drawing.StringAlignment]::Center
$titleFont = [Drawing.Font]::new('Segoe UI', 23, [Drawing.FontStyle]::Bold)
$bodyFont = [Drawing.Font]::new('Microsoft YaHei', 10)
$graphics.DrawString('Lumi', $titleFont, $ink, [Drawing.RectangleF]::new(0,106,440,42), $format)
$loadingText = [string]::new([char[]]@(0x6B63,0x5728,0x542F,0x52A8,0x5DE5,0x4F5C,0x53F0,0x2026))
$graphics.DrawString($loadingText, $bodyFont, $muted, [Drawing.RectangleF]::new(0,156,440,25), $format)
$graphics.FillRectangle([Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#dce5df')), 178, 200, 84, 3)
$graphics.FillRectangle($accent, 178, 200, 30, 3)
$bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Bmp)
$titleFont.Dispose(); $bodyFont.Dispose(); $format.Dispose(); $pen.Dispose()
$accent.Dispose(); $light.Dispose(); $ink.Dispose(); $muted.Dispose()
$graphics.Dispose(); $bitmap.Dispose()
