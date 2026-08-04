"""Turn the IUPAC dissociation-constants collection into per-site training labels.

The IUPAC/Dissociation-Constants compilation (Zenodo 21533589, v2.3e) is 24,211 curated experimental
values with unusually rich metadata: method, temperature, pressure, cosolvent, and a per-row
reliability assessment. It is ingested here for ONE reason, which is the gap the SAMPL6 end-to-end
benchmark exposed.

**Weak bases.** This model over-predicts nitrogens that barely protonate, because its labels were
selected for measurability — of its aromatic-nitrogen basic labels only 5.2% sit below pH 2, while most
ring nitrogens in a real fused heterocycle do. After the filters below, 11.5% of this set's basic labels
are below pH 2 and it reaches -9.44. That is the distribution the model has never seen.

**STILL NOT IN THE SHIPPED CORPUS — but for a different reason than before, and that difference is the
point.** The capacity objection is gone: the network absorbs these rows where the forest could not.

    corpus                     cvMAE   baseline   external   macro ALL   macro zwitterion
    forest,  12,096            1.023      2.480      1.239       0.354              0.411
    forest, +IUPAC 13,565      1.083      2.537      1.264       0.583                  —
    network, 12,096            0.726      2.480      1.131       0.350              0.460
    network,+IUPAC 13,565      0.729      2.537      1.080       0.750              1.650

The forest paid 0.060 cvMAE to hold them; the network pays 0.003, against a harder baseline, so its
relative skill improves. It also gets BETTER on held-out external data (1.131 -> 1.080) and finds the
right number of measurable titration steps on 12 of 24 SAMPL6 molecules instead of 9.

And it wrecks zwitterions. Glycine's first macroscopic step reads -0.55 against a measured 2.35;
alanine -0.49 against 2.34; histidine -3.32 against 1.85. Amino acids are the commonest polyprotic
chemistry there is, and a model that puts glycine's carboxyl three log units under water is not
shippable however good its held-out average looks.

**The balance hypothesis was tested and is only half the story.** Taking the acidic rows as well brings
the corpus to 6,594 / 8,600 -- a ratio of 0.767 against the core's 0.735, where basic-only was 0.946 --
and it halves the damage without removing it:

    corpus                       cvMAE   external   macro ALL   macro zwitterion
    network, 12,096 (shipped)    0.728      1.129       0.330              0.320
    network, +IUPAC basic only   0.729      1.080       0.750              1.650
    network, +IUPAC both ways    0.741      1.060       0.500              0.890

**What is actually happening is more interesting, and it is a property of the macroscopic fold rather
than of this dataset.** Compare the two models site by site and they agree on everything an experiment
can measure:

    site                              shipped   rebalanced   measured
    acetic acid                          4.30         4.30       4.76
    glycine, CATION form                 2.29         2.19       2.35
    alanine, CATION form                 2.28         2.22       2.34
    phenol                               9.92         9.96       9.95
    glycine, NEUTRAL form                4.33         8.56          -

The last row is the whole difference. Glycine's neutral form does not exist in water -- the molecule is
a zwitterion -- so no dataset labels it, and the real microscopic value is near 4.4. The shipped model
says 4.33; the rebalanced one says 8.56 and is simply wrong, on a species nothing could have corrected
it about.

The macroscopic fold has to build that species anyway: `pKa(n) = log10(Z(n)/Z(n-1))` sums over EVERY
microstate, populated or not. So the fold's accuracy rests on predictions no training set constrains,
and adding well-labelled data can move them arbitrarily while every labelled figure improves. That is
exactly the observation the electrostatic coupling term was introduced for -- "Dwar-iBond records only
microstates a titration can populate, never an amino acid's neutral form" -- and it turns out to be a
standing fragility rather than a fixable gap in one corpus.

Which means the next lever is not another dataset. It is either labels for unpopulated microstates
(which QM could supply and experiment cannot), or a fold that does not need them.

The paragraphs that follow describe the forest era and are left standing, because a dataset rejected
for one reason and later rejected for a different one is exactly the decision that rots into folklore
if only the outcome is recorded.

**WHY IT WAS NOT IN THE SHIPPED CORPUS UNDER THE FOREST, measured rather than assumed.** The data is
clean: its inferred sites match a trusted site on 2,509 of 2,510 shared molecules, and its values agree
with the existing corpus on 79.6% exactly and 99% within one log unit. It also does what it was
fetched to do — SAMPL6 gets the right NUMBER of titration steps on 6 of 24 molecules instead of 4, and
azole macroscopic error falls from 0.62 to 0.42. But at the forest's fixed capacity every other
held-out measure gets worse:

    corpus                       cvMAE   external   macro    SAMPL6 MAE   right count
    core, 12,096                 1.023      1.239   0.354         2.033             4
    + IUPAC basic, 13,565        1.083      1.264   0.583         2.119             6
    + all IUPAC, 15,194          1.114      1.262   0.493         2.262             6

A 65% rise in error on the macroscopic set — amino acids and diacids, the commonest chemistry there is
— does not buy two molecules on a step-count metric.

The cause is capacity, and it was measured too. cvMAE falls monotonically as the forest grows:
1.114 at 60 trees, 1.108 at 120, 1.080 at 200, 1.054 at 300 with unlimited depth. The artifact does
not: roughly 10 MB, 33 MB, 58 MB, 208 MB. This forest ships inside a desktop app and is parsed in a
worker, so 60 trees is near the practical limit. The corpus has outgrown the model class, which is the
same wall `pkaModel.ts` already names — "a GNN would score better and could not ship".

So this file stays, working and tested, and its output stays out of `run_all.sh`'s default. Pass the
CSV as the fifth argument to include it. The moment inference is not a JSON forest parsed in a browser,
this is the first thing to revisit.

**LICENCE: CC BY-NC 4.0.** Non-commercial. That is a real constraint on redistributing a model trained
on it and it is recorded here, in the method contract's `datasets`, and in NOTICE, so the question can
be settled deliberately rather than discovered later. Nothing here decides it.

Three filters, each of which changes the number rather than merely tidying it:

**Neat water only.** 73% of this set's sub-zero basic values carry an H2SO4 or HCl cosolvent, because
that is how a very weak base is measured — by a Hammett acidity function, which is a DIFFERENT SCALE
from an aqueous pKa. Pooling them would repeat the mistake `d2a_labels.py` avoids with DMSO, and it
would do it precisely in the region this ingest exists to fix.

**20 to 30 degrees**, since the contract says room temperature.

**Not "Very uncertain"**, which is the compilation's own judgement on its own rows.

**The site is not given, and is never guessed.** Unlike every other source here, these rows are a
molecule and a number with no atom index and no acid/base pair. A site is assigned only when the
molecule has EXACTLY ONE candidate of the required direction, so there is nothing to choose between;
everything else is dropped. `sites_of` is the scanner, kept deliberately in step with `acceptsAProton`
in `ionization.ts` so the labels are sited by the same rules that will score them.

    python3 iupac_labels.py iupac_high-confidence_v2_3.csv <existing-labels.json> iupac-labels.json
"""
import collections
import csv
import os
import json
import statistics
import sys

