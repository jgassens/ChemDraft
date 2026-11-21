#!/usr/bin/env python3
"""Type into a floating toolbar's number field in a Wayland session, then check the result.

The Linux container smoke (.github/workflows/linux-container-smoke.yml) runs this as its
unprivileged user under dbus-run-session, in the Wayland jobs where ChemDraft uses XWayland.
That is the default for both packages: the AppImage's GTK hook exports GDK_BACKEND=x11, and
the .deb picks it itself when WAYLAND_DISPLAY is set. It runs once per compositor:

- --compositor kwin (the click-to-focus gate): a virtual KWin (kwin_wayland --virtual
  --xwayland), as on KDE Plasma. KWin's X window manager honors a client's own focus request,
  so ChemDraft's XSetInputFocus with the click's time decides whether the field gets the keys.
  The field must change. As a user would, the check first clicks the document so ChemDraft is
  in front: like Windows and macOS, ChemDraft gives a palette field the keyboard only when
  ChemDraft had focus at the click, not while another application is in front.
- --compositor weston (the default; setup and accessibility only): headless Weston, which
  cannot test click-to-focus (see below). The field may stay unchanged; the log says so.

The check:

1. starts the compositor with XWayland, then the package with no GDK_BACKEND of its own. Under
   KWin it first writes [Xwayland] XwaylandEisNoPrompt=true to the session's own kwinrc, so
   KWin accepts XWayland's emulated (XTEST) input without its "Remote Control" prompt
   (Session.preauthorize_kwin_input cites the KWin source), and it logs the input path and
   whether that prompt (kwin_eis_prompter) appeared;
2. pastes propane with Edit > Paste and records the document's chemistry with Edit > Select All,
   Edit > Copy As > SMILES and Edit > Copy (the native selection JSON);
3. opens Drawn Structure Settings from View > Toolbars, whose number fields are enabled only
   while a molecule is selected (Select All in step 2 leaves propane selected);
4. under KWin only, clicks an empty canvas area of the document with a real XTEST click, waits
   for the document to have focus, and selects all again (the click clears the selection);
5. finds an enabled number field over AT-SPI (a spin button, or a text entry with a number field's
   label), logging every candidate it saw, then clicks into it with a real XTEST click and types "30";
6. requires the field's value to change and the document's chemistry not to.

Every menu command in steps 2 and 3 is chosen over AT-SPI, not typed. The compositor's X window
manager decides where X keyboard focus goes and can put it back when an X client such as xdotool
moves it, so keyboard shortcuts meant for the document window may land elsewhere or nowhere.
Edit > Paste, Copy and Select All go to whichever ChemDraft window has focus, or to the document
window when none does, so the check first requires that no other ChemDraft window has focus. Only the clicks
and the typing in steps 4 and 5 use XTEST input, because that is what the check tests.

Weston cannot test click-to-focus, so under Weston step 6 checks only the chemistry. Its X
window manager (xwayland/window-manager.c in Weston 16) gives X focus only to the window the
compositor last activated, and resets any other focus change a client makes, ChemDraft's own
XSetInputFocus included. It also ignores _NET_ACTIVE_WINDOW. The compositor activates a window
only on input it sees through a Wayland seat, and headless Weston has no seat unless started
with --fake-seat, while XTEST input stays inside XWayland. So under Weston X focus stays on
Weston's no-focus window (1x1 at -100,-100) whatever the app does.

Under both compositors ChemDraft logs one "[palette-focus] linux-acquire" line per field click
to chemdraft.log, and this script prints those lines, so the log shows how far the app got:
whether the click reached it, whether a ChemDraft window had focus (app-foreground=...) and
when one last lost it (app-focus-lost=...), what its focus gate decided (request=...),
whether it called XSetInputFocus, and the outcome. The script repeats app-foreground for
each line.

Native Wayland (CHEMDRAFT_NATIVE_WAYLAND=1) is not covered. Weston offers no protocol that lets
one client type into another client's window, and xdotool reaches X11 windows only.

Usage: toolbar-field.py [--compositor weston|kwin] <bundle> <appimage|deb> <log directory>
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SOCKET = "chemdraft-field-smoke"
TEXT = "UTF8_STRING"
SELECTION = "application/x-chemdraft-selection+json"
SETTINGS_TITLE = "ChemDraft Drawn Structure Settings"
# Chain angle only sets the angle of chains drawn later, so committing it cannot move atoms.
PREFERRED_FIELD = "Chain angle"
# The <input type="number"> fields on the palette's Structure tab, by their aria-label. They are
# disabled until a molecule, atom, bond or ring is selected (MoleculeInspectorControls in
# apps/desktop/src/ToolPalette.tsx), which Edit > Select All in chemistry() leaves in place.
FIELD_LABELS = ("Chain angle", "Target bond length", "Line width", "Bold width", "Spacing %",
                "Spacing abs.", "Margin width", "Hash spacing", "Double-bond inset")
LOGGED_STATES = ("enabled", "sensitive", "showing", "visible", "editable", "focusable", "focused")
TYPED = "30"
COMPOSITORS = ("weston", "kwin")


class SmokeFailure(Exception):
    pass


# AT-SPI calls raise GLib.Error while a window or webview is still registering.
RETRY = (SmokeFailure,)


def wait_for(check, description, seconds=20.0, interval=0.5):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except RETRY as error:
            if time.monotonic() >= deadline:
                raise SmokeFailure(f"{description} ({error})") from error
            time.sleep(interval)


def run(*command, timeout=5, check=True):
    return subprocess.run(command, capture_output=True, timeout=timeout, check=check)


def keys(*shortcuts):
    run("xdotool", "key", "--clearmodifiers", "--delay", "100", *shortcuts)


def xclip(target):
    return ["xclip", "-selection", "clipboard", "-target", target]


def read_clipboard(target):
    try:
        result = subprocess.run([*xclip(target), "-out"], capture_output=True, timeout=2)
    except subprocess.TimeoutExpired as error:
        raise SmokeFailure(f"xclip timed out reading {target}") from error
    if result.returncode:
        message = result.stderr.decode(errors="replace").strip()
        raise SmokeFailure(f"xclip could not read {target}: {message}")
    return result.stdout


class Session:
    """The compositor, its XWayland display and the package, all torn down together."""

    def __init__(self, bundle, package, logs, compositor="weston"):
        self.bundle = bundle
        self.package = package
        self.logs = logs
        self.compositor = compositor
        # Weston resets every client focus change (see the module docstring), so only KWin
        # can show whether a click on a palette field gives it the keyboard.
        self.tests_focus = compositor == "kwin"
        self.work = Path(tempfile.mkdtemp(prefix="chemdraft-field-"))
        self.server = None
        self.app = None
        self.main_pid = None
        self.prompter_seen = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.app is not None and self.app.poll() is None:
            try:
                os.killpg(self.app.pid, signal.SIGTERM)
                self.app.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.app.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.server is not None and self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
        shutil.rmtree(self.work, ignore_errors=True)

    def start_display(self):
        runtime = self.work / "runtime"
        runtime.mkdir(mode=0o700)
        for name in ("DISPLAY", "WAYLAND_DISPLAY", "GDK_BACKEND", "CHEMDRAFT_NATIVE_WAYLAND",
                     "WEBKIT_DISABLE_DMABUF_RENDERER", "NO_AT_BRIDGE", "AT_SPI_BUS_ADDRESS"):
            os.environ.pop(name, None)
        os.environ["XDG_RUNTIME_DIR"] = str(runtime)
        for name, folder in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                             ("XDG_CACHE_HOME", "cache")):
            (self.work / folder).mkdir()
            os.environ[name] = str(self.work / folder)
        os.environ["RUST_BACKTRACE"] = "1"
        os.environ["CHEMDRAFT_PALETTE_FOCUS_LOG"] = "1"
        display_log = self.logs / "display.log"
        if self.compositor == "kwin":
            ready = self.start_kwin(runtime, display_log)
        else:
            ready = self.start_weston(runtime, display_log)
        name = "KWin" if self.compositor == "kwin" else "Weston"
        os.environ["DISPLAY"] = wait_for(ready, f"{name} and XWayland did not start", seconds=60)
        os.environ["WAYLAND_DISPLAY"] = SOCKET
        print(f"{name} session: WAYLAND_DISPLAY={SOCKET} DISPLAY={os.environ['DISPLAY']}",
              flush=True)

    def start_weston(self, runtime, display_log):
        self.server = subprocess.Popen(
            ["weston", "--backend=headless", "--renderer=pixman", "--shell=kiosk-shell.so",
             "--xwayland", f"--socket={SOCKET}", "--idle-time=0", "--width=1920", "--height=1080"],
            stdout=display_log.open("wb"), stderr=subprocess.STDOUT)

        def ready():
            self.server_alive()
            found = re.findall(r"xserver listening on display (:\d+)",
                               display_log.read_text(errors="replace"))
            if not (runtime / SOCKET).is_socket() or not found:
                raise SmokeFailure("no Wayland socket or XWayland display yet")
            return found[-1]

        return ready

    def start_kwin(self, runtime, display_log):
        """A virtual KWin with XWayland. KWin picks the X display itself and passes it in
        DISPLAY to the programs named on its command line, so one of those reports it."""
        reported = self.work / "x-display"
        helper = self.work / "report-display.sh"
        helper.write_text("#!/bin/sh\n"
                          f"printf '%s\\n' \"$DISPLAY\" > '{reported}.tmp' && "
                          f"mv '{reported}.tmp' '{reported}'\n"
                          "exec sleep 86400\n")
        helper.chmod(0o755)
        self.preauthorize_kwin_input()
        # QPainter compositing needs no GPU or EGL device in the container.
        environment = {**os.environ, "KWIN_COMPOSE": "Q"}
        self.server = subprocess.Popen(
            ["kwin_wayland", "--virtual", "--xwayland", f"--socket={SOCKET}", "--width=1920",
             "--height=1080", "--no-lockscreen", "--no-global-shortcuts", str(helper)],
            stdout=display_log.open("wb"), stderr=subprocess.STDOUT, env=environment)

        def ready():
            self.server_alive()
            display = reported.read_text().strip() if reported.exists() else ""
            if not (runtime / SOCKET).is_socket() or not display:
                raise SmokeFailure("no Wayland socket or XWayland display yet")
            return display

        return ready

    def preauthorize_kwin_input(self):
        """Let XWayland's emulated input through KWin without the "Remote Control" prompt.

        KWin 6 hands XWayland a libei socket (LIBEI_SOCKET, src/plugins/eis/eisbackend.cpp:57
        in v6.7.4, :58 in v6.8.3), and XWayland sends XTEST input, such as xdotool's, through
        it. When XWayland connects, XWaylandEisContext::connectionRequested
        (src/plugins/eis/xwaylandeiscontext.cpp:42 in v6.7.4, :46 in v6.8.3) accepts it at
        once if options->xwaylandEisNoPrompt() is true or the client name is listed in
        xwaylandEisNoPromptApps(). Otherwise it starts kwin_eis_prompter, the "Remote Control"
        window, and holds every emulated event until someone presses Allow. Both settings are
        kwinrc entries in group [Xwayland] (src/kwin.kcfg:328 and :352-355, default false in
        both versions), read at startup (src/options.cpp:739-740 in v6.7.4, :743-744 in
        v6.8.3) from the kwinrc that KSharedConfig finds under XDG_CONFIG_HOME
        (src/main.cpp:84 in v6.7.4, :86 in v6.8.3). start_display points XDG_CONFIG_HOME at
        this session's own folder, so this changes only the throwaway session.
        """
        kwinrc = Path(os.environ["XDG_CONFIG_HOME"]) / "kwinrc"
        kwinrc.write_text("[Xwayland]\nXwaylandEisNoPrompt=true\n")
        print(f"KWin input emulation pre-authorized: wrote [Xwayland] XwaylandEisNoPrompt=true "
              f"to {kwinrc}, so XWayland's XTEST input should not raise kwin_eis_prompter",
              flush=True)

    def report_input_path(self, moment):
        """Under KWin, log how XTEST input reaches the compositor and whether KWin's input
        emulation prompt (kwin_eis_prompter, the "Remote Control" window) is up."""
        if self.compositor != "kwin":
            return
        try:
            xwayland = []
            prompters = []
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    command = (entry / "cmdline").read_bytes().split(b"\0")
                    name = os.path.basename(command[0].decode(errors="replace"))
                    if name == "Xwayland":
                        environ = (entry / "environ").read_bytes().split(b"\0")
                        xwayland.append((entry.name, any(item.startswith(b"LIBEI_SOCKET=")
                                                         for item in environ)))
                    elif name == "kwin_eis_prompter":
                        prompters.append(entry.name)
                except (OSError, IndexError):
                    continue
            windows = (diag("xdotool", "search", "--classname", "kwin_eis_prompter") or "").split()
            windows = [window for window in windows if window.isdigit()]
            if prompters or windows:
                self.prompter_seen = True
            if not xwayland:
                path = "unknown (no Xwayland process found)"
            elif any(libei for _, libei in xwayland):
                path = ("XTEST from xdotool -> XWayland -> libei (LIBEI_SOCKET from KWin) -> "
                        "KWin's XWayland EIS context")
            else:
                path = "XTEST from xdotool, handled inside XWayland (no LIBEI_SOCKET, no libei)"
            print(f"KWin input path {moment}: {path}; Xwayland pids "
                  f"{[pid for pid, _ in xwayland]}; kwin_eis_prompter processes {prompters}, "
                  f"windows {windows}; prompter seen this run: "
                  f"{'yes' if self.prompter_seen else 'no'}", flush=True)
        except Exception as error:  # diagnostics must never fail the run
            print(f"KWin input path {moment}: unknown ({error})", flush=True)

    def server_alive(self):
        if self.server.poll() is not None:
            raise SmokeFailure(f"{self.compositor} exited with status {self.server.returncode}")

    def launch(self):
        command = [self.bundle]
        if self.package == "appimage":
            command.append("--appimage-extract-and-run")
        self.app = subprocess.Popen(command, stdout=(self.logs / "chemdraft.log").open("wb"),
                                    stderr=subprocess.STDOUT, start_new_session=True)

        def main_pid():
            self.alive()
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    if ((entry / "comm").read_text().strip() == "chemdraft"
                            and os.getsid(int(entry.name)) == self.app.pid):
                        return int(entry.name)
                except (OSError, ValueError):
                    continue
            raise SmokeFailure("no chemdraft process in the launch session yet")

        self.main_pid = wait_for(main_pid, "ChemDraft did not start", seconds=60, interval=1)
        environment = (Path("/proc") / str(self.main_pid) / "environ").read_bytes().split(b"\0")

        def uses_xwayland():
            if (b"GDK_BACKEND=x11" in environment
                    or "ChemDraft GTK backend default: GDK_BACKEND=x11" in
                    (self.logs / "chemdraft.log").read_text(errors="replace")):
                return True
            raise SmokeFailure("no GDK_BACKEND=x11 in its environment or log")

        wait_for(uses_xwayland, "ChemDraft did not choose XWayland in the Wayland session",
                 seconds=10)

    def alive(self):
        if self.app.poll() is not None:
            raise SmokeFailure(f"ChemDraft exited with status {self.app.returncode}")
        self.server_alive()

    def window(self, title):
        """The visible X11 window with this exact title that belongs to the launch."""
        self.alive()
        result = run("xdotool", "search", "--onlyvisible", "--name", f"^{re.escape(title)}$",
                     check=False)
        for window in result.stdout.decode().split():
            owner = run("xdotool", "getwindowpid", window, check=False)
            try:
                if os.getsid(int(owner.stdout.decode().strip())) == self.app.pid:
                    return window
            except (ValueError, ProcessLookupError):
                continue
        raise SmokeFailure(f"no visible {title!r} window")

    def document_window(self):
        """The visible X11 document window of the launch: class chemdraft, not transient.

        The document title follows the active tab, so it is found by WM_CLASS and by not being
        a transient palette or dialog, never by its title.
        """
        self.alive()
        result = run("xdotool", "search", "--onlyvisible", "--class", "chemdraft", check=False)
        for window in result.stdout.decode().split():
            owner = run("xdotool", "getwindowpid", window, check=False)
            try:
                if os.getsid(int(owner.stdout.decode().strip())) != self.app.pid:
                    continue
            except (ValueError, ProcessLookupError):
                continue
            transient = run("xprop", "-id", window, "WM_TRANSIENT_FOR", check=False)
            if "window id" in transient.stdout.decode(errors="replace"):
                continue
            return window
        raise SmokeFailure("no visible ChemDraft document window")


SENTINEL = b"chemdraft-smoke-sentinel"


def host_clipboard(data):
    # xclip forks a selection owner. Keep its file descriptors off the harness log pipe.
    subprocess.run([*xclip(TEXT), "-in"], input=data, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=5)

    def claimed():
        if read_clipboard(TEXT) != data:
            raise SmokeFailure("the X11 clipboard still has other text")

    wait_for(claimed, "Host xclip did not claim the clipboard", seconds=3)


def copied(target):
    """Wait for ChemDraft to replace the host's sentinel, so a stale copy never passes."""
    def check():
        data = read_clipboard(target)
        if data == SENTINEL:
            raise SmokeFailure("the clipboard still holds the host sentinel")
        return data

    return wait_for(check, f"ChemDraft did not copy {target}", seconds=5)


