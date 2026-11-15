import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRows, nameAccuracy } from "./build-name-dictionary.mjs";

const ACETATE = "QTBSBXVTEAMEQO-UHFFFAOYSA-M";
const ACETIC_ACID = "QTBSBXVTEAMEQO-UHFFFAOYSA-N";
const acetateSmiles = "CC(=O)[O-]";
const acidSmiles = "CC(=O)O";
const services = {
  keyOf: smiles => new Map([[acetateSmiles, ACETATE], [acidSmiles, ACETIC_ACID]]).get(smiles),
  opsinSmiles: () => undefined,
  pubchem: async () => undefined
};
const item = {
  id: "Q1", keys: [ACETIC_ACID], canonical: [acetateSmiles],
  cas: ["64-19-7"], labels: [], aliases: [], german: [], isomeric: []
};

test("PubChem acid evidence contradicts an acetate alias with no OPSIN parse", async () => {
  assert.equal(await nameAccuracy("synthetic alias", { key: ACETATE }, {
    ...services, pubchem: async () => ({ key: ACETIC_ACID })
  }), "contradicted");
  assert.equal(await nameAccuracy("synthetic alias", { key: ACETATE }, {
    ...services, pubchem: async () => ({ key: ACETATE })
  }), "pubchem");
});

test("PubChem collision resolution retains only the complete matching InChIKey", async () => {
  // Ambiguous baseline names bypass the new-name gate, exercising the collision
  // referee independently. Neither identity has unique historical ownership.
  const alias = "synthetic shared alias";
  for (const keys of [[ACETATE, ACETIC_ACID], [ACETIC_ACID, ACETATE]]) {
    const baseline = keys.map((key, i) => ({
      id: `Q${i + 1}`, key, smiles: key === ACETATE ? acetateSmiles : acidSmiles,
      names: [alias], cas: [], suggest: []
    }));
    const rows = await buildRows([], {
      ...services, baseline, pubchem: async () => ({ key: ACETIC_ACID })
    });
    assert.deepEqual(rows.filter(row => row.names.includes(alias)).map(row => row.key), [ACETIC_ACID]);
  }
});

test("connectivity-only structure fallback omits the source acid CAS from acetate", async () => {
  const rows = await buildRows([item], { ...services, baseline: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, ACETATE);
  assert.equal(rows[0].smiles, acetateSmiles);
  assert.deepEqual(rows[0].cas, []);
});

test("structure selection with no source identity cannot establish CAS ownership", async () => {
  const rows = await buildRows([{ ...item, keys: [] }], { ...services, baseline: [] });
  assert.equal(rows[0].key, ACETATE);
  assert.deepEqual(rows[0].cas, []);
});

test("a full source identity match retains valid CAS assignments", async () => {
  const rows = await buildRows([{ ...item, canonical: [acidSmiles] }], { ...services, baseline: [] });
  assert.equal(rows[0].key, ACETIC_ACID);
  assert.deepEqual(rows[0].cas, ["64-19-7"]);
});