from rdkit import Chem, RDLogger

from coupling_fit import sites_of
from parity_features import kekulized, written_smiles_with_site
from qupkake_labels import protonated

RDLogger.DisableLog("rdApp.*")

MIN_TEMPERATURE, MAX_TEMPERATURE = 20.0, 30.0
REJECTED_ASSESSMENTS = {"Very uncertain", "Unknown"}
# Only the FIRST dissociation. A second one belongs to a molecule with several sites, where "exactly one
# candidate" cannot hold anyway, and where the value is macroscopic rather than microscopic.
BASIC_TYPES = {"pKaH1"}
# Acidic rows are read but not kept by default. The corpus is already strong on acids -- carboxyls
# measure 0.51 -- and the gap this ingest exists to close is entirely on the basic side, where the
# labels were selected for measurability. Every row added competes for a fixed forest's capacity, so
# rows that do not address the gap are not free.
ACIDIC_TYPES = set() if os.environ.get("IUPAC_BASIC_ONLY", "1") == "1" else {"pKa1"}
# Replicates further apart than this disagree about what was measured rather than scatter around it.
MAX_REPLICATE_SPREAD = 1.0


def usable(row):
    """The row passes the aqueous, temperature and reliability filters."""
    if row["cosolvent"].strip():
        return False
    if row["assessment"].strip() in REJECTED_ASSESSMENTS:
        return False
    try:
        temperature = float(row["T"])
    except (TypeError, ValueError):
        return False
    return MIN_TEMPERATURE <= temperature <= MAX_TEMPERATURE