def chemistry(Atspi, pid):
    """The whole document's SMILES and a summary of its native selection JSON."""
    choose(Atspi, pid, "Edit", "Select All")
    host_clipboard(SENTINEL)
    choose(Atspi, pid, "Edit", "Copy As", "SMILES")
    smiles = copied(TEXT)
    host_clipboard(SENTINEL)
    choose(Atspi, pid, "Edit", "Copy")
    try:
        payload = json.loads(copied(SELECTION))
        objects = [
            (item["type"], sorted(str(atom.get("element", "")) for atom in item.get("atoms", [])),
             sorted(str(bond.get("order", "")) for bond in item.get("bonds", [])))
            for item in payload["objects"]
        ]
    except (KeyError, TypeError, ValueError) as error:
        raise SmokeFailure(f"invalid ChemDraft selection JSON: {error}") from error
    return smiles, sorted(objects)


def paste_propane(session, Atspi, document):
    require_document_focus(session, Atspi, document)
    host_clipboard(b"C-C-C")
    # Paste once: a retried paste could add a second propane.
    choose(Atspi, session.main_pid, "Edit", "Paste")

    def pasted():
        session.alive()
        smiles, summary = chemistry(Atspi, session.main_pid)
        if smiles != b"CCC":
            raise SmokeFailure(f"Copy As SMILES read {smiles[:120]!r}")
        return smiles, summary

    return wait_for(pasted, "Pasting propane into the document failed", seconds=30)


