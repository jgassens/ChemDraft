"""Prepare the external pKa tail audit without changing or retraining the model.

The product audit itself runs through ``analyzeStructure`` in
``pkaErrorAudit.real.test.ts``.  Python is used only at the data boundary because the two public
benchmark sets are SDF files and the training-family comparison must use the same RDKit family
identity as ``pka_folds.py``.

The generated context is an intermediate, not a benchmark result.  It contains canonical SMILES and
an atom index carried through the same RDKit write traversal, so write it outside the repository
(``/tmp`` is a sensible default) and pass it to the gated Vitest audit:

    python error_audit_prepare.py \
      <QupKake-data-dir> merged-labels.json /tmp/pka-error-audit-context.json
    PKA_ERROR_AUDIT=1 \
      PKA_ERROR_AUDIT_INPUT=/tmp/pka-error-audit-context.json \
      PKA_ERROR_AUDIT_OUTPUT=/tmp/pka-error-audit-report.json \
      pnpm vitest run packages/rdkit-adapter/src/pkaErrorAudit.real.test.ts

The measured value is experimental.  Its site and acidic/basic annotations are not: QupKake assigned
them with ChemAxon Marvin.  That distinction travels on every row because a disagreement between two
site predictors is not experimental evidence that either atom is right.
"""

from __future__ import annotations

import hashlib
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from rdkit import Chem, DataStructs, RDLogger, rdBase
from rdkit.Chem import rdFingerprintGenerator

from parity_features import deprotonated, family_key, neutral_scaffold, written_smiles_with_site
from qupkake_labels import protonated

RDLogger.DisableLog("rdApp.*")

SETS = (
    ("novartis", "novartis_qupkake_pka.sdf"),
    ("literature", "literature_qupkake_pka.sdf"),
)
MORGAN = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)


def canonical(mol: Chem.Mol | None) -> str | None:
    if mol is None:
        return None
    try:
        return Chem.MolToSmiles(mol, isomericSmiles=True)
    except Exception:
        return None


def event_key(acid: Chem.Mol | None, base: Chem.Mol | None) -> str | None:
    """Atom-order-independent identity for one acid/conjugate-base edge."""
    a, b = canonical(acid), canonical(base)
    return f"{a}\t{b}" if a and b else None


def source_class(row: dict) -> str:
    label_source = row.get("label_source")
    if label_source:
        return str(label_source).split(" (")[0]
    ref = str(row.get("ref", ""))
    if ref.startswith("DataWarrior"):
        return "dwar-ibond"
    return "dwar-ibond-literature"


def training_index(rows: list[dict]) -> dict:
    families: dict[str, list[dict]] = defaultdict(list)
    scaffolds: dict[str, list[dict]] = defaultdict(list)
    events: dict[str, list[dict]] = defaultdict(list)
    fingerprints, fingerprint_rows = [], []

    # Fingerprint only one representative per canonical acid.  The nearest-neighbour calculation is
    # a structural proximity diagnostic, not a weighting scheme, so repeating one structure because
    # several sites or sources labelled it must not make it "nearer".
    fingerprinted = set()
    for row in rows:
        acid = Chem.MolFromSmiles(row.get("acid", ""))
        idx = int(row.get("acidAtomIdx", -1))
        if acid is None or idx < 0 or idx >= acid.GetNumAtoms():
            continue
        base = Chem.MolFromSmiles(row["base"]) if row.get("base") else deprotonated(acid, idx)
        family = family_key(acid)
        scaffold = neutral_scaffold(acid)
        record = {
            "pKa": float(row["pKa"]),
            "reference": str(row.get("ref", "")),
            "source": source_class(row),
        }
        if family:
            families[family].append(record)
        if scaffold:
            scaffolds[scaffold].append(record)
        edge = event_key(acid, base)
        if edge:
            events[edge].append(record)

        acid_smiles = canonical(acid)
        if acid_smiles and acid_smiles not in fingerprinted:
            fingerprinted.add(acid_smiles)
            fingerprints.append(MORGAN.GetFingerprint(acid))
            fingerprint_rows.append({"family": family, "source": record["source"]})

    return {
        "families": families,
        "scaffolds": scaffolds,
        "events": events,
        "fingerprints": fingerprints,
        "fingerprintRows": fingerprint_rows,
    }


def consistency_for(target: float, exact: list[dict], family: list[dict]) -> dict:
    if exact:
        values = [row["pKa"] for row in exact]
        median = float(statistics.median(values))
        delta = abs(target - median)
        # 0.5 is not invented for this audit: it is the conflict threshold already enforced when the
        # QupKake experimental labels are ingested by ``qupkake_labels.py``.
        verdict = "same-event-consistent" if delta <= 0.5 else "same-event-conflict"
        return {
            "verdict": verdict,
            "consistencyEstablished": {
                "value": verdict == "same-event-consistent",
                "reason": (
                    None
                    if verdict == "same-event-consistent"
                    else "external target differs by more than the corpus's 0.5-unit conflict threshold"
                ),
            },
            "exactEventMeasurements": len(values),
            "exactEventMedianPka": median,
            "absoluteDifferenceFromMedian": delta,
            "references": sorted({row["reference"] for row in exact if row["reference"]})[:12],
            "sources": sorted({row["source"] for row in exact}),
        }
    if family:
        return {
            "verdict": "same-family-different-or-unresolved-event",
            "consistencyEstablished": {
                "value": "unknown",
                "reason": "training rows share a molecular family but no exact acid/conjugate-base event",
            },
            "exactEventMeasurements": 0,
            "references": [],
            "sources": sorted({row["source"] for row in family}),
        }
    return {
        "verdict": "no-training-family-overlap",
        "consistencyEstablished": {
            "value": "unknown",
            "reason": "no exact acid/conjugate-base event or molecular-family match exists in training",
        },
        "exactEventMeasurements": 0,
        "references": [],
        "sources": [],
    }


