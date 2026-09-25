#!/usr/bin/env python3
"""MolScribe JSON-Lines sidecar for ChemDraft (protocol 2).

Stdin and stdout carry one JSON object per line; stderr is log only. The normal
path imports and loads MolScribe exactly once. `--selftest` exercises the
framing, the image preprocessing, the multi-scale vote and the output mapping
with a fake model, without torch, MolScribe or RDKit (Pillow is required).

Every image is flattened onto white before recognition: MolScribe reads images
through OpenCV, which drops the alpha channel, so a transparent background turns
black and the drawing becomes noise. Each image is then recognized at several
sizes and the answers are compared by canonical SMILES, because a single run's
answer and its confidence both swing with the image size.

Stdout is reserved for the protocol. Before any heavy import, file descriptor 1
is pointed at stderr, so a stray print() from MolScribe, torch or a C extension
lands in the log instead of corrupting a protocol line.
"""

import argparse
import io
import json
import os
import sys
import tempfile
import time

PROTOCOL_VERSION = 2

# Longer-side sizes (pixels) each image may be recognized at: 760 to 1240 in steps of 40. MolScribe
# squashes every image to 384 x 384, so on a large molecule a single run is chaotic: 800 x 287 was
# right and 800 x 288 wrong. Measured on brevetoxin A, a vote over these 13 sizes was exact for the
# 1920 px file and a simulated Retina screenshot (9/13 each); a tuned handful of sizes was not.
CONSENSUS_LONG_SIDES_PX = tuple(range(760, 1241, 40))
# Run these first. If at least ADAPTIVE_STOP_AGREEING of them give the same valid structure, the
# other sizes are skipped to save time. 900 and 1100 are not on the grid above, so a full vote is
# 15 runs: these five plus the grid's other ten.
FIRST_PASS_LONG_SIDES_PX = (800, 900, 1000, 1100, 1200)
ADAPTIVE_STOP_AGREEING = 4
ALL_LONG_SIDES_PX = tuple(sorted(set(CONSENSUS_LONG_SIDES_PX) | set(FIRST_PASS_LONG_SIDES_PX)))
# A drawing enlarged more than this is blurred rather than clarified, so larger targets are skipped.
MAX_UPSCALE = 2.0

ALL_RUNS_INVALID_MESSAGE = (
    "The engine could not read a valid structure from this image. Try a larger or sharper image."
)

_protocol_out = sys.stdout


def claim_stdout():
    """Keep a private handle on the real stdout and send everything else to stderr."""
    global _protocol_out
    sys.stdout.flush()
    _protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr


def emit(payload):
    _protocol_out.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    _protocol_out.flush()


def log(message):
    print("[molscribe-sidecar] {}".format(message), file=sys.stderr, flush=True)


class InvalidImage(Exception):
    """The file could not be decoded as an image."""


class NoValidStructure(Exception):
    """Every run produced a structure that does not parse; reported as recognition_failed."""


def optional_number(value):
    """A float, or None. Never invents a value: anything absent or non-numeric is None."""
    if hasattr(value, "item"):
        value = value.item()
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------
# Preprocessing


def load_flattened(path):
    """Decode `path` with Pillow and return an RGB image with any transparency composited onto white.

    Applies to every image whatever its source. Raises InvalidImage when the file is not an image.
    """
    from PIL import Image, ImageOps

    try:
        with Image.open(path) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened) or opened
            image = image.copy()
    except Exception as problem:  # noqa: BLE001 - Pillow raises many types for a bad file
        raise InvalidImage(str(problem) or type(problem).__name__) from problem
    return flatten_onto_white(image)


