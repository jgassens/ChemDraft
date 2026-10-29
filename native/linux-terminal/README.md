# Linux sign-in terminal

ChemDraft opens external-tool sign-in in a visible PTY. The Linux Flatpak carries
a small `st` terminal beside the application, so sign-in does not need permission
to execute host processes or depend on a host terminal outside the sandbox.
The helper executes only the fixed host-owned login script for the selected tool.
Authentication remains manual; no login is performed during installation.

Source: [st 0.9.3](https://st.suckless.org/), released 2025-08-09.
Archive: `https://dl.suckless.org/st/st-0.9.3.tar.gz`.
SHA-256: `9ed9feabcded713d4ded38c8cebf36a3b08f0042ef7934a0e2b2409da56e649b`.
License: MIT/X Consortium; the complete upstream notice is in `LICENSE`.

Build after initializing the GNOME SDK 49 directory used by the Flatpak build:

```bash
node scripts/build-linux-terminal.mjs
```

Output: `native/linux-terminal/build/chemdraft-terminal`, installed at
`/app/bin/chemdraft-terminal`. Source archives and generated code remain ignored.
The only configuration changes use the standard `xterm-256color` terminfo and
the runtime's monospace font. It links the runtime's X11, Xft, fontconfig and
freetype libraries. Copy `LICENSE` into the distribution's third-party notices.

Use Ctrl+Shift+V to paste into the sign-in terminal. The host-owned script keeps
the window open after login finishes or fails until Enter is pressed, and removes
its private temporary script on exit. A normal desktop build without the bundled
helper searches known terminal emulators; a Flatpak missing its helper reports an
installation error instead of requesting host execution permission.
