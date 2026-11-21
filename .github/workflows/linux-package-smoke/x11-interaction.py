"""Check the packaged app's native menu and clipboard on the smoke job's private X server."""

import json
from pathlib import Path
import subprocess
import sys
import time


class SmokeFailure(Exception):
    pass


def wait_for(check, description, seconds=20):
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except SmokeFailure as error:
            if time.monotonic() >= deadline:
                raise SmokeFailure(f"{description} ({error})") from error
            time.sleep(0.5)


def check_toolbars_menu(pid, window):
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib

    def children(node):
        for index in range(node.get_child_count()):
            child = node.get_child_at_index(index)
            if child is not None:
                yield child

    def named_child(node, name):
        for child in children(node):
            if child.get_name() == name:
                return child
        raise SmokeFailure(f"missing {name!r} in the GTK accessibility tree")

    def menu_bar(node):
        role = node.get_role()
        if role == Atspi.Role.MENU_BAR:
            return node
        if role in (Atspi.Role.FRAME, Atspi.Role.FILLER, Atspi.Role.PANEL):
            for child in children(node):
                bar = menu_bar(child)
                if bar is not None:
                    return bar
        return None

    def check():
        try:
            desktop = Atspi.get_desktop(0)
            if desktop is None:
                raise SmokeFailure("the AT-SPI desktop is unavailable")
            app = next((child for child in children(desktop) if child.get_process_id() == pid), None)
            if app is None:
                raise SmokeFailure(f"process {pid} never registered with AT-SPI")
            # The document title follows the active tab, so find the document frame by role: it is
            # the only ChemDraft toplevel with a GTK menu bar. Palettes carry no menu bar.
            frames = [(frame, menu_bar(frame)) for frame in children(app) if frame.get_role() == Atspi.Role.FRAME]
            frames = [(frame, bar) for frame, bar in frames if bar is not None]
            if not frames:
                raise SmokeFailure("no ChemDraft frame has an accessible native menu bar")
            # Cross-check against the X window the harness found by WM_CLASS and transient state.
            x_title = subprocess.run(["xdotool", "getwindowname", window], capture_output=True,
                                     text=True, timeout=5).stdout.strip()
            matching = [(frame, bar) for frame, bar in frames if frame.get_name() == x_title]
            if len(matching) == 1:
                frames = matching
            elif len(frames) != 1:
                names = [frame.get_name() for frame, _ in frames]
                raise SmokeFailure(f"{len(frames)} frames have menu bars {names!r}; none unique for X window {x_title!r}")
            frame, bar = frames[0]
            print(f"GTK document frame: {frame.get_name()!r} (X window title {x_title!r})", flush=True)
            toolbars = named_child(named_child(bar, "View"), "Toolbars")
            entries = [row.get_name() for row in children(toolbars) if row.get_role() == Atspi.Role.CHECK_MENU_ITEM]
        except GLib.Error as error:
            raise SmokeFailure(str(error)) from error
        if not {"Main Toolbar", "Drawn Structure Settings"}.issubset(entries):
            raise SmokeFailure(f"expected Main Toolbar and Drawn Structure Settings, found {entries!r}")
        print(f"GTK View > Toolbars entries: {', '.join(entries)}", flush=True)

    Atspi.set_timeout(1000, 1000)
    wait_for(check, "View > Toolbars was not populated")


TEXT = "UTF8_STRING"
SELECTION = "application/x-chemdraft-selection+json"


def keys(*shortcuts):
    subprocess.run(["xdotool", "key", "--clearmodifiers", "--delay", "100", *shortcuts], check=True, timeout=5)


def xclip(target):
    return ["xclip", "-selection", "clipboard", "-target", target]


def read_clipboard(target):
    try:
        result = subprocess.run([*xclip(target), "-out"], capture_output=True, timeout=2)
    except subprocess.TimeoutExpired as error:
        raise SmokeFailure(f"xclip timed out reading {target}") from error
    if result.returncode:
        raise SmokeFailure(f"xclip could not read {target}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def paste_from_host(target, data):
    # xclip forks a selection owner. Keep the owner's file descriptors off the harness log pipe.
    subprocess.run([*xclip(target), "-in"], input=data, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=5)

    def check():
        if read_clipboard(target) != data:
            raise SmokeFailure(f"the X11 clipboard still has the previous {target} bytes")

    wait_for(check, f"Host xclip did not claim the {target} clipboard", seconds=3)
    keys("ctrl+v")


def expect_smiles(expected, description):
    def check():
        keys("ctrl+alt+c")
        actual = read_clipboard(TEXT)
        if actual != expected:
            raise SmokeFailure(f"expected {expected!r}, read {actual[:120]!r}")

    wait_for(check, description)
    print(f"{description} passed with {expected.decode()}", flush=True)


def copy_selection(atoms):
    keys("ctrl+a")

    def check():
        keys("ctrl+c")
        data = read_clipboard(SELECTION)
        try:
            payload = json.loads(data)
            [molecule] = payload["objects"]
            if (payload["kind"] == "chemdraft-selection" and molecule["type"] == "molecule"
                    and len(molecule["atoms"]) == atoms and len(molecule["bonds"]) == atoms - 1):
                return data
        except (KeyError, TypeError, ValueError) as error:
            raise SmokeFailure(f"invalid ChemDraft selection JSON: {error}") from error
        raise SmokeFailure(f"expected one molecule with {atoms} atoms and {atoms - 1} bonds")

    return wait_for(check, "Ctrl+C did not publish the expected ChemDraft selection")


def check_clipboard(window, logs):
    subprocess.run(["xdotool", "windowactivate", "--sync", window], check=True, timeout=5)
    # Copy As SMILES writes different bytes from the original host text, proving the app copied.
    paste_from_host(TEXT, b"C-C-C")
    expect_smiles(b"CCC", "Host plain text → ChemDraft Paste → Copy As SMILES → host")
    propane = copy_selection(3)
    (logs / "clipboard-selection.json").write_bytes(propane)

    # Replace the app's last in-memory selection with ethane. If it falls back to that selection
    # when the host offers the captured propane JSON, the final SMILES comparison fails.
    keys("ctrl+n")
    paste_from_host(TEXT, b"C-C")
    expect_smiles(b"CC", "Paste ethane into the second document")
    copy_selection(2)
    keys("ctrl+n")
    paste_from_host(SELECTION, propane)
    expect_smiles(b"CCC", "ChemDraft selection → host xclip → ChemDraft Paste → Copy As SMILES")


if __name__ == "__main__":
    try:
        check_toolbars_menu(int(sys.argv[1]), sys.argv[2])
    except (ImportError, ValueError, SmokeFailure) as error:
        sys.exit(f"::error::GTK Toolbars menu check failed: {error}")
    try:
        check_clipboard(sys.argv[2], Path(sys.argv[3]))
    except (OSError, subprocess.SubprocessError, SmokeFailure) as error:
        sys.exit(f"::error::X11 clipboard check failed: {error}")