def flatten_onto_white(image):
    """Return an RGB copy of a Pillow image, with alpha or palette transparency laid over white."""
    from PIL import Image

    if image.mode in ("I;16", "I;16B", "I;16L", "I;16N"):
        image = image.convert("I")
    if image.mode in ("I", "F"):
        # 16-bit (or float) grayscale: scale into 8 bits instead of letting convert() clip it.
        image = image.point(lambda value: value * (255.0 / 65535.0)).convert("L")
    has_transparency = image.mode in ("RGBA", "LA", "PA", "La", "RGBa") or "transparency" in image.info
    if not has_transparency:
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def consensus_long_sides(width, height):
    """(first_pass, rest): the longer-side sizes to recognize an image of this size at, smallest first.

    Targets that would enlarge the image by more than MAX_UPSCALE are skipped. When any target is
    skipped, the original size votes too (in the second pass), so a small image still gets a second
    opinion where one is possible; an image too small for any target is recognized once, as it is.
    """
    original = max(int(width), int(height))
    if original <= 0:
        raise InvalidImage("The image has no pixels.")
    allowed = [size for size in ALL_LONG_SIDES_PX if size <= original * MAX_UPSCALE]
    first = [size for size in allowed if size in FIRST_PASS_LONG_SIDES_PX]
    rest = [size for size in allowed if size not in FIRST_PASS_LONG_SIDES_PX]
    if len(allowed) < len(ALL_LONG_SIDES_PX) and original not in allowed:
        if first:
            rest.append(original)
        else:
            first.append(original)
    return sorted(first), sorted(rest)


def resize_to_long_side(image, long_side):
    """Scale an image so its longer side is `long_side` pixels, keeping the aspect ratio (LANCZOS)."""
    from PIL import Image

    width, height = image.size
    original = max(width, height)
    if original == long_side:
        return image
    scale = long_side / float(original)
    size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    return image.resize(size, Image.LANCZOS)


# ---------------------------------------------------------------------------------------------
# Voting


def vote(keys, confidences):
    """Pick one run from several.

    `keys` holds each run's canonical SMILES, or None when the run failed or its SMILES did not
    parse. An invalid run never wins and never agrees with anything. The winner is the most
    frequent valid key; a tie goes to the key with the higher mean confidence (a missing confidence
    counts as 0), then to the key seen first. Returns (index, agreeing): the most confident run of
    the winning key and how many runs gave that key. Raises NoValidStructure when no key is valid.
    """
    if not keys:
        raise ValueError("vote() needs at least one run")
    groups = {}
    for index, key in enumerate(keys):
        if key is not None:
            groups.setdefault(key, []).append(index)
    if not groups:
        raise NoValidStructure(ALL_RUNS_INVALID_MESSAGE)

    def confidence_of(index):
        value = confidences[index]
        return 0.0 if value is None else value

    def rank(members):
        mean = sum(confidence_of(index) for index in members) / len(members)
        return (len(members), mean, -members[0])

    winner = max(groups.values(), key=rank)
    # Within the winner, the most confident run; ties go to the earlier (smaller) size.
    chosen = max(winner, key=lambda index: (-1.0 if confidences[index] is None else confidences[index], -index))
    return chosen, len(winner)


def top_valid_count(keys):
    """How many runs gave the most frequent valid key (0 when none is valid)."""
    counts = {}
    for key in keys:
        if key is not None:
            counts[key] = counts.get(key, 0) + 1
    return max(counts.values(), default=0)


def rdkit_canonical_smiles(smiles):
    """RDKit canonical isomeric SMILES, or None when the text does not parse."""
    from rdkit import Chem

    if not isinstance(smiles, str) or not smiles.strip():
        return None
    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        return None
    return Chem.MolToSmiles(molecule, isomericSmiles=True)


def recognize_consensus(predict, canonicalize, image_path):
    """Recognize one image file at the consensus sizes and return (prediction, agreement).

    `predict` takes an RGB Pillow image and returns MolScribe's prediction dict. The first-pass sizes
    run first; the rest run only when fewer than ADAPTIVE_STOP_AGREEING first-pass runs agree on one
    valid structure. Raises InvalidImage for an undecodable file, re-raises the last model error if
    every run raised, and raises NoValidStructure if runs answered but none of them parsed.
    """
    image = load_flattened(image_path)
    first_pass, rest = consensus_long_sides(*image.size)
    sizes = []
    predictions = []
    keys = []
    confidences = []
    last_problem = None

    def run(size):
        nonlocal last_problem
        sizes.append(size)
        try:
            prediction = predict(resize_to_long_side(image, size))
            if not isinstance(prediction, dict):
                raise ValueError("MolScribe returned a non-object prediction")
        except Exception as problem:  # noqa: BLE001 - one failed size is an invalid vote
            log("recognition at {} px failed: {!r}".format(size, problem))
            last_problem = problem
            predictions.append(None)
            keys.append(None)
            confidences.append(None)
            return
        predictions.append(prediction)
        try:
            keys.append(canonicalize(prediction.get("smiles")))
        except Exception as problem:  # noqa: BLE001 - an unparsable answer is an invalid vote
            log("canonicalization failed: {!r}".format(problem))
            keys.append(None)
        confidences.append(optional_number(prediction.get("confidence")))

    for size in first_pass:
        run(size)
    if top_valid_count(keys) < ADAPTIVE_STOP_AGREEING:
        for size in rest:
            run(size)
    order = sorted(range(len(sizes)), key=lambda index: sizes[index])
    sizes = [sizes[index] for index in order]
    predictions = [predictions[index] for index in order]
    keys = [keys[index] for index in order]
    confidences = [confidences[index] for index in order]
    # One structured line per request, so a check can print the per-size table from the log.
    log("vote " + json.dumps({
        "image": os.path.basename(image_path),
        "runs": [{"px": size, "key": key, "confidence": confidence}
                 for size, key, confidence in zip(sizes, keys, confidences)],
    }, separators=(",", ":")))
    if all(prediction is None for prediction in predictions):
        raise last_problem if last_problem is not None else RuntimeError("no recognition ran")
    chosen, agreeing = vote(keys, confidences)
    invalid = sum(1 for key in keys if key is None)
    log("{} runs at {} px: chose {} px ({} agreeing, {} invalid)".format(
        len(sizes), sizes, sizes[chosen], agreeing, invalid))
    return predictions[chosen], {
        "runs": len(sizes), "agreeing": agreeing, "invalidRuns": invalid, "scalesPx": sizes}