def atspi():
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    global RETRY
    RETRY = (SmokeFailure, GLib.Error)
    Atspi.set_timeout(1000, 1000)
    return Atspi


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield child


def application(Atspi, pid):
    desktop = Atspi.get_desktop(0)
    if desktop is None:
        raise SmokeFailure("the AT-SPI desktop is unavailable")
    app = next((child for child in children(desktop) if child.get_process_id() == pid), None)
    if app is None:
        raise SmokeFailure(f"process {pid} never registered with AT-SPI")
    return app


def named_child(node, name):
    for child in children(node):
        if child.get_name() == name:
            return child
    raise SmokeFailure(f"missing {name!r} in the accessibility tree")


def find_menu_bar(Atspi, node):
    stack = [node]
    while stack:
        node = stack.pop()
        if node.get_role() == Atspi.Role.MENU_BAR:
            return node
        stack.extend(children(node))
    return None


def document_frame(Atspi, pid, window=None):
    """The document's top-level frame: the only one with a native menu bar, never found by title.

    The title follows the active tab. Palettes and dialogs carry no menu bar. When several frames
    have one, the X window the harness found (class chemdraft, not transient) picks by its title.
    """
    frames = [frame for frame in children(application(Atspi, pid))
              if frame.get_role() == Atspi.Role.FRAME and find_menu_bar(Atspi, frame) is not None]
    if not frames:
        raise SmokeFailure("the document has no accessible native menu bar")
    if window is not None:
        x_title = run("xdotool", "getwindowname", window, check=False).stdout.decode(
            errors="replace").strip()
        matching = [frame for frame in frames if frame.get_name() == x_title]
        if len(matching) == 1:
            return matching[0]
    if len(frames) != 1:
        names = [frame.get_name() for frame in frames]
        raise SmokeFailure(f"{len(frames)} frames have menu bars {names!r}; none unique")
    return frames[0]


