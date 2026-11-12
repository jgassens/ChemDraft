import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRows, hasStereoDescriptor, loadRDKit, nameAccuracy } from "./build-name-dictionary.mjs";
import { auditRows, compareOpsin, compareSimpleAlkene, describeStructure } from "./audit-name-dictionary-stereo.mjs";

const bracketedAllNames = [
  "(all-E)-hexa-2,4-diene", "(all-Z)-hexa-2,4-diene",
  "[all-E]-hexa-2,4-diene", "[all-Z]-hexa-2,4-diene",
  "(all-trans)-hexa-2,4-diene", "(all-cis)-hexa-2,4-diene",
  "[all-trans]-hexa-2,4-diene", "[all-cis]-hexa-2,4-diene"
];
// A following space delimits a whole-word cis/trans descriptor, as a dash does.
const spaceSeparatedNames = ["trans but-2-ene", "cis but-2-ene", "Trans 2-butene", "synthetic cis compound"];

for (const name of [
  ...bracketedAllNames, ...spaceSeparatedNames,
  "(E)", "(Z)", "E-but-2-ene", "Z-but-2-ene", "E-", "Z-",
  "(E)-but-2-ene", "(Z)-but-2-ene", "[E]-but-2-ene", "[2Z]-but-2-ene",
  "(2E,4Z)-hexa-2,4-diene", "[2E,4Z]-hexa-2,4-diene",
  "(1R,2E)-pent-2-en-1-ol", "(2E,4R)-hex-2-en-4-ol",
  "ethyl (2E)-but-2-enoate", "methyl (2Z,4E)-hexa-2,4-dienoate",
  "cis-", "trans-", "cis-but-2-ene", "trans-but-2-ene",
  "CIS-but-2-ene", "ethyl trans-but-2-enoate",
  "cis–but-2-ene", "(cis)-but-2-ene",
  "[trans]-synthetic", "(E,Z)-synthetic", "[2Z,4E]-synthetic", "synthetic-9Z,12Z",
  "all-E-retinol", "all-Z-retinol", "all-trans-retinol", "all-cis-synthetic",
  // Existing descriptor classes must remain protected.
  "(R)-butan-2-ol", "D-glucose", "beta-carotene"
]) test(`recognizes explicit stereo descriptor: ${name}`, () => {
  assert.equal(hasStereoDescriptor(name), true);
});

for (const name of [
  "benzene", "zinc", "transferrin", "ethene", "123-45-6", "cistern", "transition", "transport",
  "Ethanol", "Zeatin", "(ethyl)benzene", "(zinc) complex",
  "E", "Z", "vitamin E", "Vitamin E acetate", "Factor Z", "E coli", "synthetic E compound",
  "cis", "trans", "synthetic, E compound",
  "synthetic-Eword", "synthetic-Zword", "all-Eword", "all-cisword",
  "(all-Eword)-synthetic", "[all-transword]-synthetic",
  // Cisplatin names a particular coordination isomer, but its lexicalized trivial
  // name contains no whole-word cis prefix. This detector recognizes descriptor
  // syntax, not the chemical meaning of every trivial name (nor Pt geometry).
  "cisplatin"
]) test(`does not find descriptor letters inside a word: ${name}`, () => {
  assert.equal(hasStereoDescriptor(name), false);
});

const E = "IAQRGUVFOMOMEM-ONEGZZNKSA-N";
const Z = "IAQRGUVFOMOMEM-ARJAWSKDSA-N";
const eSmiles = "C/C=C/C", zSmiles = "C/C=C\\C";
const services = {
  keyOf: smiles => new Map([[eSmiles, E], [zSmiles, Z]]).get(smiles),
  opsinSmiles: () => undefined,
  pubchem: async () => undefined
};

test("unverified Z own label cannot attach to the selected E candidate", async () => {
  const name = "(Z)-but-2-ene", audit = {};
  const rows = await buildRows([{
    id: "Q1", keys: [], canonical: [eSmiles, zSmiles], isomeric: [],
    labels: [name], aliases: [], german: [], cas: []
  }], { ...services, audit });
  assert.equal(rows[0].smiles, eSmiles);
  assert.deepEqual(rows.flatMap(row => row.names), []);
  assert.equal(audit.nameDecisions[0].decision, "unverifiable");
});

const dashes = ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\ufe63", "\uff0d"];
const dashNames = dashes.flatMap(dash => [
  `E${dash}synthetic`, `Z${dash}synthetic`, `cis${dash}but-2-ene`, `trans${dash}but-2-ene`,
  `all${dash}E${dash}synthetic`, `all${dash}Z${dash}synthetic`,
  `all${dash}cis${dash}synthetic`, `all${dash}trans${dash}synthetic`
]);