# ---------------------------------------------------------------------------------------------
# Output mapping

# MolScribe's `predict_image(..., return_atoms_bonds=True, return_confidence=True)`
# (molscribe/interface.py at the pinned commit) returns:
#   {"smiles": str, "molfile": str, "confidence": float,
#    "atoms": [{"atom_symbol": str, "x": float, "y": float, "confidence": float}],
#    "bonds": [{"bond_type": str, "endpoint_atoms": (int, int), "confidence": float}]}
# x and y are fractions of the image width and height, so they do not depend on the size the
# image was recognized at. Each key is mapped as-is; a missing key becomes null rather than a
# guessed value.


def map_atom(raw, index):
    return {
        "index": index,
        "symbol": str(raw.get("atom_symbol") or ""),
        "x": optional_number(raw.get("x")),
        "y": optional_number(raw.get("y")),
        "confidence": optional_number(raw.get("confidence")),
    }


def map_bond(raw):
    endpoints = raw.get("endpoint_atoms")
    if not isinstance(endpoints, (list, tuple)) or len(endpoints) != 2:
        raise ValueError("MolScribe returned a bond without two endpoint atoms")
    return {
        "begin": int(endpoints[0]),
        "end": int(endpoints[1]),
        "bondType": str(raw.get("bond_type") or ""),
        "confidence": optional_number(raw.get("confidence")),
    }


def map_prediction(request_id, prediction, agreement, elapsed_ms):
    if not isinstance(prediction, dict):
        raise ValueError("MolScribe returned a non-object prediction")
    return {
        "id": request_id,
        "type": "result",
        "smiles": str(prediction.get("smiles") or ""),
        "molfile": str(prediction.get("molfile") or ""),
        "confidence": optional_number(prediction.get("confidence")),
        "atoms": [map_atom(atom, index) for index, atom in enumerate(prediction.get("atoms") or [])],
        "bonds": [map_bond(bond) for bond in prediction.get("bonds") or []],
        "agreement": {
            "runs": int(agreement["runs"]),
            "agreeing": int(agreement["agreeing"]),
            "invalidRuns": int(agreement["invalidRuns"]),
            "scalesPx": [int(size) for size in agreement["scalesPx"]],
        },
        "elapsedMs": int(elapsed_ms),
    }


def error(request_id, code, message):
    return {"id": request_id, "type": "error", "code": code, "message": message}