def non_document_windows(Atspi, pid, window):
    """The titles of the focused ChemDraft windows other than the document."""
    document = document_frame(Atspi, pid, window).get_name()
    return [name for name in active_windows(Atspi, pid) if name != document]


def menu_item(Atspi, pid, *path):
    """The document window's native menu item at this path, such as Edit > Copy As > SMILES."""
    stack = [document_frame(Atspi, pid)]
    while stack:
        node = stack.pop()
        if node.get_role() == Atspi.Role.MENU_BAR:
            for name in path:
                node = named_child(node, name)
            return node
        stack.extend(children(node))
    raise SmokeFailure("the document has no accessible native menu bar")


def choose(Atspi, pid, *path):
    """Choose a native menu item over AT-SPI, as a click on it would, with no keyboard focus."""
    label = " > ".join(path)

    def enabled():
        item = menu_item(Atspi, pid, *path)
        if not item.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise SmokeFailure(f"{label} is disabled")
        return item

    item = wait_for(enabled, f"{label} was not available", seconds=10)
    # Act once, never in a retry loop: a repeated Paste adds a second structure, and a
    # repeated toggle closes the toolbar it opened.
    try:
        acted = Atspi.Action.do_action(item, 0)
    except RETRY as error:
        raise SmokeFailure(f"Choosing {label} failed: {error}") from error
    if not acted:
        raise SmokeFailure(f"{label} refused its action")