for (const name of ["(E)-but-2-ene", "(Z)-but-2-ene", "all-E-retinol", "all-Z-retinol",
  "all-trans-retinol", "all-cis-synthetic", ...dashNames, ...bracketedAllNames, ...spaceSeparatedNames])
  test(`own label needs independent evidence: ${name}`, async () => {
    assert.equal(await nameAccuracy(name, { key: E }, services, true), "unverifiable");
    assert.equal(await nameAccuracy(name, { key: E }, {
      ...services, opsinSmiles: () => eSmiles
    }, true), "opsin");
    assert.equal(await nameAccuracy(name, { key: E }, {
      ...services, pubchem: async () => ({ key: E })
    }, true), "pubchem");
    assert.equal(await nameAccuracy(name, { key: E }, {
      ...services, opsinSmiles: () => zSmiles
    }, true), "contradicted");
  });

for (const name of ["vitamin E", "Vitamin E acetate", "Factor Z", "E coli"])
  test(`ordinary letter word keeps own-label evidence: ${name}`, async () => {
    assert.equal(await nameAccuracy(name, { key: E }, services, true), "label");
    assert.equal(await nameAccuracy(name, { key: E }, services, false), "unverifiable");
  });

const engine = loadRDKit({ print: () => {}, printErr: () => {} });

test("RDKit audit compares isomers, partial stereo and constitutional mismatches", async () => {
  const rdkit = await engine;
  assert.equal(compareOpsin(rdkit, eSmiles, eSmiles), "correctIsomer");
  assert.equal(compareOpsin(rdkit, eSmiles, zSmiles), "wrongIsomer");
  assert.equal(compareOpsin(rdkit, "CC=CC", zSmiles), "noStereo");
  assert.equal(compareOpsin(rdkit, "C/C=C/CC", zSmiles), "notCheckable");
  assert.equal(compareOpsin(rdkit, "C/C=C/[C@H](O)C", "C/C=C/C(O)C"), "correctIsomer");
  assert.equal(compareOpsin(rdkit, "C/C=C/C(O)C", "C/C=C/[C@H](O)C"), "noStereo");
  assert.equal(compareOpsin(rdkit, "C/C=C/[C@@H](O)C", "C/C=C/[C@H](O)C"), "wrongIsomer");
  // Atom order and symmetric reverse numberings must not affect the verdict.
  assert.equal(compareOpsin(rdkit, "C/C=C/CC", "CC/C=C/C"), "correctIsomer");
  assert.equal(compareOpsin(rdkit, "invalid structure", zSmiles), "notCheckable");
});

test("RDKit-only fallback maps simple alkene locants without generalizing cis/trans", async () => {
  const rdkit = await engine;
  const describe = smiles => describeStructure(rdkit, smiles);
  assert.equal(compareSimpleAlkene("(Z)-but-2-ene", describe(eSmiles)), "wrongIsomer");
  assert.equal(compareSimpleAlkene("trans-2-butene", describe(eSmiles)), "correctIsomer");
  assert.equal(compareSimpleAlkene("cis-but-2-ene", describe(zSmiles)), "correctIsomer");
  assert.equal(compareSimpleAlkene("(2E)-but-2-ene", describe("CC=CC")), "noStereo");
  assert.equal(compareSimpleAlkene("(2E,4E)-hexa-2,4-diene", describe("C/C=C/C=C/C")), "correctIsomer");
  assert.equal(compareSimpleAlkene("(2E,4Z)-hexa-2,4-diene", describe("C/C=C/C=C/C")), "wrongIsomer");
  assert.equal(compareSimpleAlkene("trans-cyclohexane-1,2-diol", describe("O[C@H]1CCCC[C@@H]1O")), "notCheckable");
  assert.equal(compareSimpleAlkene("(E)-2-bromobut-2-ene", describe("C/C(Br)=C/C")), "notCheckable");
  assert.equal(compareSimpleAlkene("(E)-but-1-ene", describe("C=CCC")), "notCheckable");
  assert.equal(compareSimpleAlkene("(E)-but-2-ene", describe("[13CH3]/C=C/C")), "notCheckable");
  for (const dash of dashes) {
    for (const [descriptor, same, other] of [["E", eSmiles, zSmiles], ["Z", zSmiles, eSmiles],
      ["trans", eSmiles, zSmiles], ["cis", zSmiles, eSmiles]]) {
      assert.equal(compareSimpleAlkene(`${descriptor}${dash}but-2-ene`, describe(same)), "correctIsomer");
      assert.equal(compareSimpleAlkene(`${descriptor}${dash}but-2-ene`, describe(other)), "wrongIsomer");
    }
  }
});

