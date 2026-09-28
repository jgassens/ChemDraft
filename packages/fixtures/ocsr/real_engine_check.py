"""Opt-in accuracy check of the real MolScribe engine against the OCSR fixtures.

Run it through `pnpm test:ocsr-real`, which finds an installed engine and starts this file with that
engine's own venv interpreter (Pillow and RDKit come from there). It starts the app's sidecar exactly
as the app does and asks it to recognize every fixture in every variant. Each variant names what it
expects in expected.json:

  majority          the answer's RDKit canonical SMILES equals the expected one exactly, and more
                    than half of the sizes the sidecar tried gave it
  exactLowOrFailed  either that exact answer with the host's review tier capped at low, or a failed
                    result; a wrong structure fails whatever its tier

For every case it prints one character per size, read from the sidecar's log: Y the expected
structure, . another valid structure, x unparsable (or the run raised), - not run (adaptive stop).

Variants (the screenshots imagine the drawing shown on screen DISPLAY_LONG_SIDE_PT points wide):
  file                      the fixture file as shipped (for brevetoxin A: gray + alpha, transparent)
  retina-2x-on-white        composited on white, long side 2 x 700 = 1400 px: a Retina screenshot
  1x-on-white-20px-margin   composited on white, long side 700 px plus a 20 px white border: a 1x
                            screenshot cropped tight
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

from PIL import Image
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

PROTOCOL_VERSION = 2
MODEL_FILENAME = "swin_base_char_aux_1m.pth"
REQUEST_TIMEOUT_S = 300  # the app's own per-request timeout (process.rs REQUEST_TIMEOUT)
EXPECTATIONS = ("majority", "exactLowOrFailed")
DISPLAY_LONG_SIDE_PT = 700  # how large the simulated screenshots show the drawing, in screen points


def on_white(image):
    rgba = image.convert("RGBA")
    white = Image.new("RGB", rgba.size, (255, 255, 255))
    white.paste(rgba, mask=rgba.getchannel("A"))
    return white


def to_long_side(image, long_side):
    scale = long_side / float(max(image.size))
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.LANCZOS)


def render_variant(variant, source, directory):
    if variant == "file":
        return source
    with Image.open(source) as opened:
        image = on_white(opened)
    if variant == "retina-2x-on-white":
        rendered = to_long_side(image, 2 * DISPLAY_LONG_SIDE_PT)
    elif variant == "1x-on-white-20px-margin":
        shown = to_long_side(image, DISPLAY_LONG_SIDE_PT)
        rendered = Image.new("RGB", (shown.width + 40, shown.height + 40), (255, 255, 255))
        rendered.paste(shown, (20, 20))
    else:
        raise SystemExit("unknown variant {!r}".format(variant))
    path = os.path.join(directory, "{}-{}.png".format(os.path.splitext(os.path.basename(source))[0], variant))
    rendered.save(path)
    return path


def canonical(smiles):
    molecule = Chem.MolFromSmiles(smiles) if smiles else None
    return None if molecule is None else Chem.MolToSmiles(molecule, isomericSmiles=True)


def tier_cap(agreement):
    """The host's review-tier cap (apps/desktop/src/plugins/recognitionAgreement.ts)."""
    if agreement["agreeing"] >= agreement["runs"]:
        return "none (unanimous)"
    if agreement["agreeing"] * 3 >= agreement["runs"] * 2:
        return "medium"
    return "low"


def last_vote(log_path):
    """The per-size runs of the latest request, from the sidecar's `vote {...}` log line."""
    marker = "[molscribe-sidecar] vote "
    with open(log_path, encoding="utf-8") as handle:
        lines = [line for line in handle if line.startswith(marker)]
    return json.loads(lines[-1][len(marker):]) if lines else None


def size_table(vote, expected, all_sizes):
    """Header and row: Y expected structure, . another valid one, x unparsable, - not run."""
    by_size = {run["px"]: run for run in (vote or {}).get("runs", [])}
    cells = []
    for size in all_sizes:
        run = by_size.get(size)
        if run is None:
            cells.append("-")
        elif run["key"] is None:
            cells.append("x")
        elif canonical(run["key"]) == expected:
            cells.append("Y")
        else:
            cells.append(".")
    width = max(len(str(size)) for size in all_sizes)
    header = " ".join(str(size).rjust(width) for size in all_sizes)
    row = " ".join(cell.rjust(width) for cell in cells)
    return header, row