def active_windows(Atspi, pid):
    """The titles of the ChemDraft windows GTK reports as focused."""
    return [child.get_name() for child in children(application(Atspi, pid))
            if child.get_state_set().contains(Atspi.StateType.ACTIVE)]


def report_focus(Atspi, pid, moment):
    focus = run("xdotool", "getwindowfocus", check=False)
    window = focus.stdout.decode().strip() or focus.stderr.decode(errors="replace").strip()
    name = ""
    if focus.returncode == 0 and window.isdigit():
        name = run("xdotool", "getwindowname", window, check=False).stdout.decode(
            errors="replace").strip()
    try:
        active = active_windows(Atspi, pid)
    except RETRY as error:
        active = f"unknown ({error})"
    print(f"Focus {moment}: X input focus {window} {name!r}; focused ChemDraft windows {active}",
          flush=True)


def require_document_focus(session, Atspi, document):
    """Edit > Paste, Copy and Select All follow the focused ChemDraft window, if there is one."""
    # Under Openbox and KWin this hands the document the focus. Weston's X window manager may
    # undo it.
    run("xdotool", "windowfocus", document, check=False)

    def document_or_none():
        session.alive()
        others = non_document_windows(Atspi, session.main_pid, document)
        if others:
            raise SmokeFailure(f"{others} has focus, so Edit menu commands would go there")

    try:
        wait_for(document_or_none, "Another ChemDraft window kept the focus from the document",
                 seconds=10)
    finally:
        report_focus(Atspi, session.main_pid, "before the Edit menu commands")


# Points to try for an empty canvas click, as fractions of the document window. Propane is
# pasted near the middle; the menu bar is at the top. The first point whose X window is the
# document itself (not a palette over it) is used.
CANVAS_POINTS = ((0.85, 0.8), (0.15, 0.8), (0.85, 0.35), (0.15, 0.35), (0.5, 0.88))


def window_geometry(window):
    shell = run("xdotool", "getwindowgeometry", "--shell", window).stdout.decode()
    values = dict(line.split("=", 1) for line in shell.split() if "=" in line)
    return int(values["X"]), int(values["Y"]), int(values["WIDTH"]), int(values["HEIGHT"])


def click_document(session, Atspi, document):
    """Give the document focus the way a user does: click an empty area of its canvas.

    ChemDraft gives a palette field the keyboard only when ChemDraft had focus at the click,
    as on Windows and macOS, so the field click must come from a ChemDraft in front. The click
    is a real XTEST press on empty canvas with the Select tool (the startup tool), which adds
    nothing and only clears the selection; the caller selects all again. If KWin does not
    focus the document on that click within a few seconds, the check asks for it with
    xdotool windowfocus and says so, so the field click still starts from a focused document.
    """
    left, top, width, height = window_geometry(document)
    tried = []
    for fx, fy in CANVAS_POINTS:
        x, y = left + int(width * fx), top + int(height * fy)
        location = move_pointer(session, x, y)
        tried.append(f"{x},{y} -> window {location.get('WINDOW')}")
        if pointer_at(location, x, y) and location.get("WINDOW") == document:
            break
    else:
        raise SmokeFailure(f"no uncovered canvas point in the document window: {'; '.join(tried)}")
    print(f"Clicking the document canvas at {x},{y} to bring ChemDraft to the front", flush=True)
    run("xdotool", "click", "1")

    def document_focused():
        session.alive()
        active = active_windows(Atspi, session.main_pid)
        if len(active) != 1 or non_document_windows(Atspi, session.main_pid, document):
            raise SmokeFailure(f"focused ChemDraft windows {active}")

    try:
        wait_for(document_focused, "The document did not take focus on a click", seconds=5,
                 interval=0.2)
        how = "the click"
    except SmokeFailure as error:
        print(f"{error}; asking for it with xdotool windowfocus", flush=True)
        run("xdotool", "windowfocus", document, check=False)
        wait_for(document_focused, "The document did not take focus", seconds=10, interval=0.2)
        how = "xdotool windowfocus after the click"
    report_focus(Atspi, session.main_pid, f"after focusing the document by {how}")
    # The click on empty canvas cleared the selection that enables the settings fields.
    choose(Atspi, session.main_pid, "Edit", "Select All")


def open_settings_toolbar(Atspi, pid):
    item = wait_for(lambda: menu_item(Atspi, pid, "View", "Toolbars", "Drawn Structure Settings"),
                    "View > Toolbars > Drawn Structure Settings is missing")
    if not item.get_state_set().contains(Atspi.StateType.CHECKED):
        choose(Atspi, pid, "View", "Toolbars", "Drawn Structure Settings")


