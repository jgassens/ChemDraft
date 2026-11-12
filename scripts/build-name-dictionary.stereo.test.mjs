import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRows, hasStereoDescriptor, loadRDKit, nameAccuracy } from "./build-name-dictionary.mjs";
import { auditRows, compareOpsin, compareSimpleAlkene, describeStructure } from "./audit-name-dictionary-stereo.mjs";

for (const name of [
  "E", "Z", "(E)", "(Z)", "E-but-2-ene", "Z-but-2-ene",
  "(E)-but-2-ene", "(Z)-but-2-ene", "[E]-but-2-ene", "[2Z]-but-2-ene",
  "(2E,4Z)-hexa-2,4-diene", "[2E,4Z]-hexa-2,4-diene",
  "(1R,2E)-pent-2-en-1-ol", "(2E,4R)-hex-2-en-4-ol",
  "ethyl (2E)-but-2-enoate", "methyl (2Z,4E)-hexa-2,4-dienoate",
  "cis", "trans", "cis-", "trans-", "cis-but-2-ene", "trans-but-2-ene",
  "CIS-but-2-ene", "trans but-2-ene", "ethyl trans-but-2-enoate",
  "cis–but-2-ene", "(cis)-but-2-ene",
  // Existing descriptor classes must remain protected.
  "(R)-butan-2-ol", "D-glucose", "beta-carotene"
]) test(`recognizes explicit stereo descriptor: ${name}`, () => {
  assert.equal(hasStereoDescriptor(name), true);
});

for (const name of [
  "benzene", "zinc", "transferrin", "ethene", "123-45-6", "cistern", "transition",
  "Ethanol", "Zeatin", "(ethyl)benzene", "(zinc) complex",
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

for (const name of ["(E)-but-2-ene", "(Z)-but-2-ene", "cis-but-2-ene", "trans-but-2-ene"])
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