test("audit partitions rows, examines both columns, and does not claim unchecked aliases correct", async () => {
  const rdkit = await engine;
  const row = (smiles, names, suggest = []) => ({ smiles, names, suggest });
  const rows = [
    row(eSmiles, ["ordinary name"]),
    row(eSmiles, ["!trans-but-2-ene"], ["(E)-but-2-ene"]),
    row(eSmiles, ["(E)-but-2-ene"], ["(Z)-but-2-ene"]),
    row("CC=CC", ["cis-but-2-ene"]),
    row(eSmiles, ["trans-unknown", "(E)-but-2-ene"])
  ];
  assert.deepEqual(auditRows(rows, rdkit), {
    totalRows: 5, rowsWithGeometricNames: 4, correctIsomer: 1,
    wrongIsomer: 1, noStereo: 1, notCheckable: 1, geometricNames: 7,
    opsinParsedNames: 0, rdkitFallbackNames: 6, labelToOtherRows: null
  });
  const readings = new Map([["trans-unknown", zSmiles]]);
  assert.equal(auditRows([rows[4]], rdkit, readings).wrongIsomer, 1);
  // A parser result that preserved R/S but lost the name's E/Z assertion must
  // never confirm the geometric name merely because both readings are equal.
  const partial = "CC=CC(O)C", partialChiral = "CC=C[C@H](O)C";
  const mixed = row(partialChiral, ["(2E,4R)-hex-2-en-4-ol"]);
  assert.equal(auditRows([mixed], rdkit, new Map([[mixed.names[0], partialChiral]])).noStereo, 1);
  assert.equal(compareOpsin(rdkit, partial, partialChiral), "noStereo");
});

test("audit shares descriptor syntax and counts every supported dash spelling", async () => {
  const rdkit = await engine;
  for (const name of [...dashNames, ...bracketedAllNames, ...spaceSeparatedNames]) {
    for (const field of ["names", "suggest"]) {
      const counts = auditRows([{ smiles: "CC=CC", names: [], suggest: [], [field]: [name] }], rdkit);
      assert.equal(counts.rowsWithGeometricNames, 1);
      assert.equal(counts.noStereo, 1);
    }
  }
  for (const name of ["vitamin E", "Vitamin E acetate", "Factor Z", "E coli",
    "transferrin", "cisplatin", "transition", "transport", "cistern"]) {
    assert.equal(auditRows([{ smiles: eSmiles, names: [name], suggest: [] }], rdkit).rowsWithGeometricNames, 0);
  }
  // All-E and pasted dashes must also contribute to the E/Z completeness gate.
  for (const name of ["all-E-synthetic", "E\ufe63synthetic", "all\uff0dZ\uff0dsynthetic",
    "(all-E)-hexa-2,4-diene", "[all-Z]-hexa-2,4-diene"]) {
    const chiralOnly = "CC=C[C@H](O)C";
    const counts = auditRows([{ smiles: chiralOnly, names: [name], suggest: [] }], rdkit,
      new Map([[name, chiralOnly]]));
    assert.equal(counts.noStereo, 1);
  }
});

test("relative ring cis/trans accepts both enantiomers but rejects the other relative isomer", async () => {
  const rdkit = await engine;
  const trans = "O[C@H]1CCCC[C@@H]1O", mirror = "O[C@@H]1CCCC[C@H]1O";
  const cis = "O[C@H]1CCCC[C@H]1O", cisMirror = "O[C@@H]1CCCC[C@@H]1O";
  const verdict = (name, bound, expected) => auditRows([{ smiles: bound, names: [name], suggest: [] }],
    rdkit, new Map([[name, expected]]));
  for (const [name, bound, expected] of [
    ["trans-cyclohexane-1,2-diol", trans, mirror], ["trans-cyclohexane-1,2-diol", mirror, trans],
    ["cis-cyclohexane-1,2-diol", cis, cisMirror], ["cis-cyclohexane-1,2-diol", cisMirror, cis]
  ]) {
    assert.equal(verdict(name, bound, expected).correctIsomer, 1);
  }
  for (const [bound, expected] of [[cis, trans], [trans, cis], [mirror, cis], [cisMirror, mirror]]) {
    assert.equal(verdict("cis-cyclohexane-1,2-diol", bound, expected).wrongIsomer, 1);
  }
  for (const [bound, expected] of [[trans, mirror], [mirror, trans]]) {
    assert.equal(compareOpsin(rdkit, bound, expected), "wrongIsomer");
    for (const dash of dashes) {
      assert.equal(verdict(`(1R,2R)${dash}trans${dash}cyclohexane-1,2-diol`, bound, expected).wrongIsomer, 1);
    }
    assert.equal(verdict("trans-cyclohexane-1,2-diol", "OC1CCCCC1O", expected).noStereo, 1);
  }
  // Reflection must not reverse double-bond E/Z, even on a relative ring name.
  const mixed = "O[C@H]1CCCC[C@H]1/C=C/C";
  assert.equal(verdict("trans-(E)-synthetic-ring", mixed, "O[C@@H]1CCCC[C@@H]1/C=C/C").correctIsomer, 1);
  assert.equal(verdict("trans-(E)-synthetic-ring", mixed, "O[C@@H]1CCCC[C@@H]1/C=C\\C").wrongIsomer, 1);
  // Additional or non-ring centres need an explicit relative-stereo contract.
  const complex = "O[C@H]1CCC[C@H](F)[C@H]1Cl";
  const acyclic = "C[C@H](O)[C@H](O)C";
  for (const expected of [complex, acyclic]) {
    assert.equal(verdict("trans-synthetic", expected, expected).notCheckable, 1);
  }
});