def extract(src, existing_path):
    known = {}
    if existing_path:
        for row in json.load(open(existing_path)):
            mol = Chem.MolFromSmiles(row["acid"])
            if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
                continue
            smiles, site = written_smiles_with_site(mol, row["acidAtomIdx"])
            if smiles is not None:
                known[(smiles, site)] = row["pKa"]

    stats = collections.Counter()
    # Many rows per compound: the same constant measured by different groups. Collect them all, then
    # take the median and keep the spread, rather than training on each measurement as if independent.
    measurements = collections.defaultdict(list)

    for row in csv.DictReader(open(src)):
        kind = row["pka_type"].strip()
        if kind in BASIC_TYPES:
            direction = "basic"
        elif kind in ACIDIC_TYPES:
            direction = "acidic"
        else:
            stats["not a first dissociation"] += 1; continue
        if not usable(row):
            stats["cosolvent, temperature or reliability"] += 1; continue
        try:
            value = float(row["pka_value"])
        except (TypeError, ValueError):
            stats["unreadable value"] += 1; continue
        measurements[(row["SMILES"].strip(), direction)].append(value)

    kept = []
    for (smiles, direction), values in measurements.items():
        median = statistics.median(values)
        spread = max(values) - min(values)
        if len(values) > 1 and spread > MAX_REPLICATE_SPREAD:
            stats["replicates disagree by more than 1.0"] += 1; continue

        mol = kekulized(smiles)
        if mol is None:
            stats["unparsable"] += 1; continue

        # The site is assigned ONLY when there is nothing to choose between.
        candidates = [atom for atom, kind in sites_of(mol) if kind == direction]
        if len(candidates) != 1:
            stats["site is ambiguous or absent" if candidates else "no candidate site"] += 1; continue
        idx = candidates[0]

        if direction == "basic":
            acid = protonated(mol, idx)
            if acid is None:
                stats["could not protonate the basic site"] += 1; continue
        else:
            acid = mol
            if acid.GetAtomWithIdx(idx).GetTotalNumHs() == 0:
                stats["acidic site with no proton"] += 1; continue

        canonical, site = written_smiles_with_site(acid, idx)
        if canonical is None:
            stats["site atom is not written to SMILES"] += 1; continue
        if (canonical, site) in known:
            stats["already covered by an existing label"] += 1; continue
        known[(canonical, site)] = median

        kept.append({
            "acid": canonical,
            "acidAtomIdx": site,
            "pKa": round(median, 4),
            "replicates": len(values),
            "replicateSpread": round(spread, 4),
            "ref": "IUPAC Dissociation-Constants v2.3e",
            "label_source": "iupac (experimental; CC BY-NC 4.0; neat water, 20-30 C; site assigned "
                            "only where the molecule has exactly one candidate)",
        })

    return kept, stats


def main(src, existing_path, out):
    kept, stats = extract(src, existing_path)
    json.dump(kept, open(out, "w"))
    print(f"kept {len(kept)} per-site labels")
    for reason, count in stats.most_common():
        print(f"   dropped {count:6d}  {reason}")
    if kept:
        values = [row["pKa"] for row in kept]
        below = sum(1 for v in values if v < 2)
        print(f"   pKa range {min(values):.2f} .. {max(values):.2f}")
        print(f"   below pH 2: {below} ({100 * below / len(values):.1f}%)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if sys.argv[2] != "-" else None, sys.argv[3])
