# Upstream report for OpenClatura: substituent naming drops unnameable atoms silently

Prepared 2026-08-01 against **OpenClatura 0.2.0**, to be filed at `lamalab-org/openclatura`. Written to
the shape `CONTRIBUTING.md` asks for: input SMILES, generated names, expected names, the suspected
cause, OPSIN output, and several related examples from the same family.

**Not yet submitted** — posting to a third-party repository needs the project owner's go-ahead.

**A working patch exists**, written and validated against `origin/tests` (the branch CONTRIBUTING asks
PRs to target): `openclatura-patch/0001-audit-substituent-subgraph-coverage.patch`. Measured on that
base over 4,999 NCI structures:

| | before | after |
|---|---:|---:|
| round-trip | 4724 | **4724** — no correct name lost |
| declined | 204 | 210 |
| misnamed | 36 | **30** |

All six that moved are the arsenic-as-substituent cases; nothing else changed. Their own suite passes
(2451 tests on the `tests` branch), `ruff check` and `ruff format --check` are clean, and there is no
measurable speed cost (94.8 → 95.3 structures/s).

Applying it:

```bash
git clone https://github.com/lamalab-org/openclatura.git && cd openclatura
git checkout tests
git am < .../openclatura-patch/0001-audit-substituent-subgraph-coverage.patch
```

---

## Summary

When a fragment OpenClatura cannot name appears **as a substituent**, its atoms are dropped from the
generated name while still being counted as named. The result is a confident, well-formed,
OPSIN-parseable name for a *smaller molecule*. The same fragment **as a parent** is correctly declined,
so the engine already knows it cannot name it — the check just does not run at the substituent level.

Found in a 4,999-structure round-trip benchmark (NCI `first_5K`): 36 structures were misnamed, and
**14 of those name a smaller molecule than the input**.

## Reproduction

```python
import openclatura as oc

oc.analyze_smiles("c1ccccc1[As](=O)(O)O").name        # '' — correctly declined
oc.analyze_smiles("NC(=O)CNc1ccc([As](=O)(O)O)cc1").name
# '2-(phenylamino)acetamide'   ← the whole -As(=O)(O)O group is gone
```

The first call reports, via `NamingEngine.run()`:

```
UnnamedAtomError: Generated name '<component>' left unnamed atoms: 6:As, 7:O, 8:O, 9:O
```

The second reports no error at all.

## Related examples from the same family

| SMILES | OpenClatura | Problem |
|---|---|---|
| `c1ccccc1[As](=O)(O)O` | *(declined)* | correct |
| `NC(=O)CNc1ccc([As](=O)(O)O)cc1` | `2-(phenylamino)acetamide` | arsonic acid dropped |
| `CC(=O)Nc1cc([As](=O)(O)O)ccc1O` | `N-(2-hydroxyphenyl)acetamide` | arsonic acid dropped |
| `CN(C)c1ccc(N=Nc2ccc([As](=O)(O)O)cc2)cc1` | `N,N-dimethyl-N'-(phenylimino)benzene-1,4-diamine` | arsonic acid dropped |
| `[13CH3]C(=O)O` | `acetic acid` | ¹³C label dropped |
| `[2H]C([2H])([2H])C(=O)O` | `acetic acid` | three deuteriums dropped |
| `CC1(C)CCCC(C)(C)N1[O]` | `1-hydroxy-2,2,6,6-tetramethylpiperidine` | nitroxide radical named as its closed-shell hydroxylamine |

Triarylmethane dyes lose N-substituents the same way (ethyl, benzyl), so this is not arsenic-specific —
it is *any* feature the substituent namer cannot express.

**Expected behaviour:** decline, exactly as the parent-level case already does. A name that omits part
of the molecule is worse than no name, because nothing downstream can detect it.

## OPSIN cross-check

Round-tripping the generated names through OPSIN 2.9.0 confirms they describe different molecules:

```
input : NC(=O)CNc1ccc([As](=O)(O)O)cc1     C8H11AsN2O4
name  : 2-(phenylamino)acetamide
OPSIN : NC(=O)CNc1ccccc1                    C8H10N2O      ← lost AsO3
```

## Suspected cause

The coverage audit exists and works — it is just not applied recursively.

1. `naming_audit.assert_component_fully_named()` raises `UnnamedAtomError` when a component name leaves
   atoms unnamed. It is called once, at `component_namer.py:561`.
2. `namer.name_subgraph()` — the recursive substituent namer — **never calls it**. No coverage audit
   runs on a substituent's own subgraph.
3. `namer.py:919` then records the branch as fully accounted for regardless of what its name covered:

   ```python
   branch_atoms = _subgraph_component(mol, n_idx, branch_exclude)
   ...
   SubstituentItem(
       name=branch_name,
       atom_ids=branch_atoms,   # ← claims the WHOLE branch, unconditionally
       ...
   )
   ```

4. Because the `SubstituentItem` claims every atom in the branch, the component-level audit in step 1
   is satisfied by a binding that over-claims, and the omission passes unnoticed.

Instrumenting `add_substituent_trace` shows it directly:

```
substituent '(phenylamino)' at locant 2 claims atoms [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
```

Eleven atoms claimed; the name `phenylamino` describes seven.

## Suggested fix

Either would close it, and both reuse machinery already present:

- **Audit the recursion.** Apply the existing coverage check inside `name_subgraph()` so a substituent
  that cannot be fully named fails the way a parent already does. Most direct, and keeps one rule in
  one place.
- **Make the claim honest.** Set `SubstituentItem.atom_ids` to the atoms the branch name actually
  consumed rather than the whole subgraph, so the existing component-level audit catches the shortfall
  on its own.

The first is likely cheaper; the second makes the invariant true everywhere rather than checked in two
places.

**Worth measuring before merging:** whether either version causes currently-correct names to start
declining. The benchmark harness used here can quantify that — it is
`tools/openclatura-benchmark/` in the reporting repository, and re-runs in about a minute over 4,999
structures.

## A smaller, separate observation

The decision trace does not record the omission. For the arsenic case the ASSEMBLY phase reports
"assembled component name" with no indication that atoms were dropped. Since the trace is one of the
project's stated advantages, recording a coverage shortfall there would be valuable even before the
naming behaviour changes.

## Version note

`pip install openclatura` gives **0.2.0**, but `openclatura.__version__` reports **0.1.5**. Worth
aligning, so a bug report can identify what was actually run.
