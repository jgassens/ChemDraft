#!/usr/bin/env python3
"""Orthonym JSON-Lines sidecar for ChemDraft (protocol 1).

Stdin and stdout carry one JSON object per line; stderr is log only. The host spawns
`python -I -B orthonym_sidecar.py` from the naming engine's virtual environment, with the
environment described below. Messages:

    out  {"type":"ready","protocol":1,"orthonymVersion":"1.0.8","rdkitVersion":"...","jvm":"jpype"}
    out  {"type":"fatal","code":"jvm_unavailable"|"jar_missing"|"reduced_mode","message":"..."}
         (the process exits 1 right after a fatal line)
    in   {"id":"n-1","type":"name","smiles":"<host canonical isomeric SMILES>"}
    out  {"id":"n-1","type":"result","name":"..."|null,"tier":"...","isPin":true,"opsin":"...",
          "gateOutcome":"...","limitCode":null,"stereoUnexpressed":false,"source":"...",
          "elapsedMs":25}
    out  {"id":"n-1","type":"error","code":"invalid_smiles"|"namer_raised","message":"..."}
    out  {"id":null,"type":"error","code":"bad_request","message":"..."}
         (a line that is not a valid request; the sidecar keeps serving)
    in   {"type":"shutdown"}   (EOF on stdin also ends the process, with exit 0)

A request is answered completely before the next line is read, so there is one request at a
time; the host answers `busy` itself for anything that arrives meanwhile. `name` is null when
Orthonym abstains (its `tier` is then "abstain" and its label is not a name). Whether a result
is acceptable is the host's decision (tier, opsin, gateOutcome, stereoUnexpressed) and then the
host's own OPSIN read-back; this file only reports what Orthonym said.

Stdout is reserved for the protocol. Before any other import, file descriptor 1 is pointed at
stderr, so a stray print(), RDKit message or JVM warning lands in the log instead of
corrupting a protocol line.

Environment (set by the host; see docs/architecture/naming-engine.md):
  JAVA_HOME             ChemDraft's bundled JRE. <JAVA_HOME>/bin is put first on PATH here, because
                        Orthonym's fallback paths run a bare `java` from PATH.
  ORTHONYM_OPSIN_JAR    absolute path of the vendored OPSIN jar
  ORTHONYM_CENTRES_JAR  absolute path of the centres jar (the host has verified its SHA-256)
  ORTHONYM_NO_DOWNLOAD  forced to 1 here: the engine never downloads anything
Refused: ORTHONYM_ALLOW_REDUCED (any value) and ORTHONYM_DISABLE_JPYPE (any value) end in a
`reduced_mode` fatal, because either would let Orthonym name with weaker validation. The JVM
option variables (JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, JDK_JAVA_OPTIONS) are removed.

`--selftest` runs the protocol against a stubbed namer in child processes: no Orthonym, RDKit
or JVM needed, plain python3 is enough. The stub (`--selftest-child`) reports orthonymVersion
"selftest-stub", which the host's version pin rejects, so it can never serve real requests.
"""

import json
import os
import sys
import time

PROTOCOL_VERSION = 1
# The host caps SMILES at 5000 characters; a request line carries a little more than that.
MAX_SMILES_CHARS = 5000
MAX_LINE_BYTES = 64 * 1024
MAX_ID_CHARS = 64
WARMUP_SMILES = "CCO"
JVM_OPTION_VARIABLES = ("JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS")
REDUCED_MODE_VARIABLES = ("ORTHONYM_ALLOW_REDUCED", "ORTHONYM_DISABLE_JPYPE")

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
    print("[orthonym-sidecar] {}".format(message), file=sys.stderr, flush=True)


