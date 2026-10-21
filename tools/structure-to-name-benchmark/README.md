# Structure-to-name benchmark

Scores a structure→name engine by reading every name it produces back through OPSIN and comparing
structures. Results: `docs/benchmarks/structure-to-name-comparison.md` (October 2026, OpenClatura 0.2.0
and 0.4.3, Orthonym 1.0.8) and `docs/benchmarks/openclatura-structure-to-name.md` (August 2026,
OpenClatura 0.2.0). This directory was `tools/openclatura-benchmark/` until the October run.

| File | Stage | Runs in |
|---|---|---|
| `bench_name.py` | 1: structure → name, `--namer {openclatura,orthonym}` | the namer's venv |
| `bench_roundtrip.py` | 2: name → OPSIN → structure, and the score | any venv with RDKit |
| `compare.py` | 3: several scored runs side by side | any venv with RDKit |
| `pubchem_check.py` | independent check against PubChem's IUPAC names | any venv with RDKit; network |
| `adversarial.smi` | the 26-structure adversarial set | |

The corpus is RDKit's `Data/NCI/first_5K.smi` (4,999 NCI compounds; SHA-256
`91e71c015f14939837f2943dcc904f7c87e5a3a0124d82b05c28ad2f23004def`, the same in RDKit 2026.03.4 to 2026.09.1), plus `adversarial.smi`. Two
adversarial labels are wrong and kept for comparability: `stereo-S-ibuprofen` is (R)-ibuprofen and
`stereo-L-alanine` is D-alanine (and their partners the reverse); every namer and OPSIN agree.

## Scoring (unchanged since August)

`round-trip`, `stereo-lost`, `MISNAMED`, `name-unparseable`, `declined`, `error`, `unusable`: see the
docstring of `bench_roundtrip.py`. OPSIN runs with default flags, so it does **not** read radical names;
`--allow-radicals` gives a secondary score. Stage 2 canonicalises both sides with its own RDKit, so
namers installed with different RDKit builds are scored alike.

## Running

Everything goes in throwaway venvs outside the repository; nothing is installed system-wide.
Build the per-host OPSIN Java runtime first with `node scripts/build-opsin-runtime.mjs`.

```bash
W=$TMPDIR/s2n-bench; mkdir -p $W/out
OPSIN=<ChemDraft checkout>/apps/desktop/src-tauri/resources/opsin    # vendored JRE + OPSIN 2.9.0
export OPSIN_JAVA=$OPSIN/jre/bin/java OPSIN_JAR=$OPSIN/opsin-cli-2.9.0.jar
H=tools/structure-to-name-benchmark

uv venv -p 3.12 $W/venv-score    && uv pip install -p $W/venv-score/bin/python rdkit==2026.3.4
uv venv -p 3.12 $W/venv-oc043    && uv pip install -p $W/venv-oc043/bin/python openclatura==0.4.3
uv venv -p 3.12 $W/venv-orthonym && uv pip install -p $W/venv-orthonym/bin/python orthonym==1.0.8
NCI=$W/venv-score/lib/python3.12/site-packages/rdkit/Data/NCI/first_5K.smi

# Orthonym needs a JVM (JPype) and two jars. Point it at ChemDraft's JRE and OPSIN jar, and fetch the
# centres jar yourself (curl, then check the SHA-256 Orthonym pins: 6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb).
curl -sSL -o $W/centres-cli-1.2.1.jar https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar
export JAVA_HOME=$OPSIN/jre ORTHONYM_OPSIN_JAR=$OPSIN_JAR ORTHONYM_CENTRES_JAR=$W/centres-cli-1.2.1.jar \
       ORTHONYM_CACHE_DIR=$W/orthonym-cache ORTHONYM_NO_DOWNLOAD=1

$W/venv-oc043/bin/python    $H/bench_name.py --namer openclatura $NCI $W/out/oc043-nci-stage1.tsv
$W/venv-orthonym/bin/python $H/bench_name.py --namer orthonym    $NCI $W/out/orthonym-nci-stage1.tsv
$W/venv-orthonym/bin/python $H/bench_name.py --namer orthonym --orthonym-tier valid \
    $NCI $W/out/orthonym-valid-nci-stage1.tsv
for r in oc043 orthonym orthonym-valid; do
  $W/venv-score/bin/python $H/bench_roundtrip.py $W/out/$r-nci-stage1.tsv $W/out/$r-nci-stage2.tsv
done
$W/venv-score/bin/python $H/compare.py --out-dir $W/cmp \
    oc-0.4.3=$W/out/oc043-nci-stage2.tsv orthonym-default=$W/out/orthonym-nci-stage2.tsv
$W/venv-score/bin/python $H/pubchem_check.py $W/out/orthonym-nci-stage2.tsv $W/pubchem.csv \
    --cache-dir $W/pubchem-cache --n 200
rm -rf $W    # when done
```

The python.org macOS Python ships no CA bundle, so Orthonym's own jar download and `urllib` fail with
`CERTIFICATE_VERIFY_FAILED`; that is why the centres jar is fetched with curl, and why
`pubchem_check.py` uses `/etc/ssl/cert.pem` (or `SSL_CERT_FILE`).
