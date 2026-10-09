# Names, exports and human editing

## Chemical name to structure

`name` and MCP `name_to_structure` use the bundled OPSIN 2.9.0 runtime.
OPSIN parses chemical names; it is not a universal synonym database.
When only a name is known, run it before drawing. When it fails on a
common, trivial or trade name, do one of these, never a guess:

- Look the compound up in PubChem and cite the CID with the figure or
  number. The PUG REST property URL
  `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/<name>/property/Title,MolecularFormula,SMILES/JSON`
  (or `.../compound/cid/<CID>/...`) returns the CID, formula and SMILES;
  recipes 11 and 12 fetch one with Node.
- Supply the systematic name yourself, say that it came from memory, and
  convert it with `name`.

Then confirm the formula with `analyze` (method `rdkit.composition`)
against the database or expected formula, and the stereocentres with
`stereo`. Otherwise request a systematic name or confirmed SMILES.

| CLI flag | Meaning / default |
|---|---|
| `--name` | One chemical name, exclusive with batch |
| `--batch` | JSON array of `{name, query}` jobs |
| `--render` | Optional single `.png` file; forbidden with batch |
| `--allow-ambiguous` | Accept OPSIN's ambiguous result; default false |
| `--help` | Print help |

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft name --name '2-acetoxybenzoic acid' --render "$scratch/aspirin.png"
```

An ambiguous result is refused by default. `--allow-ambiguous` is for a
user deliberately requesting that OPSIN interpretation, with the ambiguity
disclosed and the structure checked. Do not use it to bypass uncertainty
in an answer key, identity-sensitive dataset or assignment of stereochemistry.
MCP uses `name`, `render` boolean and `allowAmbiguous` boolean.

Batch example; `name` is the safe output label, `query` the chemical name:

```json
[{"name":"ethanol","query":"ethanol"},{"name":"acetic-acid","query":"acetic acid"}]
```

Labels follow the common trimmed, case-insensitively unique batch-name
rules. Names cannot contain tabs, newlines/control characters; the
name parser limits chemical queries to 2000 characters. Preserve warnings
and the returned SMILES with the original query. The Java runtime is
host-specific; see [setup](setup.md) if missing.

## Export

`export` / MCP `export_structure` supports these formats:

| Format | Use |
|---|---|
| `cdxml` | Editable structure interchange for the ChemDraft desktop app |
| `pdf` | Page-oriented figure for a document |
| `sdf` | Structure dataset with one record per molecule |
| `mol` | One molecule's connection table and coordinates |
| `smi` | Canonical SMILES with a tab-separated name |

| CLI flag | Meaning / default |
|---|---|
| `--smiles` | Single SMILES, exclusive with batch |
| `--batch` | JSON array of `{name, smiles}` |
| `--out` | Required single file; combined batch `sdf`/`smi` destination |
| `--out-dir` | Batch per-job destination for `cdxml`, `pdf`, `mol` |
| `--format` | One format above; infer single extension, required in batch |
| `--help` | Print help |

```sh
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --smiles 'CCO' --out "$scratch/ethanol.cdxml"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --smiles 'CCO' --out "$scratch/ethanol.pdf"
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --batch "$scratch/choices.json" --out "$scratch/choices.sdf" --format sdf
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --batch "$scratch/choices.json" --out-dir "$scratch/mols" --format mol
pnpm -s --config.shell-emulator=true --dir "$checkout" chemdraft export --batch "$scratch/choices.json" --out "$scratch/choices.smi" --format smi
```

MCP takes one `smiles`, required `format`, optional `outDir` root; it creates
a fresh child directory. It has no batch input, so a multi-record SDF or
SMILES dataset needs the CLI `--batch` form above. SDF records include
`SMILES`, `Index` and `Name`.
For a batch combined dataset, a failed job is omitted from the written
records and reported as failed; do not claim a partial dataset is complete.

Chemical exports check that canonical SMILES equals the input's. CDXML
is reopened and checked; MOL/SDF/SMILES representations are checked through
the engine. A mismatch fails the job. PDF is a visual export after source
identity validation, not a chemical file that can be parsed back from a
picture. Never claim a PDF chemical round trip. Refused radicals/isotopes
must not be removed from the input to force success. `analyze` does accept
radicals and keeps them in its composition and masses; report the export
refusal and the computed numbers separately.

PDF output currently misplaces atom labels and text ("HO" split, O, N
and S off their atoms, even for unstyled aspirin). View every PDF before
delivering it, and prefer SVG or PNG figures until this is fixed.

## Hand-edit loop and compatibility

Export CDXML. Tell the human to save the current drawing first, because
File > Open replaces the open document without asking. Then have them open
the file through ChemDraft **File > Open** and edit the actual structure.
A styled `.chemdraft` file from `render-document` opens the same way
([art](art.md)). On Windows use File > Open or Open with;
ChemDraft registers `.chemdraft` only, not `.cdxml`. Save the edited native
document; regenerate the final figure from the confirmed edited chemistry.
The headless tools do not read back a user's edited CDXML as a new CLI input.
If the next agent operation needs SMILES, obtain the confirmed edited SMILES
from the user/app instead of using the stale pre-edit string.

File-format compatibility is fixture-driven. Supported basic atoms, bonds,
coordinates, charges, isotope/radical/stereo representations, superatoms,
basic R-groups, text, simple arrows, plus signs, brackets and styles do not
imply that every headless input or interchange can preserve every case.
More complex S-groups, polymers, mapping and reaction arrows require
fixtures; complex graphics/images/fonts may need preservation or warnings.
Never claim perfect CDXML compatibility or broad CDX writing. Inspect the
actual export warnings and reopened file. See
[AGENTS.md §11](../../../AGENTS.md#11-file-format-compatibility).