class Sidecar:
    def __init__(self, engine, sidecar, log_path):
        env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
        self.log = open(log_path, "w", encoding="utf-8")
        self.process = subprocess.Popen(
            [sys.executable, "-I", sidecar, "--checkpoint", os.path.join(engine, MODEL_FILENAME)],
            cwd=engine,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            encoding="utf-8",
        )
        self.lines = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def read(self, timeout):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise SystemExit("the sidecar did not answer within {} s".format(timeout))
        if line is None:
            raise SystemExit("the sidecar exited (code {})".format(self.process.wait()))
        return json.loads(line)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def close(self):
        try:
            self.send({"type": "shutdown"})
            self.process.wait(timeout=30)
        except Exception:  # noqa: BLE001 - best effort, then force
            self.process.kill()
        self.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", required=True, help="installed ocsr-engine directory")
    parser.add_argument("--sidecar", required=True, help="path to molscribe_sidecar.py")
    parser.add_argument("--fixtures", required=True, help="directory holding expected.json")
    args = parser.parse_args()

    with open(os.path.join(args.fixtures, "expected.json"), encoding="utf-8") as handle:
        fixtures = json.load(handle)["fixtures"]

    failures = []
    with tempfile.TemporaryDirectory(prefix="chemdraft-ocsr-real-") as directory:
        log_path = os.path.join(directory, "sidecar.log")
        sidecar = Sidecar(args.engine, args.sidecar, log_path)
        try:
            started = time.monotonic()
            ready = sidecar.read(REQUEST_TIMEOUT_S)
            if ready.get("type") != "ready" or ready.get("protocol") != PROTOCOL_VERSION:
                raise SystemExit("unexpected first message from the sidecar: {}".format(ready))
            print("engine   {}".format(args.engine))
            print("legend   Y expected structure · . another valid structure · x unparsable · - not run")
            print("sidecar  protocol {} · MolScribe {} · torch {} · model loaded in {:.1f} s".format(
                ready["protocol"], ready["molscribeVersion"], ready["torchVersion"], time.monotonic() - started))
            sys.path.insert(0, os.path.dirname(os.path.abspath(args.sidecar)))
            sys.dont_write_bytecode = True  # never leave __pycache__ in the app resources
            import molscribe_sidecar  # noqa: E402 - only for the size lists, so the table matches

            all_sizes = list(molscribe_sidecar.ALL_LONG_SIDES_PX)
            for fixture in fixtures:
                source = os.path.join(args.fixtures, fixture["image"])
                expected = canonical(fixture["expectedSmiles"])
                if expected is None:
                    raise SystemExit("expected SMILES for {} does not parse".format(fixture["id"]))
                for variant, expectation in fixture["variants"].items():
                    if expectation not in EXPECTATIONS:
                        raise SystemExit("unknown expectation {!r} for {}".format(expectation, variant))
                    case = "{} / {}".format(fixture["id"], variant)
                    path = os.path.abspath(render_variant(variant, source, directory))
                    with Image.open(path) as probe:
                        size = "{}x{} {}".format(probe.width, probe.height, probe.mode)
                    requested = time.monotonic()
                    sidecar.send({"id": case, "type": "recognize", "imagePath": path})
                    reply = sidecar.read(REQUEST_TIMEOUT_S)
                    wall = time.monotonic() - requested
                    header, row = size_table(last_vote(log_path), expected, all_sizes)
                    print()
                    print("{}  ({}, expects {})".format(case, size, expectation))
                    print("      px  " + header)
                    print("      run " + row)
                    if reply.get("type") != "result":
                        failed_ok = (expectation == "exactLowOrFailed" and reply.get("type") == "error"
                                     and reply.get("code") == "recognition_failed")
                        if not failed_ok:
                            failures.append(case)
                        print("{}  failed result ({}): {}  {:.1f} s".format(
                            "PASS" if failed_ok else "FAIL", reply.get("code"), reply.get("message"), wall))
                        continue
                    agreement = reply["agreement"]
                    exact = canonical(reply["smiles"]) == expected
                    cap = tier_cap(agreement)
                    if expectation == "majority":
                        ok = exact and agreement["agreeing"] * 2 > agreement["runs"]
                        verdict = "PASS" if ok else "FAIL"
                    else:
                        ok = exact
                        verdict = "PASS" if exact and cap == "low" else (
                            "PASS (better than required: tier cap {})".format(cap) if exact
                            else "FAIL" + (" (WRONG ABOVE LOW)" if cap != "low" else ""))
                    if not ok:
                        failures.append(case)
                    print("{}  structure {}  agreement {}/{} ({} invalid)  tier cap {}  confidence {}  "
                          "{:.1f} s engine, {:.1f} s wall".format(
                              verdict,
                              "exact" if exact else "WRONG",
                              agreement["agreeing"],
                              agreement["runs"],
                              agreement.get("invalidRuns", "?"),
                              cap,
                              "n/a" if reply["confidence"] is None else "{:.3f}".format(reply["confidence"]),
                              reply["elapsedMs"] / 1000.0,
                              wall,
                          ))
                    if not exact:
                        print("      got      {}".format(canonical(reply["smiles"]) or reply["smiles"]))
                        print("      expected {}".format(expected))
        finally:
            sidecar.close()
            if failures:
                with open(log_path, encoding="utf-8") as handle:
                    tail = handle.read().splitlines()[-20:]
                print("sidecar log (last {} lines):".format(len(tail)))
                for line in tail:
                    print("      " + line)
    if failures:
        print("{} case(s) failed: {}".format(len(failures), ", ".join(failures)))
        return 1
    print("all cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