def describe(Atspi, node, depth):
    """One line per accessible: role, name, owning process, child count and the states we use."""
    states = node.get_state_set()
    flags = " ".join(name for name in LOGGED_STATES
                     if states.contains(getattr(Atspi.StateType, name.upper())))
    line = (f"{'  ' * depth}{node.get_role_name()} {node.get_name()!r} "
            f"pid={node.get_process_id()} children={node.get_child_count()} [{flags}]")
    if not node.get_name() and node.get_child_count() == 0:
        # Unnamed leaves are mostly static text, such as "1 molecule" or "No molecule" in the
        # palette's target row, which shows whether the selection reached it.
        try:
            if "Text" in node.get_interfaces():
                text = Atspi.Text.get_text(node, 0, min(60, Atspi.Text.get_character_count(node)))
                if text.strip():
                    line += f" text={text.strip()!r}"
        except RETRY:
            pass
    return line


# The last complete scan of the settings window, printed when no field is found.
LAST_SCAN = {"outline": [], "candidates": []}


def number_field(Atspi, pid):
    """The settings toolbar's preferred enabled number field, or any other one.

    WebKitGTK exposes <input type="number"> as a spin button whose name is its aria-label.
    Older builds expose it as a text entry, so an entry counts when its name is one of the
    palette's number field labels. A field is usable when it is enabled or sensitive; WebKit
    sets both on an enabled control and neither on a disabled one.
    """
    window = named_child(application(Atspi, pid), SETTINGS_TITLE)
    # libatspi caches child lists and state sets. The palette's web content renders disabled
    # fields first and enables them when the main window sends its selection, so drop the
    # cache before every scan rather than read a stale "disabled" or an empty subtree.
    window.clear_cache()
    roles = (Atspi.Role.SPIN_BUTTON, Atspi.Role.ENTRY)
    fields = []
    outline = []
    candidates = []
    stack = [(window, 0)]
    visited = 0
    while stack and visited < 5000:
        node, depth = stack.pop()
        visited += 1
        line = describe(Atspi, node, depth)
        if len(outline) < 400:
            outline.append(line)
        role = node.get_role()
        name = node.get_name()
        if role in roles or name in FIELD_LABELS:
            candidates.append(line.strip())
            states = node.get_state_set()
            usable = (states.contains(Atspi.StateType.ENABLED)
                      or states.contains(Atspi.StateType.SENSITIVE))
            # The AppImage's WebKit reports the same fields with the role "embedded" (the .deb
            # from the same build reports "entry"). Its exact label and the editable state still
            # identify a number field; type_into_field logs the odd role.
            labelled = name in FIELD_LABELS and states.contains(Atspi.StateType.EDITABLE)
            if usable and (role == Atspi.Role.SPIN_BUTTON
                           or (role == Atspi.Role.ENTRY and name in FIELD_LABELS) or labelled):
                fields.append(node)
        stack.extend((child, depth + 1) for child in reversed(list(children(node))))
    LAST_SCAN["outline"] = outline
    LAST_SCAN["candidates"] = candidates
    if not fields:
        raise SmokeFailure(f"{SETTINGS_TITLE!r} shows no enabled number field "
                           f"({visited} accessibles, {len(candidates)} candidates)")
    fields.sort(key=lambda node: (node.get_name() != PREFERRED_FIELD,
                                  not node.get_state_set().contains(Atspi.StateType.SHOWING),
                                  node.get_role() not in roles))
    return fields[0]


def print_scan(title, lines):
    print(title, flush=True)
    for line in lines or ["(none)"]:
        print(f"  {line}", flush=True)


def field_value(Atspi, field):
    try:
        return Atspi.Text.get_text(field, 0, Atspi.Text.get_character_count(field))
    except Exception:  # noqa: BLE001 - WebKit may expose only the Value interface.
        return str(Atspi.Value.get_current_value(field))


def pointer():
    location = run("xdotool", "getmouselocation", "--shell").stdout.decode()
    return dict(line.split("=", 1) for line in location.split() if "=" in line)


def pointer_at(location, x, y):
    return (abs(int(location.get("X", -1)) - x) <= 1 and abs(int(location.get("Y", -1)) - y) <= 1)


def move_pointer(session, x, y):
    """Move the X pointer to x,y, retrying briefly; return where it ended up.

    On Fedora the pointer once stayed at XWayland's starting point (the screen centre) after
    the first move of the run, while the same XWayland version on Debian moved it. XWayland
    routes XTEST through libei when it can and logs "[xwayland ei]" to display.log when that
    setup fails, so the first request may be lost while that setup is in flight. Repeat the
    move after short waits, then try a relative XTEST move, the path the click itself takes.
    The caller still requires the pointer to reach x,y.
    """
    seen = []
    for wait in (0.2, 0.5, 1.0):
        run("xdotool", "mousemove", str(x), str(y))
        time.sleep(wait)
        location = pointer()
        seen.append(f"{location.get('X')},{location.get('Y')}")
        if pointer_at(location, x, y):
            break
    else:
        dx = x - int(location.get("X", x))
        dy = y - int(location.get("Y", y))
        run("xdotool", "mousemove_relative", "--", str(dx), str(dy))
        time.sleep(0.5)
        location = pointer()
        seen.append(f"relative {dx},{dy} -> {location.get('X')},{location.get('Y')}")
    if len(seen) > 1:
        print(f"Moving the pointer to {x},{y} took {len(seen)} tries: {'; '.join(seen)}",
              flush=True)
        ei = [line for line in (session.logs / "display.log").read_text(errors="replace")
              .splitlines() if "xwayland ei" in line.lower()]
        print_scan("XWayland libei lines in display.log:", ei)
        session.report_input_path("after a slow pointer move")
    return location