class Fatal(Exception):
    """The sidecar must not serve. `code` is one of the protocol's fatal codes."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class InvalidSmiles(Exception):
    """The SMILES did not parse."""


# --- environment -----------------------------------------------------------------------------


def jvm_library_candidates(java_home):
    """Where a jlink image keeps the JVM library, for each platform."""
    return [
        os.path.join(java_home, "lib", "server", "libjvm.dylib"),
        os.path.join(java_home, "lib", "server", "libjvm.so"),
        os.path.join(java_home, "bin", "server", "jvm.dll"),
    ]


def prepare_environment(env):
    """Validate and normalise the child environment in place; raise Fatal on a refusal.

    Takes the mapping explicitly (os.environ in production) so --selftest can drive it.
    """
    for name in REDUCED_MODE_VARIABLES:
        if name in env:
            raise Fatal(
                "reduced_mode",
                "{} is set; the naming engine never runs with weaker validation.".format(name),
            )
    for name in JVM_OPTION_VARIABLES:
        env.pop(name, None)
    # The jars come from the host; the engine must never reach for the network.
    env["ORTHONYM_NO_DOWNLOAD"] = "1"

    java_home = env.get("JAVA_HOME", "")
    if not java_home or not os.path.isdir(java_home):
        raise Fatal("jvm_unavailable", "JAVA_HOME is not set to ChemDraft's bundled runtime.")
    if not any(os.path.isfile(p) for p in jvm_library_candidates(java_home)):
        raise Fatal("jvm_unavailable", "The bundled runtime has no JVM library under JAVA_HOME.")
    # Orthonym's fallback paths run a bare `java`; make sure that is the bundled one.
    env["PATH"] = os.path.join(java_home, "bin") + os.pathsep + env.get("PATH", "")

    for variable, what in (("ORTHONYM_OPSIN_JAR", "OPSIN"), ("ORTHONYM_CENTRES_JAR", "centres")):
        path = env.get(variable, "")
        if not path or not os.path.isabs(path) or not os.path.isfile(path):
            raise Fatal("jar_missing", "The {} jar was not given by the host or is not a file.".format(what))


# --- engine ----------------------------------------------------------------------------------


def load_engine():
    """Import Orthonym once and return (namer, versions). Raises Fatal if it cannot be trusted."""
    import jpype
    import orthonym
    import rdkit
    from orthonym import jars, jvm_bridge
    from rdkit import Chem

    if jars.allow_reduced():
        raise Fatal("reduced_mode", "Orthonym is in reduced mode; refusing to serve.")
    try:
        namer = orthonym.Orthonym(general_fallback=True)
    except jars.JarUnavailable as exc:
        raise Fatal("jar_missing", "Orthonym could not resolve its jars: {}".format(exc))

    # Orthonym falls back quietly to a subprocess path when the in-process JVM is down, so ask
    # it directly instead of trusting that construction succeeded.
    if not (jvm_bridge._ensure_jvm() and jpype.isJVMStarted()):
        raise Fatal("jvm_unavailable", "The in-process JVM did not start.")
    if not (jvm_bridge.opsin_available() and jvm_bridge.centres_available()):
        raise Fatal("jar_missing", "The OPSIN or centres jar is not loaded in the JVM.")
    for variable, loaded in (
        ("ORTHONYM_OPSIN_JAR", jvm_bridge._OPSIN_JAR),
        ("ORTHONYM_CENTRES_JAR", jvm_bridge._CENTRES_JAR),
    ):
        if not loaded or os.path.realpath(loaded) != os.path.realpath(os.environ[variable]):
            raise Fatal("jar_missing", "The JVM loaded a jar other than {}.".format(variable))

    def name_one(smiles):
        if Chem.MolFromSmiles(smiles) is None:
            raise InvalidSmiles("RDKit could not parse the SMILES.")
        return namer.name_tiered(smiles)

    versions = {"orthonymVersion": orthonym.__version__, "rdkitVersion": rdkit.__version__}
    return name_one, versions


def stub_engine():
    """The --selftest stand-in: names nothing real, and makes noise on stdout on purpose."""

    def name_one(smiles):
        print("stub noise via print", flush=True)
        os.write(1, b"stub noise via fd 1\n")
        if smiles == "invalid":
            raise InvalidSmiles("stub: invalid")
        if smiles == "boom":
            raise RuntimeError("stub: namer exploded")
        if smiles == "[Fe]":
            return {"name": "label", "tier": "abstain", "is_pin": False, "opsin": "n/a",
                    "gate_outcome": "not_run", "limit_code": "UNSUPPORTED_ELEMENT",
                    "stereo_unexpressed": False, "source": "abstain"}
        return {"name": "stub-" + smiles, "tier": "pin_verified", "is_pin": True,
                "opsin": "verified", "gate_outcome": "self_consistency_verified",
                "limit_code": None, "stereo_unexpressed": False, "source": "pin_path"}

    return name_one, {"orthonymVersion": "selftest-stub", "rdkitVersion": "selftest-stub"}


def result_payload(request_id, raw, elapsed_ms):
    tier = raw.get("tier")
    name = raw.get("name")
    return {
        "id": request_id,
        "type": "result",
        # An abstention's "name" is a label saying there is none; it is never a name.
        "name": name if isinstance(name, str) and name and tier != "abstain" else None,
        "tier": tier,
        "isPin": bool(raw.get("is_pin")),
        "opsin": raw.get("opsin"),
        "gateOutcome": raw.get("gate_outcome"),
        "limitCode": raw.get("limit_code"),
        "stereoUnexpressed": bool(raw.get("stereo_unexpressed")),
        "source": raw.get("source"),
        "elapsedMs": elapsed_ms,
    }


# --- requests --------------------------------------------------------------------------------


class BadRequest(Exception):
    pass


def has_control_character(text):
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in text)


def parse_request(line_bytes):
    """Strictly parse one request line into ("name", id, smiles) or ("shutdown",)."""
    if len(line_bytes) > MAX_LINE_BYTES:
        raise BadRequest("request line is too long")
    try:
        text = line_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise BadRequest("request line is not valid UTF-8")
    text = text.rstrip("\r\n")
    if not text.strip():
        raise BadRequest("empty request line")
    try:
        message = json.loads(
            text,
            parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)),
            object_pairs_hook=_no_duplicate_keys,
        )
    except ValueError as exc:
        raise BadRequest("request is not valid JSON: {}".format(exc))
    if not isinstance(message, dict):
        raise BadRequest("request must be a JSON object")
    kind = message.get("type")
    if kind == "shutdown":
        if set(message) != {"type"}:
            raise BadRequest("shutdown takes no other fields")
        return ("shutdown",)
    if kind != "name":
        raise BadRequest("unknown request type")
    if set(message) != {"id", "type", "smiles"}:
        raise BadRequest("a name request has exactly the fields id, type and smiles")
    request_id = message["id"]
    if not isinstance(request_id, str) or not request_id or len(request_id) > MAX_ID_CHARS \
            or has_control_character(request_id):
        raise BadRequest("id must be a short non-empty string")
    smiles = message["smiles"]
    if not isinstance(smiles, str) or not smiles or smiles != smiles.strip() \
            or len(smiles) > MAX_SMILES_CHARS or has_control_character(smiles):
        raise BadRequest("smiles must be a non-empty string of at most {} characters without "
                         "control characters or surrounding whitespace".format(MAX_SMILES_CHARS))
    return ("name", request_id, smiles)


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key {!r}".format(key))
        result[key] = value
    return result


def read_line(stream):
    """One line from the binary stdin, or None at EOF. An over-long line is drained and
    returned as MAX_LINE_BYTES + 1 bytes so parse_request refuses it."""
    line = stream.readline(MAX_LINE_BYTES + 1)
    if not line:
        return None
    if len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
        while True:
            rest = stream.readline(MAX_LINE_BYTES)
            if not rest or rest.endswith(b"\n"):
                break
    return line


def serve(name_one):
    stdin = sys.stdin.buffer
    while True:
        line = read_line(stdin)
        if line is None:
            return
        try:
            request = parse_request(line)
        except BadRequest as exc:
            emit({"id": None, "type": "error", "code": "bad_request", "message": str(exc)})
            continue
        if request[0] == "shutdown":
            return
        _, request_id, smiles = request
        started = time.monotonic()
        try:
            raw = name_one(smiles)
        except InvalidSmiles as exc:
            emit({"id": request_id, "type": "error", "code": "invalid_smiles", "message": str(exc)})
            continue
        except Exception as exc:  # the namer is third-party; one bad molecule must not end the process
            log("namer raised {}: {}".format(type(exc).__name__, exc))
            emit({"id": request_id, "type": "error", "code": "namer_raised",
                  "message": "{}: {}".format(type(exc).__name__, str(exc)[:300])})
            continue
        emit(result_payload(request_id, raw, int((time.monotonic() - started) * 1000)))


def run(stub):
    """Start up, announce ready, serve. Returns the process exit code."""
    claim_stdout()
    try:
        prepare_environment(os.environ)
        name_one, versions = stub_engine() if stub else load_engine()
        if not stub:
            warm = name_one(WARMUP_SMILES)
            if warm.get("tier") == "abstain" or warm.get("opsin") != "verified":
                raise Fatal("jvm_unavailable",
                            "Warm-up naming of {} was not verified by OPSIN.".format(WARMUP_SMILES))
    except Fatal as fatal:
        log("fatal {}: {}".format(fatal.code, fatal.message))
        emit({"type": "fatal", "code": fatal.code, "message": fatal.message})
        return 1
    emit({"type": "ready", "protocol": PROTOCOL_VERSION,
          "orthonymVersion": versions["orthonymVersion"],
          "rdkitVersion": versions["rdkitVersion"], "jvm": "jpype"})
    serve(name_one)
    return 0


# --- selftest --------------------------------------------------------------------------------


def selftest():
    import shutil
    import subprocess
    import tempfile

    failures = []

    def check(condition, label):
        if not condition:
            failures.append(label)
            print("FAIL: " + label, file=sys.stderr)

    root = tempfile.mkdtemp(prefix="orthonym-sidecar-selftest-")
    try:
        java_home = os.path.join(root, "jre")
        for candidate in jvm_library_candidates(java_home):
            if "bin" + os.sep + "server" in candidate and sys.platform != "win32":
                continue
            if "libjvm" in candidate and sys.platform == "win32":
                continue
            os.makedirs(os.path.dirname(candidate), exist_ok=True)
            open(candidate, "wb").close()
            break
        opsin = os.path.join(root, "opsin.jar")
        centres = os.path.join(root, "centres.jar")
        for jar in (opsin, centres):
            open(jar, "wb").close()
        good_env = {
            "JAVA_HOME": java_home,
            "ORTHONYM_OPSIN_JAR": opsin,
            "ORTHONYM_CENTRES_JAR": centres,
            "JAVA_TOOL_OPTIONS": "-Xint",
        }

        def spawn(env_overrides, lines, wait=True):
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith("ORTHONYM_") and k not in JVM_OPTION_VARIABLES}
            env.update(good_env)
            for key, value in env_overrides.items():
                if value is None:
                    env.pop(key, None)
                else:
                    env[key] = value
            proc = subprocess.run(
                [sys.executable, "-I", "-B", os.path.abspath(__file__), "--selftest-child"],
                input=b"".join(lines), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=60,
            )
            out = proc.stdout.decode("utf-8").splitlines()
            return proc, [json.loads(x) for x in out], proc.stderr.decode("utf-8", "replace")

        def req(request_id, smiles):
            return (json.dumps({"id": request_id, "type": "name", "smiles": smiles}) + "\n").encode()

        # 1. Normal session, including every error path and the fd-1 redirect.
        proc, out, err = spawn({}, [
            req("n-1", "CCO"),
            req("n-2", "invalid"),
            req("n-3", "boom"),
            req("n-4", "[Fe]"),
            b"this is not json\n",
            b'{"id":"n-5","type":"name","smiles":"CCO","extra":1}\n',
            b'{"id":"n-6","type":"name","smiles":"CCO","smiles":"CC"}\n',
            b'{"id":"","type":"name","smiles":"CCO"}\n',
            b'{"id":"n-7","type":"name","smiles":" CCO"}\n',
            b'{"id":"n-8","type":"name","smiles":"C\\u0000C"}\n',
            b'{"id":"n-9","type":"name","smiles":NaN}\n',
            b'[1,2]\n',
            b'\xff\xfe\n',
            b'{"type":"shutdown","id":"x"}\n',
            b'{"id":"n-10","type":"frobnicate"}\n',
            (json.dumps({"id": "n-11", "type": "name", "smiles": "C" * (MAX_SMILES_CHARS + 1)}) + "\n").encode(),
            b"x" * (MAX_LINE_BYTES + 100) + b"\n",
            req("n-12", "C"),
            b'{"type":"shutdown"}\n',
            req("n-13", "never served"),
        ])
        check(proc.returncode == 0, "normal session exits 0 (got {})".format(proc.returncode))
        check(out and out[0] == {"type": "ready", "protocol": 1, "jvm": "jpype",
                                 "orthonymVersion": "selftest-stub",
                                 "rdkitVersion": "selftest-stub"}, "ready line is first and exact")
        check("stub noise via print" in err and "stub noise via fd 1" in err,
              "print() and raw fd-1 writes land on stderr")
        check(all(isinstance(line, dict) for line in out), "every stdout line is a JSON object")
        check(not any("noise" in json.dumps(line) for line in out), "no noise on stdout")
        by_id = {line.get("id"): line for line in out[1:]}
        check(by_id.get("n-1", {}).get("name") == "stub-CCO" and by_id["n-1"].get("isPin") is True
              and by_id["n-1"].get("opsin") == "verified" and by_id["n-1"].get("limitCode") is None
              and by_id["n-1"].get("stereoUnexpressed") is False
              and isinstance(by_id["n-1"].get("elapsedMs"), int), "result line is complete")
        check(by_id.get("n-2", {}).get("code") == "invalid_smiles", "invalid_smiles error")
        check(by_id.get("n-3", {}).get("code") == "namer_raised", "namer_raised error")
        check(by_id.get("n-4", {}).get("name") is None
              and by_id["n-4"].get("tier") == "abstain"
              and by_id["n-4"].get("limitCode") == "UNSUPPORTED_ELEMENT",
              "an abstention reports name null with its limit code")
        bad = [line for line in out if line.get("code") == "bad_request"]
        check(len(bad) == 13, "13 malformed lines each get one bad_request (got {})".format(len(bad)))
        check(all(line.get("id") is None for line in bad), "bad_request carries id null")
        check(by_id.get("n-12", {}).get("type") == "result", "serving continues after malformed lines")
        check("n-13" not in by_id, "nothing is served after shutdown")
        check("n-5" not in by_id and "n-7" not in by_id and "n-8" not in by_id,
              "extra fields, padded and control-character SMILES are rejected")

        # 2. EOF without shutdown ends cleanly.
        proc, out, _ = spawn({}, [req("n-1", "CCO")])
        check(proc.returncode == 0 and len(out) == 2, "EOF ends the process with exit 0")

        # 3. Environment refusals, one fatal line and exit 1 each.
        def refusal(label, overrides, code):
            proc, out, _ = spawn(overrides, [req("n-1", "CCO")])
            check(proc.returncode == 1 and len(out) == 1 and out[0].get("type") == "fatal"
                  and out[0].get("code") == code,
                  "{} -> fatal {} (got rc {} {})".format(label, code, proc.returncode, out))

        refusal("ORTHONYM_ALLOW_REDUCED=1", {"ORTHONYM_ALLOW_REDUCED": "1"}, "reduced_mode")
        refusal("ORTHONYM_ALLOW_REDUCED=0", {"ORTHONYM_ALLOW_REDUCED": "0"}, "reduced_mode")
        refusal("ORTHONYM_DISABLE_JPYPE=1", {"ORTHONYM_DISABLE_JPYPE": "1"}, "reduced_mode")
        refusal("no JAVA_HOME", {"JAVA_HOME": None}, "jvm_unavailable")
        refusal("JAVA_HOME without a JVM library", {"JAVA_HOME": root}, "jvm_unavailable")
        refusal("no OPSIN jar variable", {"ORTHONYM_OPSIN_JAR": None}, "jar_missing")
        refusal("OPSIN jar that is not a file", {"ORTHONYM_OPSIN_JAR": os.path.join(root, "nope.jar")},
                "jar_missing")
        refusal("relative centres jar", {"ORTHONYM_CENTRES_JAR": "centres.jar"}, "jar_missing")

        # 4. prepare_environment in-process: scrubbing, forced no-download, PATH.
        env = dict(good_env, JDK_JAVA_OPTIONS="-Xint", _JAVA_OPTIONS="-Xint", PATH="/usr/bin",
                   ORTHONYM_NO_DOWNLOAD="0")
        prepare_environment(env)
        check(not any(name in env for name in JVM_OPTION_VARIABLES), "JVM option variables removed")
        check(env["ORTHONYM_NO_DOWNLOAD"] == "1", "downloads are forced off")
        check(env["PATH"].split(os.pathsep)[0] == os.path.join(java_home, "bin"),
              "the bundled JRE comes first on PATH")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    if failures:
        print("selftest: {} failure(s)".format(len(failures)), file=sys.stderr)
        return 1
    print("selftest: all checks passed")
    return 0


def main(argv):
    if argv[1:] == ["--selftest"]:
        return selftest()
    if argv[1:] == ["--selftest-child"]:
        return run(stub=True)
    if len(argv) > 1:
        print("usage: orthonym_sidecar.py [--selftest]", file=sys.stderr)
        return 2
    return run(stub=False)


if __name__ == "__main__":
    code = main(sys.argv)
    sys.stdout.flush()
    sys.stderr.flush()
    # Leaves without waiting on JPype's JVM shutdown: a JVM thread that never finishes would
    # otherwise hang the exit, and the host kills the process tree on timeout anyway.
    os._exit(code)