def records(dataset_dir: Path, index: dict) -> tuple[list[dict], dict]:
    output, omitted = [], defaultdict(int)
    for set_name, filename in SETS:
        path = dataset_dir / filename
        supplier = Chem.SDMolSupplier(str(path), removeHs=False)
        for source_index, supplied in enumerate(supplier):
            if supplied is None:
                omitted["unparsable-sdf"] += 1
                continue
            try:
                site = int(supplied.GetProp("idx"))
                transition = supplied.GetProp("pka_type").strip().lower()
                target = float(supplied.GetProp("pka"))
            except Exception:
                omitted["missing-required-property"] += 1
                continue
            if transition not in {"acidic", "basic"}:
                omitted["unknown-transition"] += 1
                continue
            if site < 0 or site >= supplied.GetNumAtoms():
                omitted["site-out-of-range"] += 1
                continue

            product_input, product_site = written_smiles_with_site(supplied, site)
            if product_input is None or product_site is None:
                omitted["site-not-preserved-in-product-input"] += 1
                continue

            if transition == "acidic":
                acid, base = supplied, deprotonated(supplied, site)
                pair_unknown_reason = None if base is not None else "conjugate base could not be constructed"
            else:
                base, acid = supplied, protonated(supplied, site)
                pair_unknown_reason = None if acid is not None else "conjugate acid could not be constructed"

            family_basis = acid or base
            family = family_key(family_basis) if family_basis is not None else None
            scaffold = neutral_scaffold(family_basis) if family_basis is not None else None
            family_rows = index["families"].get(family, []) if family else []
            scaffold_rows = index["scaffolds"].get(scaffold, []) if scaffold else []
            exact_rows = index["events"].get(event_key(acid, base), [])

            fp = MORGAN.GetFingerprint(family_basis)
            similarities = DataStructs.BulkTanimotoSimilarity(fp, index["fingerprints"])
            nearest = max(range(len(similarities)), key=similarities.__getitem__) if similarities else None
            nearest_row = index["fingerprintRows"][nearest] if nearest is not None else None

            output.append({
                "id": f"{set_name}:{source_index}",
                "dataset": set_name,
                "sourceIndex": source_index,
                # Written together so the site moves with RDKit's canonical traversal and any explicit
                # SDF hydrogens it omits.  Reusing the original index after writing mis-scored nine of
                # these rows in the first external evaluator.
                "productInputSmiles": product_input,
                "suppliedSmiles": canonical(supplied),
                "intendedAcidSmiles": canonical(acid),
                "intendedBaseSmiles": canonical(base),
                "intendedPairStatus": (
                    {"value": True, "reason": None}
                    if pair_unknown_reason is None
                    else {"value": "unknown", "reason": pair_unknown_reason}
                ),
                "experimentalTarget": {
                    "value": target,
                    "type": "experimental molecule-level pKa mapped to one microscopic event",
                    "transition": transition,
                    "siteIndex": product_site,
                    "sourceSdfSiteIndex": site,
                    "siteElement": supplied.GetAtomWithIdx(site).GetSymbol(),
                    "siteProvenance": "ChemAxon Marvin assignment redistributed by QupKake; not an experimental atom assignment",
                },
                "trainingProximity": {
                    "familyKey": family,
                    "exactFamilyRows": len(family_rows),
                    "neutralScaffoldRows": len(scaffold_rows),
                    "nearestMorganTanimoto": similarities[nearest] if nearest is not None else None,
                    "nearestTrainingFamilyKey": nearest_row["family"] if nearest_row else None,
                    "nearestTrainingSource": nearest_row["source"] if nearest_row else None,
                },
                "sourceConsistency": consistency_for(target, exact_rows, family_rows),
            })
    return output, dict(omitted)


def main(dataset_dir: str, labels_path: str, out_path: str) -> None:
    rows = json.load(open(labels_path))
    index = training_index(rows)
    prepared, omitted = records(Path(dataset_dir), index)
    document = {
        "schemaVersion": 1,
        "purpose": "input context for the gated end-to-end ChemDraft pKa error-mixture audit",
        "benchmarkSource": "QupKake public Novartis and Literature SDFs, originally from Baltruschat and Czodrowski",
        "benchmarkUrls": {
            "qupkake": "https://github.com/Shualdon/QupKake/tree/main/data",
            "originalStudy": "https://doi.org/10.12688/f1000research.22090.2",
        },
        "siteAttribution": "QupKake/ChemAxon Marvin predictor annotation, not experimental site truth",
        "trainingRows": len(rows),
        "environment": {
            "rdkitVersion": rdBase.rdkitVersion,
            "pythonVersion": sys.version.split()[0],
        },
        "inputSha256": {
            "mergedLabels": hashlib.sha256(Path(labels_path).read_bytes()).hexdigest(),
            **{
                set_name: hashlib.sha256((Path(dataset_dir) / filename).read_bytes()).hexdigest()
                for set_name, filename in SETS
            },
        },
        "records": prepared,
        "omittedDuringPreparation": omitted,
    }
    with open(out_path, "w") as handle:
        json.dump(document, handle, indent=2)
    print(f"prepared {len(prepared)} records -> {out_path}")
    if omitted:
        print("omitted", json.dumps(omitted, sort_keys=True))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: error_audit_prepare.py <QupKake-data-dir> <merged-labels.json> <out.json>")
    main(sys.argv[1], sys.argv[2], sys.argv[3])
