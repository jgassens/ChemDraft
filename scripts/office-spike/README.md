# Office clipboard spike (incomplete)

This directory is a work in progress. PNG and SVG carrier generation and inspection are available;
PDF carriers and PDF and EMF inspection are not implemented. The native clipboard scripts have not been run. The
carrier generator exits with status 1 after writing PNG and SVG files to make that limitation visible.
Do not treat this as a completed Office measurement protocol.

The payload digest is the SHA-256 of the inner JSON string, as returned by `checkEnvelope`, rather
than the hash of the envelope or carrier file. Generate the available carriers with:

```text
node scripts/office-spike/make-carriers.mjs --payload packages/fixtures/office/sample-document.json --svg packages/fixtures/office/sample.svg --png packages/fixtures/office/sample.png --pdf packages/fixtures/office/sample.pdf --out packages/fixtures/office/carriers
node scripts/office-spike/inspect.mjs packages/fixtures/office/carriers --json
```

Inspection supports PNG, SVG and bounded stored/deflated ZIP entries; Office relationship targets
are resolved against the source part. It does not yet inspect all requested formats, and a finding of
no carrier in those formats is not evidence that none survived.

## Manual matrix

Record the OS and Office build. On each of macOS and Windows, repeat each PNG, SVG and PDF
carrier in both Word and PowerPoint. Also test the combined clipboard set: private JSON, plain
text, PNG and DIB, PDF and SVG as supported by the platform. For each combination:

1. Write the intended clipboard flavors, then paste with ordinary Paste. In a separate trial use
   Paste Special and record the format selected. Save the document, quit the Office application,
   reopen it, and inspect the saved file. Record whether the media bytes are identical, whether a
   valid payload is present in changed bytes, or whether it is lost.
2. Repeat after Compress Pictures, recording its settings. Copy the picture back from Office, dump
   every clipboard flavor, and inspect that dump for a recoverable envelope.
3. Repeat for the other host and platform. Record unsupported paste choices and errors instead of
   interpreting them as payload loss.

| Platform | Office build | Host | Carrier | Flavor Office chose | Kept in file (byte-identical / present / lost) | Kept after Compress Pictures | Recoverable by copy-back | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

Office's choice of flavor, recompression threshold, and preservation of ancillary metadata are
measurements to establish, not assumptions made by these tools.

On macOS, write one item with multiple flavors and dump all items with JXA:

```text
osascript -l JavaScript scripts/office-spike/mac-pasteboard.js write packages/fixtures/office/carriers public.png=png-ztxt.png public.svg-image=svg-metadata.svg
osascript -l JavaScript scripts/office-spike/mac-pasteboard.js dump /path/to/dump
```

On Windows, `-Write` accepts an array of `format=file` specifications; `CF_DIBV5` takes a PNG,
`CF_UNICODETEXT` a text file, and `CF_ENHMETAFILE` an EMF. Paths can be absolute.

```powershell
./scripts/office-spike/win-clipboard.ps1 -Write @('PNG=packages/fixtures/office/carriers/png-ztxt.png', 'image/svg+xml=packages/fixtures/office/carriers/svg-metadata.svg')
./scripts/office-spike/win-clipboard.ps1 -Dump C:\temp\office-dump
node scripts/office-spike/inspect.mjs C:\temp\office-dump --json
```

Both clipboard scripts require platform testing before relying on their output.