def acquire_field(line, name):
    found = re.search(rf"\b{re.escape(name)}=(\S+)", line)
    return found.group(1) if found else "absent"


def report_app_focus_log(session):
    """Print ChemDraft's one-line diagnostics for each field acquisition, then the focus gate's
    inputs and verdict from each line: whether a ChemDraft window had focus when the request
    ran (app-foreground), when one last lost it relative to the press (app-focus-lost), the
    request and the outcome."""
    try:
        lines = [line for line in (session.logs / "chemdraft.log").read_text(errors="replace")
                 .splitlines() if "[palette-focus] linux-acquire" in line]
    except OSError as error:
        print_scan("ChemDraft field acquisitions (chemdraft.log):",
                   [f"chemdraft.log unreadable: {error}"])
        return
    print_scan("ChemDraft field acquisitions (chemdraft.log):",
               lines or ["none: this build may predate the diagnostic, or no click reached it"])
    print_scan("Focus gate per acquisition:",
               [" ".join(f"{name}={acquire_field(line, name)}" for name in
                         ("app-foreground", "app-focus-lost", "request", "outcome"))
                for line in lines])


def diag(*command):
    """Run a diagnostic command; never raises. Returns output text, or None when the tool is missing."""
    try:
        result = run(*command, check=False)
    except FileNotFoundError:
        return None
    except Exception as error:  # diagnostics must never fail the run
        return f"error: {error}"
    return result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace")


def window_id(value):
    try:
        return int(str(value).strip(), 0)
    except ValueError:
        return None


def describe_x_window(label, value):
    """Log id, names, class, pid, map state and absolute geometry of one X window; return its parent."""
    number = window_id(value)
    if number is None:
        print(f"  [{label}] window {value!r}: not a window id", flush=True)
        return None
    info = diag("xwininfo", "-id", str(number))
    tree = diag("xwininfo", "-tree", "-id", str(number))
    props = diag("xprop", "-id", str(number), "WM_NAME", "_NET_WM_NAME", "WM_CLASS", "_NET_WM_PID")
    print(f"  [{label}] window {number} (0x{number:x})", flush=True)
    if info is None or props is None:
        print(f"    tool missing: {'xwininfo ' if info is None else ''}{'xprop' if props is None else ''}"
              .rstrip(), flush=True)
    if props:
        for line in props.strip().splitlines():
            print(f"    {line}", flush=True)
    if info:
        for line in info.splitlines():
            if any(key in line for key in ("Absolute upper-left", "Width:", "Height:", "Map State",
                                           "Override Redirect", "xwininfo:")):
                print(f"    {line.strip()}", flush=True)
    if info is None:
        geometry = diag("xdotool", "getwindowgeometry", str(number))
        print(f"    xdotool geometry (xwininfo unavailable): {geometry!r}", flush=True)
    if props is None and info is None:
        print(f"    xdotool name: {diag('xdotool', 'getwindowname', str(number))!r}", flush=True)
    parent = None
    if tree:
        found = re.search(r"Parent window id: (0x[0-9a-fA-F]+)", tree)
        if found:
            parent = int(found.group(1), 16)
    return parent


def describe_x_ancestry(label, value):
    number = window_id(value)
    seen = set()
    depth = 0
    while number and number not in seen and depth < 12:
        seen.add(number)
        number = describe_x_window(f"{label} ancestor {depth}" if depth else label, number)
        depth += 1


def log_x_state(moment, point=None, settings=None):
    """Log the window under the pointer (with ancestry), the palette window and the focus window."""
    try:
        print(f"X diagnostics {moment}:", flush=True)
        location = diag("xdotool", "getmouselocation", "--shell") or ""
        fields = dict(line.split("=", 1) for line in location.split() if "=" in line)
        print(f"  pointer at {fields.get('X')},{fields.get('Y')}"
              + (f"; click point {point[0]},{point[1]}" if point else ""), flush=True)
        describe_x_ancestry("under pointer", fields.get("WINDOW"))
        if settings:
            describe_x_ancestry("palette", settings)
        focus = (diag("xdotool", "getwindowfocus") or "").strip()
        print(f"  X focus window {focus!r}", flush=True)
        describe_x_ancestry("focus", focus)
    except Exception as error:  # diagnostics must never fail the run
        print(f"  X diagnostics failed: {error}", flush=True)


