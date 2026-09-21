"""Relative free energies between microstates, by ORCA with SMD. The port of `qm_microstate.py`.

**Why this exists.** `qm_microstate.py` is kept beside this file and should be read first: it is the
recorded negative result. B3LYP/6-31+G** with ddCOSMO put glycine's log Kz at **+1.39 against an
experimental +5.38**, and a gate built on it would have ranked the REJECTED weak-base model closer to
correct than the shipped one. Its own attribution is the useful part: 24 conformers moved the answer by
0.04 while the neutral form's conformers spanned 3.24 kcal/mol, so the error is the SOLVATION MODEL and
not the search. It names what would be needed -- "SMD, which is parameterised against measured solvation
free energies including ions, and is not compiled into the PyPI PySCF wheel".

ORCA 6.1.1 on Juno has it. Its banner credits "Christopher J. Cramer and Donald G. Truhlar : smd
solvation model" and "Dagmar Lenk : GEPOL surface, SMD".

**The first run must change exactly one thing.** `legacy-ddcosmo` reproduces the failure IN ORCA -- same
functional, same bases, electrostatic-only CPCM -- and `legacy-smd` differs from it only by turning SMD
on. Running both separates "ORCA differs from PySCF" from "SMD differs from ddCOSMO", which a single
production-level run cannot do. If log Kz moves +1.39 -> near +5.3 under `legacy-smd` alone, the
attribution in the old docstring is confirmed and the solvation model was the whole story. If it does
not, the diagnosis was wrong, and finding that out costs two cheap calculations rather than a campaign.
**Do not skip to `production` on the assumption that SMD fixes it.** That assumption is the thing being
tested.

**Two modes, because the campaign needs both and they are not the same calculation.**

`--mode isomer` (the old script's only mode) compares two species of IDENTICAL formula and returns
log10([B]/[A]). Thermal and entropic terms very largely cancel between isomers, so electronic + solvation
is defensible, and it is checkable: glycine's Kz is ~10^5.3.

`--mode pka` compares an acid with its conjugate base, which differ by a proton, and returns a pKa.
Nothing cancels: it needs Gibbs energies, so a frequency job, and it needs a proton solvation anchor.
This mode is what makes Phase 1's validation possible at all -- the 12,096 labels in the corpus ARE
measured relative free energies of exactly this kind, so a protocol can be scored against a few hundred
of them before it is trusted on the unpopulated microstates that have no label. A protocol validated only
on glycine has been validated on one molecule.

**Provenance is recorded per number, and this matters as much here as it does for labels.** A QM value
carries the level of theory, the solvation model, the conformer protocol and its seed, and the ORCA
version, in the result JSON. The corpus already refuses values that are "inherited from another
predictor"; a QM label is "inherited from a solvation model", and the same rule applies -- a number whose
solvation model is not recorded is not auditable.

**Resumability is not optional.** Juno caps a user at 4 concurrent jobs on `normal` (8 under the
`high-throughput` QOS) with a 2-day wall, so the campaign runs as a few wide task-farmed jobs rather than
many small ones. A job killed at hour 47 must not lose the calculations it finished. Every stage result
is cached under a content hash of its own semantic inputs, so re-running is free and a farm worker can be
restarted at any point.

    python3 qm_orca.py <smiles A> <smiles B> [label] [options]

      --mode isomer|pka      isomer (default) prints log10([B]/[A]); pka prints a pKa for A -> B + H+
      --protocol NAME        legacy-ddcosmo | legacy-smd | production | production-cheap
      --nprocs N             ORCA PAL processes (default 1)
      --workdir DIR          scratch root; cache lives in <workdir>/cache (default ./qm-work)
      --conformers N         default 24, as measured
      --dry-run              write the ORCA inputs and stop, so the deck can be read before it is run
      --self-test            parse a captured ORCA output and check the arithmetic; runs no QM

Reports the same quantity as `qm_microstate.py` in isomer mode, so the two are directly comparable.
For glycine pass the NEUTRAL first and the zwitterion second to get log Kz.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import sys
import time

from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

RDLogger.DisableLog("rdApp.*")

HARTREE_KCAL = 627.5094740631
RT_KCAL = 0.001987204258640832 * 298.15          # kcal/mol at 298.15 K
LN10 = 2.302585092994046
HARTREE_TO_LOG10 = HARTREE_KCAL / (LN10 * RT_KCAL)

# Proton in water, the standard anchor for a QM pKa. G_gas(H+) = -6.28 kcal/mol (translational only,
# Sackur-Tetrode at 298.15 K / 1 atm) and dG_solv*(H+) = -265.9 kcal/mol (Tissandier et al. 1998 cluster-
# pair, the value SMD was parameterised alongside), plus 1.89 kcal/mol for the 1 atm -> 1 M standard state
# change. THIS CONSTANT IS A FITTED ANCHOR, NOT A COMPUTED QUANTITY, and it absorbs a systematic error of
# a few kcal/mol -- which is 2-3 pKa units. Phase 1 refits it on measured pairs rather than trusting it;
# see `fit_proton_anchor` below and the note in the validation harness.
G_PROTON_AQ_KCAL = -6.28 + -265.9 + 1.89

# Every protocol names all four stages explicitly, because "B3LYP/6-31+G**" alone does not say what was
# optimised, in what solvent, or whether Gibbs terms exist. A protocol string appears in every result.
PROTOCOLS = {
    # Reproduces qm_microstate.py's failure IN ORCA. Electrostatic-only continuum, no SMD. Its ONLY job
    # is to be the control for legacy-smd; it is not expected to be right.
    "legacy-ddcosmo": {
        "screen": "B3LYP 6-31G",
        "opt":    "B3LYP 6-31G*",
        "final":  "B3LYP 6-31+G**",
        "smd": False, "freq": False,
    },
    # One variable different from the line above.
    "legacy-smd": {
        "screen": "B3LYP 6-31G",
        "opt":    "B3LYP 6-31G*",
        "final":  "B3LYP 6-31+G**",
        "smd": True, "freq": False,
    },
    # The candidate for real work. wB97X-D3 because SMD was parameterised against hybrid functionals and
    # dispersion matters for the folded conformers a zwitterion adopts; def2-TZVPD because the diffuse
    # functions are what an anion needs and SMD's radii assume a reasonable description of it.
    "production": {
        "screen": "wB97X-D3 def2-SVP",
        "opt":    "wB97X-D3 def2-SVP",
        "final":  "wB97X-D3 def2-TZVPD",
        "smd": True, "freq": True,
    },
    # r2SCAN-3c is a composite with its own basis and corrections; it optimises geometries at a fraction
    # of the cost and is the right screen/opt level once the campaign is bulk rather than exploratory.
    "production-cheap": {
        "screen": "r2SCAN-3c",
        "opt":    "r2SCAN-3c",
        "final":  "wB97X-D3 def2-TZVPD",
        "smd": True, "freq": True,
    },
}

SOLVENT = "water"


# ---------------------------------------------------------------------------------------------------
# Conformers. Carried over unchanged from qm_microstate.py, including both measured decisions.
# ---------------------------------------------------------------------------------------------------

def conformers(smiles, n):
    """MMFF-optimised conformers as xyz strings, plus the formal charge. Deterministic, so this repeats.

    NO RMS PRUNING, and that is a measured decision rather than an oversight: at 0.25 A pruning collapsed
    glycine to ONE conformer and at 0.1 A to two, which silently turns the search into a single MMFF
    minimisation. For a zwitterion, whose folded and extended forms differ by an intramolecular hydrogen
    bond, that is a several-kcal/mol error wearing a solvation model's clothes. The QM screen selects.
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise SystemExit(f"cannot parse {smiles}")
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xC0FFEE
    params.pruneRmsThresh = -1.0
    AllChem.EmbedMultipleConfs(mol, numConfs=n, params=params)
    if mol.GetNumConformers() == 0:
        raise SystemExit(f"no conformer embedded for {smiles}")
    AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=4000)
    charge = Chem.GetFormalCharge(mol)
    geoms = []
    for conf in mol.GetConformers():
        pos = conf.GetPositions()
        geoms.append("\n".join(
            f"{a.GetSymbol():2s} {pos[a.GetIdx()][0]:14.8f} {pos[a.GetIdx()][1]:14.8f} "
            f"{pos[a.GetIdx()][2]:14.8f}" for a in mol.GetAtoms()))
    # A radical would need a different spin and none of this is set up for one; refuse rather than
    # silently computing a closed shell for an open-shell species.
    if sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms()):
        raise SystemExit(f"{smiles} has radical electrons; this script assumes a closed shell")
    return geoms, charge