def handle_line(recognize, line):
    """Answer one request line. `recognize(path)` returns (prediction, agreement).

    Returns False when the sidecar should exit.
    """
    try:
        request = json.loads(line)
    except ValueError as problem:
        emit(error(None, "recognition_failed", "Malformed request: {}".format(problem)))
        return True
    if not isinstance(request, dict):
        emit(error(None, "recognition_failed", "A request must be a JSON object."))
        return True
    if request.get("type") == "shutdown":
        return False
    request_id = request.get("id")
    if not isinstance(request_id, str):
        emit(error(None, "recognition_failed", "The request has no string id."))
        return True
    if request.get("type") != "recognize":
        emit(error(request_id, "recognition_failed", "Unsupported request type."))
        return True
    image_path = request.get("imagePath")
    if not isinstance(image_path, str) or not os.path.isabs(image_path) or not os.path.isfile(image_path):
        emit(error(request_id, "invalid_image", "The image path is not a readable absolute file."))
        return True
    started = time.monotonic()
    try:
        prediction, agreement = recognize(image_path)
        emit(map_prediction(request_id, prediction, agreement, round((time.monotonic() - started) * 1000)))
    except InvalidImage as problem:
        emit(error(request_id, "invalid_image", "The image could not be decoded: {}".format(problem)))
    except NoValidStructure as problem:
        emit(error(request_id, "recognition_failed", str(problem)))
    except Exception as problem:  # noqa: BLE001 - any model failure is reported, never fatal
        log("recognition failed: {!r}".format(problem))
        emit(error(request_id, "recognition_failed", str(problem) or type(problem).__name__))
    return True


def serve(recognize, stream):
    for line in iter(stream.readline, ""):
        line = line.strip()
        if line and not handle_line(recognize, line):
            return 0
    return 0


# ---------------------------------------------------------------------------------------------
# Self-test (no model)


def _selftest_canonicalize(smiles):
    """Stand-in for RDKit when it is not installed: text is its own key, 'INVALID' does not parse."""
    if not isinstance(smiles, str) or not smiles.strip() or smiles == "INVALID":
        return None
    return smiles.strip()


def _selftest_preprocessing(directory):
    from PIL import Image

    # A black line on a fully transparent background (gray + alpha), as Wikimedia ships drawings.
    la = Image.new("LA", (40, 20), (0, 0))
    for x in range(5, 35):
        la.putpixel((x, 10), (0, 255))
    la_path = os.path.join(directory, "transparent-la.png")
    la.save(la_path)
    flat = load_flattened(la_path)
    assert flat.mode == "RGB" and flat.size == (40, 20)
    assert flat.getpixel((0, 0)) == (255, 255, 255), "transparent background must become white"
    assert flat.getpixel((10, 10)) == (0, 0, 0), "opaque ink must stay black"

    # Half-transparent red over white blends toward white; RGBA input.
    rgba = Image.new("RGBA", (4, 4), (255, 0, 0, 128))
    rgba_path = os.path.join(directory, "half.png")
    rgba.save(rgba_path)
    red, green, blue = load_flattened(rgba_path).getpixel((1, 1))
    assert red == 255 and 120 <= green <= 135 and green == blue, (red, green, blue)

    # Palette image whose transparent index is black: it must come out white, not black.
    palette = Image.new("P", (4, 4), 0)
    palette.putpalette([0, 0, 0, 10, 20, 30] + [0] * (256 * 3 - 6))
    palette.putpixel((2, 2), 1)
    palette_path = os.path.join(directory, "palette.png")
    palette.save(palette_path, transparency=0)
    flat_palette = load_flattened(palette_path)
    assert flat_palette.getpixel((0, 0)) == (255, 255, 255)
    assert flat_palette.getpixel((2, 2)) == (10, 20, 30)

    # Opaque images pass through as RGB unchanged; 16-bit gray is scaled, not clipped.
    gray = Image.new("L", (3, 3), 77)
    gray_path = os.path.join(directory, "gray.png")
    gray.save(gray_path)
    assert load_flattened(gray_path).getpixel((1, 1)) == (77, 77, 77)
    deep = Image.new("I;16", (3, 3), 65535)
    deep_path = os.path.join(directory, "deep.png")
    deep.save(deep_path)
    assert load_flattened(deep_path).getpixel((1, 1)) == (255, 255, 255)

    # WebP reaches the sidecar undecoded (the app's Rust image decoder has no WebP support), so
    # Pillow must read it; transparency is flattened like any other format.
    webp = Image.new("RGBA", (6, 4), (0, 0, 0, 0))
    webp.putpixel((3, 2), (0, 0, 0, 255))
    webp_path = os.path.join(directory, "drawing.webp")
    webp.save(webp_path, "WEBP", lossless=True)
    flat_webp = load_flattened(webp_path)
    assert flat_webp.mode == "RGB" and flat_webp.size == (6, 4)
    assert flat_webp.getpixel((0, 0)) == (255, 255, 255)
    assert flat_webp.getpixel((3, 2)) == (0, 0, 0)

    garbage = os.path.join(directory, "garbage.png")
    with open(garbage, "wb") as handle:
        handle.write(b"not an image")
    try:
        load_flattened(garbage)
    except InvalidImage:
        pass
    else:
        raise AssertionError("an undecodable file must raise InvalidImage")

    # Scale selection: first pass, then the rest; never enlarge more than 2x; the original size
    # votes when any target is skipped.
    grid_rest = [760, 840, 880, 920, 960, 1040, 1080, 1120, 1160, 1240]
    assert CONSENSUS_LONG_SIDES_PX == (760, 800, 840, 880, 920, 960, 1000, 1040, 1080, 1120, 1160, 1200, 1240)
    assert consensus_long_sides(1920, 690) == ([800, 900, 1000, 1100, 1200], grid_rest)
    assert consensus_long_sides(690, 1920) == ([800, 900, 1000, 1100, 1200], grid_rest)
    assert consensus_long_sides(620, 200) == ([800, 900, 1000, 1100, 1200], grid_rest)  # 1240 is 2x
    assert consensus_long_sides(600, 200) == ([800, 900, 1000, 1100, 1200], [600] + grid_rest[:-1])
    assert consensus_long_sides(550, 100) == (
        [800, 900, 1000, 1100], [550, 760, 840, 880, 920, 960, 1040, 1080])
    assert consensus_long_sides(450, 100) == ([800, 900], [450, 760, 840, 880])
    assert consensus_long_sides(390, 100) == ([390], [760])
    assert consensus_long_sides(300, 100) == ([300], [])
    resized = resize_to_long_side(Image.new("RGB", (1920, 690), "white"), 800)
    assert resized.size == (800, 288), resized.size
    assert resize_to_long_side(resized, 800) is resized