def type_into_field(session, Atspi, settings):
    try:
        field = wait_for(lambda: number_field(Atspi, session.main_pid),
                         f"No enabled number field in {SETTINGS_TITLE}", seconds=30)
    except SmokeFailure:
        print_scan("Number field candidates in the last scan (role, name, process, states):",
                   LAST_SCAN["candidates"])
        print_scan(f"{SETTINGS_TITLE} accessibility tree in the last scan:", LAST_SCAN["outline"])
        raise
    print_scan("Number field candidates (role, name, process, states):", LAST_SCAN["candidates"])
    name = field.get_name()
    role = field.get_role_name()
    if field.get_role() not in (Atspi.Role.SPIN_BUTTON, Atspi.Role.ENTRY):
        print(f"Warning: {name!r} has the AT-SPI role {role!r}, not spin button or entry; "
              "it was chosen by its label and editable state", flush=True)
        distro = os.environ.get("DISTRO")
        distro_text = f" on {distro}" if distro else ""
        print("::warning title=AppImage accessibility::"
              f"The {session.package} package{distro_text} reports the toolbar number field "
              f"{name!r} with the AT-SPI role {role!r}; the .deb reports 'entry'. "
              "This may be an accessibility regression", flush=True)
    before = field_value(Atspi, field)
    extents = Atspi.Component.get_extents(field, Atspi.CoordType.SCREEN)
    if extents.width <= 4 or extents.height <= 4:
        raise SmokeFailure(f"the {name!r} field has no usable screen extents ({extents.width}x{extents.height})")
    # Click left of center, clear of the spin arrows at the right edge.
    x = extents.x + max(3, extents.width // 4)
    y = extents.y + extents.height // 2
    print(f"Clicking {name!r} (value {before!r}) at {x},{y}", flush=True)
    location = move_pointer(session, x, y)
    print(f"AT-SPI extents of {name!r} (screen): x={extents.x} y={extents.y} "
          f"w={extents.width} h={extents.height}; click point {x},{y}", flush=True)
    log_x_state("before clicking", (x, y), settings)
    if not pointer_at(location, x, y):
        raise SmokeFailure(f"XWayland did not move the X pointer to {x},{y}: {location}")
    if location.get("WINDOW") != settings:
        raise SmokeFailure(f"window {location.get('WINDOW')} covers the field, not {settings}")
    run("xdotool", "click", "1")
    log_x_state("after clicking", (x, y), settings)
    report_focus(Atspi, session.main_pid, f"after clicking {name!r}")

    def focused():
        if not field.get_state_set().contains(Atspi.StateType.FOCUSED):
            raise SmokeFailure("the field is not focused")

    try:
        wait_for(focused, f"The {name!r} field did not take focus", seconds=5, interval=0.2)
    except SmokeFailure as error:
        print(f"{error}; typing anyway to record where the keys go", flush=True)
    run("xdotool", "type", "--delay", "150", TYPED)

    def changed():
        after = field_value(Atspi, field)
        if after == before or TYPED not in after:
            raise SmokeFailure(f"value {before!r} became {after!r}")
        return after

    try:
        after = wait_for(changed, f"Typing {TYPED!r} did not reach the {name!r} field",
                         seconds=5)
    except SmokeFailure as error:
        if session.tests_focus:
            raise SmokeFailure(f"{error}; the linux-acquire lines above show why") from error
        # Weston resets ChemDraft's focus request, so this is expected there. Record it
        # without failing; the chemistry check that follows still applies.
        print(f"::notice title=Weston cannot test click-to-focus::{error}. Weston's X window "
              "manager resets client focus changes; the KWin check is the focus gate",
              flush=True)
        after = None
    finally:
        report_app_focus_log(session)
        session.report_input_path("after typing")
    if after is not None:
        print(f"Typing {TYPED!r} changed {name!r} from {before!r} to {after!r}", flush=True)
    # Discard any draft so no setting is committed.
    keys("Escape")
    return after is not None


def main(bundle, package, logs, compositor):
    logs.mkdir(parents=True, exist_ok=True)
    with Session(bundle, package, logs, compositor) as session:
        session.start_display()
        session.launch()
        document = wait_for(lambda: session.document_window(),
                            "No ChemDraft document window appeared", seconds=60, interval=1)
        wait_for(lambda: session.window("ChemDraft Main Toolbar"),
                 "The Main Toolbar window did not appear", seconds=30, interval=1)
        Atspi = atspi()
        report_focus(Atspi, session.main_pid, "after startup")
        session.report_input_path("after startup")
        before = paste_propane(session, Atspi, document)
        print(f"Document before typing: {before[0].decode()} {before[1]}", flush=True)

        open_settings_toolbar(Atspi, session.main_pid)
        settings = wait_for(lambda: session.window(SETTINGS_TITLE),
                            f"The {SETTINGS_TITLE} window did not appear", seconds=30)
        if session.tests_focus:
            # Bring ChemDraft to the front first, as a user would: a field click while no
            # ChemDraft window has focus leaves the keys with the other application.
            click_document(session, Atspi, document)
        typed = type_into_field(session, Atspi, settings)

        session.alive()
        time.sleep(0.5)
        require_document_focus(session, Atspi, document)
        after = chemistry(Atspi, session.main_pid)
        print(f"Document after typing: {after[0].decode()} {after[1]}", flush=True)
        if after != before:
            raise SmokeFailure(f"the document's chemistry changed from {before} to {after}")
        session.alive()
    if typed:
        print(f"Under {compositor}, typing into a toolbar number field changed the field and left "
              "the chemistry alone.", flush=True)
    else:
        print(f"Under {compositor}, the toolbar number field did not take the keys (expected: "
              "Weston cannot test click-to-focus) and the chemistry was left alone.", flush=True)


def arguments(argv):
    parser = argparse.ArgumentParser(usage=__doc__.rsplit("Usage: ", 1)[1].strip())
    parser.add_argument("--compositor", choices=COMPOSITORS, default="weston")
    parser.add_argument("bundle")
    parser.add_argument("package", choices=("appimage", "deb"))
    parser.add_argument("logs", type=Path)
    return parser.parse_args(argv)


if __name__ == "__main__":
    options = arguments(sys.argv[1:])
    try:
        main(options.bundle, options.package, options.logs, options.compositor)
    except Exception as error:  # noqa: BLE001 - report every failure as one annotation.
        sys.exit(f"::error::Toolbar number field check failed: {type(error).__name__}: {error}")