# ---------------------------------------------------------------------------------------------------
# ORCA input, execution, and parsing
# ---------------------------------------------------------------------------------------------------

def orca_input(xyz, charge, level, *, smd, opt=False, freq=False, nprocs=1):
    """One ORCA deck. Kept textual and boring so it can be read in a diff.

    SMD is requested as CPCM plus `smd true`, which is ORCA's spelling: the CPCM machinery provides the
    electrostatics and SMD adds the parameterised cavity-dispersion-solvent-structure term on top. Asking
    for `! SMD(water)` is not valid input in ORCA 6 and fails at parse time, which is a good failure --
    but only if someone reads the output, hence `parse_energy` treating a missing energy as an error.
    """
    keywords = [level]
    if opt:
        keywords.append("Opt")
    if freq:
        keywords.append("Freq")
    keywords.append("TightSCF")
    keywords.append(f"CPCM({SOLVENT})")

    lines = [f"! {' '.join(keywords)}"]
    if smd:
        lines += ["%cpcm", "  smd true", f'  SMDsolvent "{SOLVENT}"', "end"]
    if nprocs > 1:
        lines += [f"%pal nprocs {nprocs} end"]
    # A charged solute in a continuum can converge slowly; give it room rather than silently returning an
    # unconverged energy. `parse_energy` also checks for the convergence banner.
    lines += ["%scf MaxIter 250 end", "%maxcore 3000"]
    lines += [f"*xyz {charge} 1", xyz, "*", ""]
    return "\n".join(lines)


