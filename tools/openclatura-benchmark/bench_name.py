"""Stage 1 of the OpenClatura benchmark: structure -> name.

Emits TSV: id, input_smiles, canonical_input, status, name_or_error

`status` is one of:
  named    - OpenClatura returned a non-empty name
  declined - it returned nothing (the SAFE failure: no name rather than a wrong one)
  error    - it raised
  unusable - it returned a name we cannot round-trip through OPSIN's line protocol
             (a tab or newline inside the name would forge the delimiter)
"""
import sys, time, signal
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
import openclatura as oc

PER_STRUCTURE_TIMEOUT = 20  # seconds; a namer that hangs must not stall the run


class Timeout(Exception):
    pass


def _alarm(signum, frame):
    raise Timeout()


signal.signal(signal.SIGALRM, _alarm)


def canonical(smiles):
    mol = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(mol) if mol is not None else None


def main(path, out_path, limit=None):
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

    started = time.time()
    with open(out_path, "w") as out:
        for index, (ident, smiles) in enumerate(rows):
            canon = canonical(smiles)
            if canon is None:
                out.write(f"{ident}\t{smiles}\t\terror\tRDKit could not parse the input\n")
                continue
            try:
                signal.alarm(PER_STRUCTURE_TIMEOUT)
                analysis = oc.analyze_smiles(canon)
                signal.alarm(0)
                name = (analysis.name or "").strip()
            except Timeout:
                signal.alarm(0)
                out.write(f"{ident}\t{smiles}\t{canon}\terror\ttimeout after {PER_STRUCTURE_TIMEOUT}s\n")
                continue
            except Exception as exc:  # noqa: BLE001 - any failure is data here
                signal.alarm(0)
                out.write(f"{ident}\t{smiles}\t{canon}\terror\t{type(exc).__name__}: {str(exc)[:160]}\n")
                continue

            if not name:
                out.write(f"{ident}\t{smiles}\t{canon}\tdeclined\t\n")
            elif "\t" in name or "\n" in name or "\r" in name:
                out.write(f"{ident}\t{smiles}\t{canon}\tunusable\t{name[:120]!r}\n")
            else:
                out.write(f"{ident}\t{smiles}\t{canon}\tnamed\t{name}\n")

            if (index + 1) % 250 == 0:
                rate = (index + 1) / (time.time() - started)
                print(f"  {index + 1}/{len(rows)}  {rate:.1f}/s", file=sys.stderr, flush=True)

    elapsed = time.time() - started
    print(f"stage 1 done: {len(rows)} structures in {elapsed:.1f}s ({len(rows)/elapsed:.1f}/s)", file=sys.stderr)


if __name__ == "__main__":
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
    main(sys.argv[1], sys.argv[2], limit)
