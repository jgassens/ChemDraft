#!/usr/bin/env python3
"""MolScribe JSON-Lines sidecar for ChemDraft (protocol 1).

Stdin and stdout carry one JSON object per line; stderr is log only. The normal
path imports and loads MolScribe exactly once. `--selftest` exercises the
framing and the output mapping with a fake model, without torch or MolScribe.

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

PROTOCOL_VERSION = 1

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


# MolScribe's `predict_image_file(..., return_atoms_bonds=True, return_confidence=True)`
# (molscribe/interface.py at the pinned commit) returns:
#   {"smiles": str, "molfile": str, "confidence": float,
#    "atoms": [{"atom_symbol": str, "x": float, "y": float, "confidence": float}],
#    "bonds": [{"bond_type": str, "endpoint_atoms": (int, int), "confidence": float}]}
# x and y are fractions of the image width and height. Each key is mapped as-is;
# a missing key becomes null rather than a guessed value.


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


def map_prediction(request_id, prediction, elapsed_ms):
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
        "elapsedMs": int(elapsed_ms),
    }


def error(request_id, code, message):
    return {"id": request_id, "type": "error", "code": code, "message": message}


def handle_line(model, line, image_is_readable):
    """Answer one request line. Returns False when the sidecar should exit."""
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
    if not image_is_readable(image_path):
        emit(error(request_id, "invalid_image", "The image could not be decoded."))
        return True
    started = time.monotonic()
    try:
        prediction = model.predict_image_file(image_path, return_atoms_bonds=True, return_confidence=True)
        emit(map_prediction(request_id, prediction, round((time.monotonic() - started) * 1000)))
    except Exception as problem:  # noqa: BLE001 - any model failure is reported, never fatal
        log("recognition failed: {!r}".format(problem))
        emit(error(request_id, "recognition_failed", str(problem) or type(problem).__name__))
    return True


def serve(model, image_is_readable, stream):
    for line in iter(stream.readline, ""):
        line = line.strip()
        if line and not handle_line(model, line, image_is_readable):
            return 0
    return 0


def selftest():
    """Drive the protocol with a fake model; prints one line per response, then a summary."""

    class FakeModel:
        def predict_image_file(self, path, return_atoms_bonds, return_confidence):
            assert return_atoms_bonds and return_confidence
            if path.endswith("boom.png"):
                raise RuntimeError("model exploded")
            return {
                "smiles": "CO",
                "molfile": "fixture",
                "confidence": 0.93,
                "atoms": [
                    {"atom_symbol": "C", "x": 0.25, "y": 0.75, "confidence": 0.99},
                    {"atom_symbol": "O", "x": 0.5, "y": 0.5},
                ],
                "bonds": [{"bond_type": "single", "endpoint_atoms": (0, 1), "confidence": 0.98}],
            }

    captured = []
    global emit
    real_emit = emit
    emit = captured.append
    try:
        with tempfile.TemporaryDirectory() as directory:
            good = os.path.join(directory, "good.png")
            boom = os.path.join(directory, "boom.png")
            for path in (good, boom):
                with open(path, "wb") as handle:
                    handle.write(b"fixture")
            lines = [
                json.dumps({"id": "r1", "type": "recognize", "imagePath": good}),
                "not json",
                json.dumps({"id": "r2", "type": "recognize", "imagePath": "relative.png"}),
                json.dumps({"id": "r3", "type": "recognize", "imagePath": boom}),
                json.dumps({"type": "shutdown"}),
                json.dumps({"id": "never", "type": "recognize", "imagePath": good}),
            ]
            status = serve(FakeModel(), lambda _path: True, io.StringIO("\n".join(lines) + "\n"))
    finally:
        emit = real_emit

    assert status == 0
    assert len(captured) == 4, captured  # nothing after shutdown
    result = captured[0]
    assert result["type"] == "result" and result["id"] == "r1"
    assert result["atoms"][0] == {"index": 0, "symbol": "C", "x": 0.25, "y": 0.75, "confidence": 0.99}
    assert result["atoms"][1]["confidence"] is None  # absent stays absent
    assert result["bonds"] == [{"begin": 0, "end": 1, "bondType": "single", "confidence": 0.98}]
    assert captured[1]["type"] == "error" and captured[1]["id"] is None
    assert captured[2]["code"] == "invalid_image" and captured[2]["id"] == "r2"
    assert captured[3]["code"] == "recognition_failed" and captured[3]["id"] == "r3"
    for message in captured:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        assert "\n" not in line and json.loads(line) == message
        emit(message)
    emit({"type": "selftest", "protocol": PROTOCOL_VERSION, "ok": True})
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

        import cv2
        import torch
        from molscribe import MolScribe

        model = MolScribe(args.checkpoint, device=torch.device("cpu"))
        try:
            molscribe_version = importlib.metadata.version("MolScribe")
        except importlib.metadata.PackageNotFoundError:
            molscribe_version = "unknown"
    except Exception as problem:  # noqa: BLE001 - reported to the host, then exit non-zero
        log("model load failed: {!r}".format(problem))
        emit({"type": "fatal", "code": "model_load_failed", "message": str(problem) or type(problem).__name__})
        return 1

    def image_is_readable(path):
        # MolScribe reads images with cv2.imread, which returns None instead of raising.
        return cv2.imread(path) is not None

    emit({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "molscribeVersion": molscribe_version,
        "torchVersion": str(torch.__version__),
    })
    return serve(model, image_is_readable, sys.stdin)


if __name__ == "__main__":
    sys.exit(main())