FINAL_E = re.compile(r"FINAL SINGLE POINT ENERGY\s+(-?\d+\.\d+)")
G_MINUS_E = re.compile(r"G-E\(el\)\s+\.\.\.\s+(-?\d+\.\d+)")
IMAGINARY = re.compile(r"\*\*\*imaginary mode\*\*\*")
ABORT = re.compile(r"ORCA finished by error|aborting the run|ORCA TERMINATED NORMALLY")


def parse_energy(text, *, want_gibbs=False):
    """Pull (E, G_correction) out of an ORCA output, or raise with the reason.

    `G-E(el)` is exactly the quantity wanted: ORCA's thermochemistry block prints the difference between
    the Gibbs free energy and the electronic energy, so a high-level single point can be combined with a
    low-level frequency job as E_high + (G - E)_low without re-deriving anything.
    """
    if "ORCA TERMINATED NORMALLY" not in text:
        tail = "\n".join(text.strip().splitlines()[-8:])
        raise RuntimeError(f"ORCA did not terminate normally. Tail:\n{tail}")
    energies = FINAL_E.findall(text)
    if not energies:
        raise RuntimeError("no FINAL SINGLE POINT ENERGY in output")
    energy = float(energies[-1])
    correction = None
    if want_gibbs:
        found = G_MINUS_E.findall(text)
        if not found:
            raise RuntimeError("frequency job requested but no G-E(el) in output")
        correction = float(found[-1])
        if IMAGINARY.search(text):
            # An imaginary mode means the geometry is a saddle point, so its Gibbs terms describe
            # something that is not a minimum. Surface it; do not average it into a campaign.
            raise RuntimeError("imaginary frequency: optimised geometry is not a minimum")
    return energy, correction


def orca_binary():
    """ORCA needs its ABSOLUTE path whenever nprocs > 1 -- it re-executes itself through MPI and a bare
    name on PATH is not enough. Resolve once and fail loudly rather than at MPI launch."""
    found = os.environ.get("ORCA_BIN") or shutil.which("orca")
    if not found:
        raise SystemExit(
            "orca not found. On Juno: module load orca/6.1.1  (or set ORCA_BIN to the full path).")
    return os.path.realpath(found)


