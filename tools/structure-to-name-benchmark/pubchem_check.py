"""Independent check: a namer's round-tripped names against PubChem's computed IUPAC names.

    python pubchem_check.py <stage2.tsv> <out.csv> --cache-dir DIR [--n 200] [--seed 20261021]
                            [--java PATH] [--opsin-jar PATH]

Why: the round-trip oracle is OPSIN, and a namer that validates its own names with OPSIN (Orthonym)
passes it partly by construction. PubChem's IUPAC name comes from a different generator, so it is an
outside reference. For a seeded random sample of structures whose name round-tripped:

  1. the InChIKey of the input (RDKit's InChI) is looked up in PubChem (PUG REST, one request at a time,
     at most ~3 per second, every response cached in --cache-dir so a re-run sends nothing);
  2. the two names are compared as strings: exact, and ignoring case;
  3. PubChem's name is read by the same OPSIN, and its structure compared with the input by the stage-2
     rule (round-trip / stereo-lost / MISNAMED / name-unparseable). That separates "different spelling
     of the same structure" from "PubChem's record is a different structure".

PubChem's name is not ground truth either: it is often not the preferred IUPAC name. A disagreement is
a lead to read, not a verdict.
"""
import argparse
import csv
import json
import os
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

from rdkit import Chem, RDLogger

from bench_roundtrip import canonical, run_opsin, score

RDLogger.DisableLog("rdApp.*")

PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/{key}/property/IUPACName/JSON"
MIN_INTERVAL = 0.35  # seconds between requests; PubChem asks for no more than 5 per second


def ssl_context():
    for cafile in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/cert.pem"):
        if cafile and os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


class PubChem:
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.context = ssl_context()
        self.last = 0.0
        self.sent = 0

    def iupac_name(self, inchikey):
        """(status, name): status is found / not-found / error:<reason>."""
        path = os.path.join(self.cache_dir, f"{inchikey}.json")
        if os.path.exists(path):
            with open(path) as handle:
                cached = json.load(handle)
            return cached["status"], cached.get("name", "")
        wait = MIN_INTERVAL - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        url = PUG.format(key=urllib.parse.quote(inchikey))
        request = urllib.request.Request(url, headers={"User-Agent": "chemdraft-structure-to-name-benchmark"})
        status, name = "error", ""
        try:
            with urllib.request.urlopen(request, timeout=30, context=self.context) as resp:
                props = json.load(resp)["PropertyTable"]["Properties"]
                names = sorted({p.get("IUPACName", "") for p in props} - {""})
                # Several CIDs can share an InChIKey; keep the first by CID, and record that it happened.
                first = min(props, key=lambda p: p.get("CID", 0)).get("IUPACName", "")
                status = "found" if first else "no-iupac-name"
                if len(names) > 1:
                    status = "found-several-names"
                name = first
        except urllib.error.HTTPError as exc:
            status = "not-found" if exc.code == 404 else f"error:HTTP {exc.code}"
        except Exception as exc:  # noqa: BLE001 - a network failure is a data point, not a crash
            status = f"error:{type(exc).__name__}"
        self.last = time.time()
        self.sent += 1
        if not status.startswith("error"):
            with open(path, "w") as handle:
                json.dump({"inchikey": inchikey, "status": status, "name": name}, handle)
        return status, name


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage2")
    parser.add_argument("out")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--n", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20261021)
    parser.add_argument("--exclude-named-in", default=None,
                        help="another stage-2 file; sample only structures it did NOT name (e.g. names "
                             "Orthonym's wider tier adds over its default tier)")
    parser.add_argument("--java", default=os.environ.get("OPSIN_JAVA"))
    parser.add_argument("--opsin-jar", default=os.environ.get("OPSIN_JAR"))
    args = parser.parse_args(argv)
    if not args.java or not args.opsin_jar:
        parser.error("give --java and --opsin-jar (or set OPSIN_JAVA and OPSIN_JAR)")

    with open(args.stage2) as handle:
        rows = [r for r in csv.DictReader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
                if r["outcome"] == "round-trip"]
    if args.exclude_named_in:
        with open(args.exclude_named_in) as handle:
            named = {r["id"] for r in csv.DictReader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
                     if r["status"] == "named"}
        rows = [r for r in rows if r["id"] not in named]
    sample = random.Random(args.seed).sample(rows, min(args.n, len(rows)))
    sample.sort(key=lambda r: int(r["id"]) if r["id"].isdigit() else r["id"])

    pubchem = PubChem(args.cache_dir)
    looked_up = []
    for index, row in enumerate(sample):
        mol = Chem.MolFromSmiles(row["canonical_input"])
        key = Chem.MolToInchiKey(mol) if mol is not None else ""
        status, name = pubchem.iupac_name(key) if key else ("error:no-inchikey", "")
        looked_up.append((row, key, status, name))
        if (index + 1) % 25 == 0:
            print(f"  {index + 1}/{len(sample)} ({pubchem.sent} requests sent)", file=sys.stderr, flush=True)

    with_name = [item for item in looked_up if item[3]]
    parsed = run_opsin([item[3] for item in with_name], args.java, args.opsin_jar)
    opsin_of = {item[0]["id"]: smiles for item, smiles in zip(with_name, parsed)}

    tally = Counter()
    with open(args.out, "w", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["id", "canonical_input", "inchikey", "pubchem_status", "namer_name", "pubchem_name",
                         "exact", "case_insensitive", "pubchem_name_via_opsin"])
        for row, key, status, name in looked_up:
            exact = case = via = ""
            if name:
                exact = str(row["name"] == name)
                case = str(row["name"].lower() == name.lower())
                via = score(canonical(row["canonical_input"]) or row["canonical_input"], opsin_of.get(row["id"], ""))
                tally["exact"] += row["name"] == name
                tally["case"] += row["name"].lower() == name.lower()
                tally[f"opsin:{via}"] += 1
            tally[f"status:{status.split(':')[0]}"] += 1
            writer.writerow([row["id"], row["canonical_input"], key, status, row["name"], name, exact, case, via])

    print(f"sample {len(sample)}, with a PubChem name {len(with_name)}, requests sent {pubchem.sent}")
    for key, value in sorted(tally.items()):
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