def _selftest_voting():
    # Unanimous.
    assert vote(["A", "A", "A"], [0.5, 0.9, 0.2]) == (1, 3)
    # Majority wins even when the dissenting run is more confident (the 500 px brevetoxin case).
    assert vote(["B", "A", "A"], [0.95, 0.5, 0.7]) == (2, 2)
    # Plurality, not majority: the most frequent valid key wins.
    assert vote(["A", "B", "B", "C", "D"], [0.9, 0.2, 0.3, 0.9, 0.9]) == (2, 2)
    # All different: a tie on count goes to the most confident key.
    assert vote(["A", "B", "C"], [0.3, 0.8, 0.5]) == (1, 1)
    # Ties on count go to the higher MEAN confidence, not the single most confident run.
    assert vote(["A", "A", "B", "B"], [0.99, 0.1, 0.6, 0.6]) == (2, 2)
    # Invalid runs never win and never agree, however many and however confident.
    assert vote([None, None, None, "A"], [0.99, 0.99, 0.99, 0.1]) == (3, 1)
    assert vote([None, None, "A", "B", "B"], [0.9, 0.9, 0.1, 0.2, 0.3]) == (4, 2)
    try:
        vote([None, None, None], [0.2, 0.9, 0.5])
    except NoValidStructure as problem:
        assert str(problem) == ALL_RUNS_INVALID_MESSAGE
    else:
        raise AssertionError("all-invalid runs must raise NoValidStructure")
    # Missing confidence ranks below any real one; exact ties go to the earlier run.
    assert vote(["A", "A", "B"], [None, 0.1, 0.99]) == (1, 2)
    assert vote(["A", "A", "A"], [0.5, 0.5, 0.5]) == (0, 3)
    assert vote(["A", "B"], [0.5, 0.5]) == (0, 1)
    assert vote(["A"], [None]) == (0, 1)
    assert top_valid_count([None, "A", "B", "A", None]) == 2
    assert top_valid_count([None, None]) == 0


def _selftest_rdkit():
    """Checked only where RDKit is installed (the engine venv); the stub stands in elsewhere."""
    try:
        import rdkit  # noqa: F401
    except ImportError:
        return False
    assert rdkit_canonical_smiles("OC") == rdkit_canonical_smiles("CO") == "CO"
    assert rdkit_canonical_smiles("C[C@H](N)O") != rdkit_canonical_smiles("C[C@@H](N)O")
    assert rdkit_canonical_smiles("[C@]1([H])(C)CCO1") == rdkit_canonical_smiles("C[C@@H]1CCO1")
    assert rdkit_canonical_smiles("C1CC") is None
    assert rdkit_canonical_smiles("C(C)(C)(C)(C)C") is None  # pentavalent carbon does not parse
    assert rdkit_canonical_smiles("") is None
    return True