def orca_version(binary=None):
    try:
        out = subprocess.run([binary or orca_binary()], capture_output=True, text=True, timeout=60)
        match = re.search(r"Program Version\s+(\S+)", out.stdout + out.stderr)
        return match.group(1) if match else "unknown"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------------------------------
# Cache. One JSON per completed stage, keyed by a hash of everything that could change the number.
# ---------------------------------------------------------------------------------------------------

def cache_key(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:24]


def run_stage(deck, *, workdir, key, nprocs, want_gibbs, dry_run, capture_geometry=False):
    """Run one ORCA deck, or return the cached result. Returns (energy, gibbs_correction, xyz).

    `xyz` is the optimised geometry and is CACHED ALONGSIDE THE ENERGY rather than re-read from the run
    directory. That is not tidiness. The run directory is pruned once cached, so on any resumed run the
    geometry file is gone -- and a caller that fell back to the pre-optimisation geometry would compute
    its expensive final single point at the wrong structure and report it as a success. In a farmed
    campaign every job after the first is a resumed run, so that path is the common one, not the corner.
    """
    cache_dir = os.path.join(workdir, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    cached_at = os.path.join(cache_dir, f"{key}.json")
    if os.path.exists(cached_at):
        with open(cached_at) as handle:
            hit = json.load(handle)
        if capture_geometry and not hit.get("xyz"):
            raise RuntimeError(
                f"cache entry {key} predates geometry caching and cannot be resumed safely; "
                f"delete {cached_at} and let the optimisation re-run")
        return hit["energy"], hit.get("gibbsCorrection"), hit.get("xyz")

    run_dir = os.path.join(workdir, "runs", key)
    os.makedirs(run_dir, exist_ok=True)
    inp = os.path.join(run_dir, "job.inp")
    with open(inp, "w") as handle:
        handle.write(deck)
    if dry_run:
        print(f"  [dry-run] wrote {inp}", flush=True)
        return None, None, None

    started = time.time()
    with open(os.path.join(run_dir, "job.out"), "w") as out:
        subprocess.run([orca_binary(), "job.inp"], cwd=run_dir, stdout=out,
                       stderr=subprocess.STDOUT, check=False)
    with open(os.path.join(run_dir, "job.out")) as handle:
        text = handle.read()
    energy, correction = parse_energy(text, want_gibbs=want_gibbs)

    geometry = read_optimised_geometry(run_dir) if capture_geometry else None
    if capture_geometry and geometry is None:
        raise RuntimeError(f"optimisation in {run_dir} produced no job.xyz")

    with open(cached_at, "w") as handle:
        json.dump({"energy": energy, "gibbsCorrection": correction, "xyz": geometry,
                   "seconds": round(time.time() - started, 1), "runDir": run_dir}, handle)
    # The wavefunction and integral files dwarf everything else and there are thousands of these.
    # The .out stays: it is the provenance, and it is small.
    for junk in os.listdir(run_dir):
        if junk not in ("job.inp", "job.out"):
            path = os.path.join(run_dir, junk)
            shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
    return energy, correction, geometry


# ---------------------------------------------------------------------------------------------------
# The three-stage energy, same shape as qm_microstate.py's best_energy
# ---------------------------------------------------------------------------------------------------

def best_energy(smiles, label, *, protocol, workdir, nprocs, n_conformers, dry_run):
    """Screen conformers cheaply, optimise the winner, then a larger single point.

    Returns the free energy in Hartree: E(final) + (G - E)(opt level) when the protocol asks for
    frequencies, and E(final) alone when it does not -- which is only defensible between isomers.
    """
    spec = PROTOCOLS[protocol]
    geoms, charge = conformers(smiles, n_conformers)
    print(f"  {label:26s} {smiles:30s} charge {charge:+d}, {len(geoms)} conformers", flush=True)

    screened = []
    for index, xyz in enumerate(geoms):
        key = cache_key({"s": smiles, "c": charge, "stage": "screen", "i": index,
                         "level": spec["screen"], "smd": spec["smd"], "xyz": xyz})
        deck = orca_input(xyz, charge, spec["screen"], smd=spec["smd"], nprocs=1)
        try:
            energy, _, _ = run_stage(deck, workdir=workdir, key=key, nprocs=1,
                                     want_gibbs=False, dry_run=dry_run)
        except RuntimeError as failure:
            print(f"  {'':26s} conformer {index}: {failure}", flush=True)
            continue
        if energy is not None:
            screened.append((energy, xyz))
    if dry_run:
        return None
    if not screened:
        raise SystemExit(f"no conformer converged for {smiles}")
    screened.sort(key=lambda pair: pair[0])
    spread = (screened[-1][0] - screened[0][0]) * HARTREE_KCAL
    print(f"  {'':26s} screened: {len(screened)}/{len(geoms)} converged, "
          f"spread {spread:.2f} kcal/mol", flush=True)

    key = cache_key({"s": smiles, "c": charge, "stage": "opt", "level": spec["opt"],
                     "smd": spec["smd"], "freq": spec["freq"], "xyz": screened[0][1]})
    deck = orca_input(screened[0][1], charge, spec["opt"], smd=spec["smd"],
                      opt=True, freq=spec["freq"], nprocs=nprocs)
    started = time.time()
    _, correction, optimised_xyz = run_stage(deck, workdir=workdir, key=key, nprocs=nprocs,
                                             want_gibbs=spec["freq"], dry_run=dry_run,
                                             capture_geometry=True)
    print(f"  {'':26s} optimised{' + freq' if spec['freq'] else ''} "
          f"({time.time() - started:.0f}s)", flush=True)

    key = cache_key({"s": smiles, "c": charge, "stage": "final", "level": spec["final"],
                     "smd": spec["smd"], "xyz": optimised_xyz})
    deck = orca_input(optimised_xyz, charge, spec["final"], smd=spec["smd"], nprocs=nprocs)
    final_energy, _, _ = run_stage(deck, workdir=workdir, key=key, nprocs=nprocs,
                                   want_gibbs=False, dry_run=dry_run)

    total = final_energy + (correction or 0.0)
    print(f"  {'':26s} {spec['final']} + {'SMD' if spec['smd'] else 'CPCM'}({SOLVENT})  "
          f"E = {final_energy:.6f} Ha" + (f"  G-E = {correction:+.6f} Ha" if correction else ""),
          flush=True)
    return total


def read_optimised_geometry(run_dir):
    """ORCA writes job.xyz beside the input after an Opt: an atom count, a comment, then coordinates.

    Read on the pass that runs the optimisation and then cached with the energy, because the run
    directory is pruned afterwards -- see the note in `run_stage`.
    """
    path = os.path.join(run_dir, "job.xyz")
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        lines = handle.read().splitlines()
    return "\n".join(lines[2:]) if len(lines) > 2 else None


# ---------------------------------------------------------------------------------------------------
# The two modes
# ---------------------------------------------------------------------------------------------------

def log_ratio(energy_a, energy_b):
    """log10([B]/[A]) for two species of the same formula."""
    return -(energy_b - energy_a) * HARTREE_TO_LOG10


def pka_from(energy_acid, energy_base, proton_anchor_kcal=G_PROTON_AQ_KCAL):
    """pKa for HA -> A- + H+, from Gibbs energies in Hartree.

    dG = G(A-) + G(H+) - G(HA), and pKa = dG / (RT ln10). The anchor carries every systematic error the
    continuum makes on a bare proton, which is why Phase 1 refits it rather than adopting it.
    """
    delta_kcal = (energy_base - energy_acid) * HARTREE_KCAL + proton_anchor_kcal
    return delta_kcal / (LN10 * RT_KCAL)


def fit_proton_anchor(pairs):
    """Least-squares anchor from measured pairs: the value that centres the residuals.

    `pairs` is [(dG_kcal_without_anchor, measured_pKa), ...]. Refitting turns a literature constant into
    a measured property of THIS protocol, and the residual scatter afterwards -- not the shift -- is what
    says whether the protocol is usable. A protocol that needs a 10 kcal/mol anchor correction is telling
    you something even if its scatter is fine.
    """
    if not pairs:
        raise ValueError("no pairs to fit")
    offsets = [measured * LN10 * RT_KCAL - delta for delta, measured in pairs]
    return sum(offsets) / len(offsets)


# ---------------------------------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("smiles_a")
    parser.add_argument("smiles_b")
    parser.add_argument("label", nargs="?", default="pair")
    parser.add_argument("--mode", choices=("isomer", "pka"), default="isomer")
    parser.add_argument("--protocol", choices=sorted(PROTOCOLS), default="legacy-smd")
    parser.add_argument("--nprocs", type=int, default=1)
    parser.add_argument("--workdir", default="./qm-work")
    parser.add_argument("--conformers", type=int, default=24)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", help="write the result and its provenance here")
    args = parser.parse_args(argv)

    spec = PROTOCOLS[args.protocol]
    if args.mode == "pka" and not spec["freq"]:
        raise SystemExit(
            f"--mode pka needs Gibbs energies, and protocol '{args.protocol}' has freq=False. "
            "An acid and its conjugate base are not isomers, so nothing cancels. Use --protocol "
            "production or production-cheap.")

    os.makedirs(args.workdir, exist_ok=True)
    print(f"=== {args.label}   protocol {args.protocol}   mode {args.mode}", flush=True)
    print(f"    {spec['screen']} screen -> {spec['opt']} opt{'+freq' if spec['freq'] else ''} "
          f"-> {spec['final']} final, {'SMD' if spec['smd'] else 'CPCM electrostatic-only'}", flush=True)

    common = dict(protocol=args.protocol, workdir=args.workdir, nprocs=args.nprocs,
                  n_conformers=args.conformers, dry_run=args.dry_run)
    energy_a = best_energy(args.smiles_a, "state A (reference)", **common)
    energy_b = best_energy(args.smiles_b, "state B", **common)
    if args.dry_run:
        print("\n  dry run: inputs written, nothing executed", flush=True)
        return None

    delta_kcal = (energy_b - energy_a) * HARTREE_KCAL
    if args.mode == "isomer":
        value = log_ratio(energy_a, energy_b)
        print(f"\n  dG (B - A)      {delta_kcal:+.2f} kcal/mol")
        print(f"  log10([B]/[A])  {value:+.2f}")
    else:
        value = pka_from(energy_a, energy_b)
        print(f"\n  dG (B - A)      {delta_kcal:+.2f} kcal/mol (before the proton anchor)")
        print(f"  proton anchor   {G_PROTON_AQ_KCAL:+.2f} kcal/mol  [LITERATURE, refit in Phase 1]")
        print(f"  pKa             {value:+.2f}")

    if args.json:
        with open(args.json, "w") as handle:
            json.dump({
                "label": args.label, "mode": args.mode, "value": round(value, 4),
                "smilesA": args.smiles_a, "smilesB": args.smiles_b,
                "deltaKcal": round(delta_kcal, 4),
                "provenance": {
                    "engine": "orca", "orcaVersion": orca_version(),
                    "protocol": args.protocol, **spec, "solvent": SOLVENT,
                    "conformers": args.conformers, "conformerMethod": "RDKit ETKDGv3 + MMFF",
                    "conformerSeed": "0xC0FFEE", "pruneRmsThresh": -1.0,
                    "protonAnchorKcal": G_PROTON_AQ_KCAL if args.mode == "pka" else None,
                },
            }, handle, indent=1)
    return value


# ---------------------------------------------------------------------------------------------------
# Self-test. Runs no QM: checks the deck we generate and the parser against a captured ORCA output.
# ---------------------------------------------------------------------------------------------------

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qm-orca-fixture.txt")


def load_fixture():
    """Real ORCA 6.1.1 output, not a hand-written imitation.

    `gnn-parity-fixture.json` in this same directory was produced by hand once and had NO GENERATOR, so
    every later change to inference left it pinning arithmetic nothing regenerated. That mistake is not
    worth making twice: this fixture is an excerpt from job 320337 on Juno and the header records the
    command that reproduces it. A hand-written fixture would have hidden the thing it actually caught --
    that an Opt job emits one FINAL SINGLE POINT ENERGY per optimisation step, so the parser must take
    the LAST rather than the first.
    """
    with open(FIXTURE) as handle:
        text = handle.read()
    freq, _, anion = text.partition("#### anion ####")
    return freq.partition("#### freq ####")[2], anion


def self_test():
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    freq_out, anion_out = load_fixture()

    # The neutral Opt+Freq case. Five FINAL SINGLE POINT ENERGY lines are present; the converged one is
    # the last, and taking the first would be wrong by 0.35 mHa here and by far more on a real molecule.
    energy, correction = parse_energy(freq_out, want_gibbs=True)
    check("freq energy (last, not first)", energy, -76.383197027543)
    check("gibbs correction", correction, 0.00324688)
    if freq_out.count("FINAL SINGLE POINT ENERGY") < 2:
        failures.append("fixture no longer exercises the multi-step Opt case")

    # The charged, diffuse-basis case: this is where SMD matters and where SCF convergence bites.
    anion_energy, anion_correction = parse_energy(anion_out, want_gibbs=False)
    check("anion energy", anion_energy, -228.533795684605)
    check("anion correction", anion_correction, None)

    # SMD must actually have been active in both. A deck that silently fell back to plain CPCM would
    # reproduce the old ddCOSMO failure while looking like a success.
    for name, out in (("freq", freq_out), ("anion", anion_out)):
        if "utilizes the SMD solvation module" not in out:
            failures.append(f"{name} fixture does not show SMD active")
        if "SMD CDS free energy correction energy" not in out:
            failures.append(f"{name} fixture has no CDS term -- electrostatic-only, which is the bug")

    deck = orca_input("O 0.0 0.0 0.0", 0, "B3LYP 6-31+G**", smd=True, opt=True, freq=True, nprocs=4)
    for needed in ("! B3LYP 6-31+G** Opt Freq TightSCF CPCM(water)", "smd true",
                   'SMDsolvent "water"', "%pal nprocs 4 end", "*xyz 0 1"):
        if needed not in deck:
            failures.append(f"deck missing {needed!r}")
    if "smd true" in orca_input("O 0 0 0", 0, "B3LYP 6-31G", smd=False):
        failures.append("smd=False deck still requests SMD")

    # The arithmetic, against the constant the old script used.
    check("hartree->log10", round(HARTREE_TO_LOG10, 4), round(627.5094740631 / (LN10 * RT_KCAL), 4))
    # A 1 pKa unit difference is 1.364 kcal/mol at 298.15 K; check the pKa conversion agrees.
    one_unit = pka_from(0.0, 1.364 / HARTREE_KCAL, proton_anchor_kcal=0.0)
    if abs(one_unit - 1.0) > 0.001:
        failures.append(f"pka_from: 1.364 kcal/mol should be 1.000 pKa, got {one_unit:.4f}")
    # Anchor refit must recover a planted offset exactly. Build pairs from a known anchor so the answer
    # is knowable: if the true anchor is -270.0, then dG_without_anchor = pKa*RT*ln10 - (-270.0).
    planted = -270.0
    pairs = [(measured * LN10 * RT_KCAL - planted, measured) for measured in (2.35, 4.76, 9.78)]
    fitted = fit_proton_anchor(pairs)
    if abs(fitted - planted) > 1e-9:
        failures.append(f"fit_proton_anchor: planted {planted}, recovered {fitted}")
    # And the refit anchor must reproduce the measured pKa when fed back through pka_from.
    round_trip = pka_from(0.0, pairs[1][0] / HARTREE_KCAL, proton_anchor_kcal=fitted)
    if abs(round_trip - 4.76) > 1e-6:
        failures.append(f"anchor round-trip: got {round_trip:.6f}, want 4.76")

    # THE EXECUTE PATH, against a stub binary standing in for ORCA.
    #
    # This exists because its absence cost a job. The self-test passed while `run_stage` returned two
    # values from the path that actually runs a calculation and three from every other path, so every
    # caller unpacking three raised `ValueError: not enough values to unpack` the moment real work
    # started. The tests only ever reached the cache-hit branch, because reaching the other one appeared
    # to need ORCA -- and a test that cannot run without the cluster is a test that does not run.
    #
    # A stub that emits the captured fixture removes that excuse. It exercises the subprocess call,
    # output capture, parsing, geometry read-back, cache write, run-directory pruning, and the return
    # arity of the branch that does the work.
    with tempfile.TemporaryDirectory() as tmp:
        freq_text, _ = load_fixture()
        stub = os.path.join(tmp, "fake-orca")
        with open(stub, "w") as handle:
            handle.write("#!/bin/sh\n"
                         "printf '3\\ncomment\\nO 0.0 0.0 0.1\\nH 0.0 0.8 -0.5\\nH 0.0 -0.8 -0.5\\n'"
                         " > job.xyz\n"
                         f"cat {json.dumps(os.path.join(tmp, 'captured.txt'))}\n")
        os.chmod(stub, 0o755)
        with open(os.path.join(tmp, "captured.txt"), "w") as handle:
            handle.write(freq_text)

        previous = os.environ.get("ORCA_BIN")
        os.environ["ORCA_BIN"] = stub
        try:
            energy, correction, geometry = run_stage(
                "! dummy\n", workdir=os.path.join(tmp, "wd"), key="exec", nprocs=1,
                want_gibbs=True, dry_run=False, capture_geometry=True)
            check("execute-path energy", energy, -76.383197027543)
            check("execute-path correction", correction, 0.00324688)
            if not geometry or "O 0.0 0.0 0.1" not in geometry:
                failures.append(f"execute path did not read back job.xyz: {geometry!r}")
            # The run directory must be pruned to job.inp/job.out, and the cache must carry the geometry
            # so the resume path above has something to find.
            left = sorted(os.listdir(os.path.join(tmp, "wd", "runs", "exec")))
            if left != ["job.inp", "job.out"]:
                failures.append(f"run directory not pruned: {left}")
            with open(os.path.join(tmp, "wd", "cache", "exec.json")) as handle:
                if not json.load(handle).get("xyz"):
                    failures.append("cache entry written without a geometry")
            # Second call must hit the cache and agree, arity included.
            again = run_stage("! dummy\n", workdir=os.path.join(tmp, "wd"), key="exec", nprocs=1,
                              want_gibbs=True, dry_run=False, capture_geometry=True)
            if again != (energy, correction, geometry):
                failures.append(f"cache hit disagrees with the run that filled it: {again}")
        finally:
            if previous is None:
                os.environ.pop("ORCA_BIN", None)
            else:
                os.environ["ORCA_BIN"] = previous

    # The resume path. A cache hit must return the OPTIMISED geometry, and a legacy entry that predates
    # geometry caching must refuse rather than silently hand back the pre-optimisation structure -- the
    # bug this test exists for would only ever have fired on a resumed run, which in a farmed campaign is
    # every run after the first.

    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "cache"))
        with open(os.path.join(tmp, "cache", "good.json"), "w") as handle:
            json.dump({"energy": -1.0, "gibbsCorrection": 0.002, "xyz": "O 0 0 0"}, handle)
        with open(os.path.join(tmp, "cache", "legacy.json"), "w") as handle:
            json.dump({"energy": -1.0, "gibbsCorrection": 0.002}, handle)
        _, _, xyz = run_stage("", workdir=tmp, key="good", nprocs=1,
                              want_gibbs=True, dry_run=False, capture_geometry=True)
        check("cached geometry returned", xyz, "O 0 0 0")
        try:
            run_stage("", workdir=tmp, key="legacy", nprocs=1, want_gibbs=True,
                      dry_run=False, capture_geometry=True)
            failures.append("legacy cache entry without a geometry was accepted")
        except RuntimeError:
            pass

    # Refusing pka mode without frequencies is a contract, not a nicety.
    try:
        main(["CC(=O)O", "CC(=O)[O-]", "x", "--mode", "pka", "--protocol", "legacy-smd"])
        failures.append("pka mode with a freq-less protocol should have exited")
    except SystemExit:
        pass

    for failure in failures:
        print(f"FAIL  {failure}")
    print(f"\nself-test: {'PASS' if not failures else str(len(failures)) + ' FAILURES'} "
          f"({len(PROTOCOLS)} protocols defined)")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    main()
