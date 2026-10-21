"""Stage 1 of the structure-to-name benchmark: structure -> name.

    python bench_name.py --namer {openclatura,orthonym} <structures.smi> <stage1.tsv> [--limit N]

Run it with the Python of a venv that has the chosen namer installed. Emits TSV with no header:

    id, input_smiles, canonical_input, status, name_or_error, seconds, namer_meta

The first five columns are the August 2026 format unchanged, so stage 2 reads old and new files alike.
`seconds` is the wall time of the namer call; `namer_meta` is the namer's own account of the result
(Orthonym's provenance row, as JSON; empty for OpenClatura, which reports none).

`status` is one of:
  named    - the namer returned a non-empty name
  declined - it returned nothing (the SAFE failure: no name rather than a wrong one)
  error    - it raised, or timed out
  unusable - it returned a name we cannot round-trip through OPSIN's line protocol
             (a tab or newline inside the name would forge the delimiter)

Orthonym: build one `Orthonym()` at the chosen tier (--orthonym-tier, default the default) and call
`name_tiered`, which says whether a name
was returned and how it was checked. A row with tier `abstain` is a decline, whatever label the `name`
field carries. Orthonym needs a JVM and two jars; set JAVA_HOME, ORTHONYM_OPSIN_JAR and
ORTHONYM_CENTRES_JAR (see README.md) so that it uses ChemDraft's vendored runtime and does no download.
"""
import argparse
import json
import signal
import sys
import time

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

PER_STRUCTURE_TIMEOUT = 20  # seconds; a namer that hangs must not stall the run


class Timeout(Exception):
    pass


def _alarm(signum, frame):
    raise Timeout()


signal.signal(signal.SIGALRM, _alarm)


def canonical(smiles):
    mol = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(mol) if mol is not None else None


class OpenClaturaNamer:
    def __init__(self):
        import openclatura

        self._oc = openclatura
        self.version = getattr(openclatura, "__version__", "?")

    def name(self, smiles):
        return (self._oc.analyze_smiles(smiles).name or "").strip(), ""


class OrthonymNamer:
    META_KEYS = ("tier", "is_pin", "source", "opsin", "gate_outcome", "limit_code", "stereo_unexpressed")

    # The command line's --emit-tier names and the constructor switches behind them.
    TIERS = {
        "default": {},
        "valid": {"general_fallback": True},
    }

    def __init__(self, tier="default"):
        import logging

        import orthonym

        # Orthonym logs a warning for every decline; the TSV already records it.
        logging.getLogger("orthonym").setLevel(logging.ERROR)
        self.version = f"{orthonym.__version__} (tier {tier})"
        self._namer = orthonym.Orthonym(**self.TIERS[tier])

    def name(self, smiles):
        row = self._namer.name_tiered(smiles)
        meta = {key: row.get(key) for key in self.META_KEYS}
        if row.get("tier") == "abstain":
            return "", json.dumps(meta, sort_keys=True)
        return (row.get("name") or "").strip(), json.dumps(meta, sort_keys=True)


NAMERS = {"openclatura": OpenClaturaNamer, "orthonym": OrthonymNamer}


def read_structures(path, limit=None):
    rows = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t") if "\t" in line else line.split()
            smiles = parts[0]
            ident = parts[1] if len(parts) > 1 else str(len(rows) + 1)
            rows.append((ident, smiles))
            if limit and len(rows) >= limit:
                break
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--namer", choices=sorted(NAMERS), required=True)
    parser.add_argument("structures")
    parser.add_argument("out")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--orthonym-tier", choices=sorted(OrthonymNamer.TIERS), default="default",
                        help="Orthonym's emit tier: 'default' returns only verified preferred names, "
                             "'valid' also OPSIN-verified names that are not the preferred name")
    parser.add_argument("--timeout", type=int, default=PER_STRUCTURE_TIMEOUT,
                        help="seconds per structure before it is scored as an error (default %(default)s)")
    args = parser.parse_args(argv)

    if args.namer == "orthonym":
        namer = OrthonymNamer(args.orthonym_tier)
    else:
        namer = NAMERS[args.namer]()
    print(f"namer: {args.namer} {namer.version}", file=sys.stderr)
    rows = read_structures(args.structures, args.limit)

    started = time.time()
    with open(args.out, "w") as out:
        def emit(ident, smiles, canon, status, text, seconds="", meta=""):
            out.write(f"{ident}\t{smiles}\t{canon}\t{status}\t{text}\t{seconds}\t{meta}\n")

        for index, (ident, smiles) in enumerate(rows):
            canon = canonical(smiles)
            if canon is None:
                emit(ident, smiles, "", "error", "RDKit could not parse the input")
                continue
            t0 = time.perf_counter()
            try:
                signal.alarm(args.timeout)
                name, meta = namer.name(canon)
                signal.alarm(0)
            except Timeout:
                signal.alarm(0)
                emit(ident, smiles, canon, "error", f"timeout after {args.timeout}s",
                     f"{time.perf_counter() - t0:.4f}")
                continue
            except Exception as exc:  # noqa: BLE001 - any failure is data here
                signal.alarm(0)
                message = " ".join(f"{type(exc).__name__}: {exc}".split())[:160]
                emit(ident, smiles, canon, "error", message, f"{time.perf_counter() - t0:.4f}")
                continue
            seconds = f"{time.perf_counter() - t0:.4f}"

            if not name:
                emit(ident, smiles, canon, "declined", "", seconds, meta)
            elif "\t" in name or "\n" in name or "\r" in name:
                emit(ident, smiles, canon, "unusable", repr(name[:120]), seconds, meta)
            else:
                emit(ident, smiles, canon, "named", name, seconds, meta)

            if (index + 1) % 250 == 0:
                rate = (index + 1) / (time.time() - started)
                print(f"  {index + 1}/{len(rows)}  {rate:.1f}/s", file=sys.stderr, flush=True)

    elapsed = time.time() - started
    print(f"stage 1 done: {len(rows)} structures in {elapsed:.1f}s ({len(rows)/elapsed:.1f}/s)", file=sys.stderr)


if __name__ == "__main__":
    main()