def selftest():
    """Drive preprocessing, voting and the protocol with a fake model; prints one line per response."""
    from PIL import Image

    size_answers = {}
    default_answer = ["CO", 0.93]
    predicted_sizes = []

    def fake_predict(image):
        long_side = max(image.size)
        predicted_sizes.append(long_side)
        assert image.mode == "RGB"
        answer = size_answers.get(long_side, default_answer)
        if answer == "boom":
            raise RuntimeError("model exploded")
        smiles, confidence = answer
        return {
            "smiles": smiles,
            "molfile": "fixture-{}".format(long_side),
            "confidence": confidence,
            "atoms": [
                {"atom_symbol": "C", "x": 0.25, "y": 0.75, "confidence": 0.99},
                {"atom_symbol": "O", "x": 0.5, "y": 0.5},
            ],
            "bonds": [{"bond_type": "single", "endpoint_atoms": (0, 1), "confidence": 0.98}],
        }

    def recognize(path):
        return recognize_consensus(fake_predict, _selftest_canonicalize, path)

    def ask(request_id, path, answers, default=("CO", 0.93)):
        size_answers.clear()
        size_answers.update(answers)
        default_answer[:] = default
        del predicted_sizes[:]
        serve(recognize, io.StringIO(json.dumps(
            {"id": request_id, "type": "recognize", "imagePath": path}) + "\n"))
        return list(predicted_sizes)

    first = list(FIRST_PASS_LONG_SIDES_PX)
    every = sorted(FIRST_PASS_LONG_SIDES_PX + tuple(size for size in CONSENSUS_LONG_SIDES_PX
                                                    if size not in FIRST_PASS_LONG_SIDES_PX))
    assert len(every) == 15

    captured = []
    global emit
    real_emit = emit
    emit = captured.append
    try:
        with tempfile.TemporaryDirectory() as directory:
            _selftest_preprocessing(directory)
            _selftest_voting()
            rdkit_checked = _selftest_rdkit()

            good = os.path.join(directory, "good.png")
            Image.new("LA", (1920, 690), (0, 0)).save(good)
            garbage = os.path.join(directory, "garbage.png")
            with open(garbage, "wb") as handle:
                handle.write(b"fixture")

            # r1 adaptive stop: 4 of the 5 first-pass sizes agree, so the other ten never run, and
            # the more confident outlier's molfile is not returned.
            ran = ask("r1", good, {800: ("CO", 0.6), 900: ("OC=O", 0.99), 1000: ("CO", 0.7),
                                   1100: ("CO", 0.65), 1200: ("CO", 0.5)})
            assert sorted(ran) == first, ran

            # r2 no early stop (3 of 5 agree): every size runs, and the winner counts over all 15.
            ran = ask("r2", good, {800: ("CO", 0.6), 900: ("OC=O", 0.99), 1000: ("CO", 0.7),
                                   1100: ("OC=O", 0.65), 1200: ("CO", 0.5)})
            assert sorted(ran) == every, ran

            # r3 invalid never wins: 10 unparsable runs, even very confident ones, lose to 3 valid.
            answers = {size: ("INVALID", 0.99) for size in every}
            answers.update({760: ("CCO", 0.2), 1000: ("CCO", 0.3), 1240: ("CCO", 0.1),
                            840: "boom", 1160: ("OCC=O", 0.4)})
            ran = ask("r3", good, answers)
            assert sorted(ran) == every, ran

            # r4 every run unparsable (one raised): a failed result with the plain message.
            answers = {size: ("INVALID", 0.9) for size in every}
            answers[900] = "boom"
            ask("r4", good, answers)

            # r5 every run raised: the model error is reported.
            ask("r5", good, {size: "boom" for size in every})

            size_answers.clear()
            default_answer[:] = ["CO", 0.93]
            lines = [
                "not json",
                json.dumps({"id": "r6", "type": "recognize", "imagePath": "relative.png"}),
                json.dumps({"id": "r7", "type": "recognize", "imagePath": garbage}),
                json.dumps({"id": "r8", "type": "recognize", "imagePath": good}),
                json.dumps({"type": "shutdown"}),
                json.dumps({"id": "never", "type": "recognize", "imagePath": good}),
            ]
            status = serve(recognize, io.StringIO("\n".join(lines) + "\n"))
    finally:
        emit = real_emit

    assert status == 0
    assert len(captured) == 9, captured  # nothing after shutdown
    stopped = captured[0]
    assert stopped["type"] == "result" and stopped["id"] == "r1", stopped
    assert stopped["smiles"] == "CO" and stopped["molfile"] == "fixture-1000"
    assert stopped["confidence"] == 0.7
    assert stopped["agreement"] == {"runs": 5, "agreeing": 4, "invalidRuns": 0, "scalesPx": first}
    assert stopped["atoms"][0] == {"index": 0, "symbol": "C", "x": 0.25, "y": 0.75, "confidence": 0.99}
    assert stopped["atoms"][1]["confidence"] is None  # absent stays absent
    assert stopped["bonds"] == [{"begin": 0, "end": 1, "bondType": "single", "confidence": 0.98}]
    full = captured[1]
    assert full["type"] == "result" and full["smiles"] == "CO", full
    # 3 CO in the first pass plus the ten default (CO) sizes; the two OC=O runs dissent.
    assert full["agreement"] == {"runs": 15, "agreeing": 13, "invalidRuns": 0, "scalesPx": every}
    assert full["confidence"] == 0.93 and full["molfile"] == "fixture-760"
    invalid_lost = captured[2]
    assert invalid_lost["type"] == "result" and invalid_lost["smiles"] == "CCO", invalid_lost
    assert invalid_lost["molfile"] == "fixture-1000" and invalid_lost["confidence"] == 0.3
    assert invalid_lost["agreement"] == {"runs": 15, "agreeing": 3, "invalidRuns": 11, "scalesPx": every}
    all_invalid = captured[3]
    assert all_invalid == {"id": "r4", "type": "error", "code": "recognition_failed",
                           "message": ALL_RUNS_INVALID_MESSAGE}, all_invalid
    assert captured[4]["type"] == "error" and captured[4]["code"] == "recognition_failed", captured[4]
    assert captured[4]["message"] == "model exploded"
    assert captured[5]["type"] == "error" and captured[5]["id"] is None
    assert captured[6]["code"] == "invalid_image" and captured[6]["id"] == "r6"
    assert captured[7]["code"] == "invalid_image" and captured[7]["id"] == "r7"
    unanimous = captured[8]
    assert unanimous["id"] == "r8" and unanimous["agreement"]["agreeing"] == 5
    assert unanimous["agreement"]["runs"] == 5 and unanimous["agreement"]["invalidRuns"] == 0
    assert unanimous["confidence"] == 0.93 and unanimous["molfile"] == "fixture-800"
    for message in captured:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        assert "\n" not in line and json.loads(line) == message
        emit(message)
    emit({"type": "selftest", "protocol": PROTOCOL_VERSION, "rdkitChecked": rdkit_checked, "ok": True})
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()

    claim_stdout()
    if not args.checkpoint:
        emit({"type": "fatal", "code": "model_load_failed", "message": "--checkpoint is required"})
        return 2
    try:
        import importlib.metadata

        import numpy
        import PIL  # noqa: F401 - fail at load, not at the first request
        import torch
        from molscribe import MolScribe
        from rdkit import RDLogger

        RDLogger.DisableLog("rdApp.*")  # an unparsable candidate is an expected vote, not log noise
        model = MolScribe(args.checkpoint, device=torch.device("cpu"))
        try:
            molscribe_version = importlib.metadata.version("MolScribe")
        except importlib.metadata.PackageNotFoundError:
            molscribe_version = "unknown"
    except Exception as problem:  # noqa: BLE001 - reported to the host, then exit non-zero
        log("model load failed: {!r}".format(problem))
        emit({"type": "fatal", "code": "model_load_failed", "message": str(problem) or type(problem).__name__})
        return 1

    def predict(image):
        # MolScribe's predict_image takes an RGB array, exactly what predict_image_file produces
        # after cv2.imread + BGR->RGB; handing it the flattened image skips the lossy OpenCV read.
        return model.predict_image(numpy.asarray(image), return_atoms_bonds=True, return_confidence=True)

    def recognize(path):
        return recognize_consensus(predict, rdkit_canonical_smiles, path)

    emit({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "molscribeVersion": molscribe_version,
        "torchVersion": str(torch.__version__),
    })
    return serve(recognize, sys.stdin)


if __name__ == "__main__":
    sys.exit(main())
