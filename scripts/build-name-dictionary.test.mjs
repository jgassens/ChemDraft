import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildRows, cachedJson, casValid, collectItems, compressRows, hasStereoDescriptor, nameAccuracy, nameKey, parseRows, risky, serializeRows, snapshotCounts, usableNames } from "./build-name-dictionary.mjs";

// Synthetic SPARQL response: real aspirin/paracetamol identities, invented collisions.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/name-dictionary.sparql.json", import.meta.url), "utf8"));
const ASPIRIN = "BSYNRYMUTXBXSQ-UHFFFAOYSA-N";
const PARACETAMOL = "RZVAJINKPMORJF-UHFFFAOYSA-N";
const aspirinSmiles = "CC(=O)OC1=CC=CC=C1C(=O)O";
const paracetamolSmiles = "CC(=O)NC1=CC=C(C=C1)O";
const services = {
  keyOf: s => new Map([[aspirinSmiles, ASPIRIN], [paracetamolSmiles, PARACETAMOL]]).get(s),
  opsinSmiles: () => undefined,
  pubchem: async () => undefined,
  words: new Set(["aspirin", "acetaminophen"])
};

test("English labels survive shadowing and short-word filtering; new aliases need structure evidence", async () => {
  const called = [];
  const rows = await buildRows(collectItems(fixture), { ...services, opsinSmiles: name => {
    called.push(name);
    return ["paracetamol", "acetaminophen"].includes(name) ? paracetamolSmiles : aspirinSmiles;
  } });
  const aspirin = rows.find(row => row.key === ASPIRIN);
  assert.ok(aspirin.names.includes("aspirin"));
  assert.ok(aspirin.names.includes("Aspirin"));
  assert.ok(aspirin.names.includes("acetylsalicylic acid"));
  assert.ok(aspirin.names.includes("ASA"));
  assert.ok(!aspirin.names.includes("C9H8O4"));
  assert.deepEqual(aspirin.cas, ["50-78-2"]);
  assert.ok(called.includes("aspirin"));
  assert.ok(called.includes("acetylsalicylic acid"));
  assert.ok(rows.find(row => row.key === PARACETAMOL).names.includes("acetaminophen"));
});

test("ambiguous names in either exact-name column are dropped when PubChem has no winner", async () => {
  const items = collectItems(fixture);
  items.find(it => it.id === "Q57055").aliases.push("same short name");
  const rows = await buildRows(items, {
    ...services,
    baseline: [
      { id: "Q18216", smiles: aspirinSmiles, key: ASPIRIN, names: ["shared name", "second collision"], cas: [], suggest: ["same short name"] },
      { id: "Q57055", smiles: paracetamolSmiles, key: PARACETAMOL, names: ["shared-name", "second collision"], cas: [], suggest: ["same short name"] }
    ],
    opsinSmiles: name => name === "same short name" ? aspirinSmiles : undefined
  });
  for (const row of rows) {
    assert.ok(!row.names.some(n => nameKey(n) === nameKey("shared name")));
    assert.ok(!row.names.includes("second collision"));
    assert.ok(!row.suggest.includes("same short name"));
  }
});

test("new epimer names and stereo-bearing labels require full stereochemical agreement", async () => {
  const target = "OVRNDRQMDRJTHS-CBQIKETKSA-N", epimer = "OVRNDRQMDRJTHS-FMDGEEDCSA-N";
  const [item] = collectItems(fixture);
  const audit = {};
  const rows = await buildRows([{ ...item, keys: [target], canonical: ["target"], isomeric: [],
    labels: ["alpha-D-galactosamine"], aliases: ["N-Acetylglucosamin", "N-Acetylmannosamin",
      "2-Acetamido-2-deoxy-D-allopyranose", "OPSIN confirmed alias", "unverified alias"], german: [] }], {
    ...services, audit, keyOf: s => s === "target" ? target : s === "epimer" ? epimer : undefined,
    opsinSmiles: n => n === "OPSIN confirmed alias" ? "target" : /mannosamin|allopyranose/.test(n) ? "epimer" : undefined,
    pubchem: async n => n === "N-Acetylglucosamin" ? { key: epimer } : undefined
  });
  assert.deepEqual(rows[0].names, ["OPSIN confirmed alias"]);
  assert.deepEqual(audit.accuracy, { label: 0, opsin: 1, pubchem: 0, contradicted: 3, unverifiable: 2 });
  for (const name of ["D-glucose", "L-glucose", "α-glucose", "beta-glucose", "(2R,3S)-name", "N-Acetylmannosamin",
    "galactose", "allose", "altrose", "gulose", "idose", "talose"]) assert.ok(hasStereoDescriptor(name), name);
});

test("PubChem connectivity alone never confirms an epimer, including in collision resolution", async () => {
  const target = "OVRNDRQMDRJTHS-CBQIKETKSA-N", epimer = "OVRNDRQMDRJTHS-FMDGEEDCSA-N";
  assert.equal(await nameAccuracy("D-synthetic", { key: target }, {
    ...services, pubchem: async () => ({ key: epimer })
  }, true), "contradicted");
  assert.equal(await nameAccuracy("D-synthetic", { key: target }, {
    ...services, pubchem: async () => ({ key: target })
  }, true), "pubchem");
  const [item] = collectItems(fixture);
  const rows = await buildRows([
    { ...item, id: "Q1", labels: ["shared label"], aliases: [], german: [], keys: [target], canonical: ["target"], isomeric: [] },
    { ...item, id: "Q2", labels: ["shared label"], aliases: [], german: [], keys: [epimer], canonical: ["epimer"], isomeric: [] }
  ], { ...services, keyOf: s => s === "target" ? target : epimer,
    pubchem: async () => ({ key: "OVRNDRQMDRJTHS-UHFFFAOYSA-N" }) });
  assert.ok(rows.every(e => !e.names.includes("shared label")));
});

test("available contradictions veto even own labels or OPSIN confirmations", async () => {
  assert.equal(await nameAccuracy("aspirin", { key: ASPIRIN }, {
    ...services, opsinSmiles: () => paracetamolSmiles
  }, true), "contradicted");
  assert.equal(await nameAccuracy("aspirin", { key: ASPIRIN }, {
    ...services, opsinSmiles: () => aspirinSmiles, pubchem: async () => ({ key: PARACETAMOL })
  }, true), "contradicted");
});

test("new names are grandfathered only for their existing full identity", async () => {
  const baseline = [{ id: "Q1", key: ASPIRIN, smiles: aspirinSmiles, names: ["legacy alias"], cas: [], suggest: [] }];
  const items = collectItems(fixture).map(it => ({ ...it, aliases: ["legacy alias"], german: [] }));
  const rows = await buildRows(items, { ...services, baseline });
  assert.ok(rows.find(e => e.key === ASPIRIN).names.includes("legacy alias"));
  assert.ok(!rows.find(e => e.key === PARACETAMOL).names.includes("legacy alias"));
});

test("conflated German source names never gain an own-label exception", async () => {
  const [item] = collectItems(fixture);
  const rows = await buildRows([{ ...item, labels: [], aliases: [], german: ["unverified German name"] }], services);
  assert.deepEqual(rows[0].names, []);
  assert.deepEqual(rows[0].suggest, []);
});

test("searchability counts split old column-five names from names absent from the entire baseline", () => {
  const baseline = parseRows(`${aspirinSmiles}\told name\t50-78-2\t${ASPIRIN}\tcolumn five\n`);
  const rows = [{ ...baseline[0], names: ["old name", "column five", "entirely new"], suggest: [] }];
  assert.deepEqual(snapshotCounts(rows, baseline).newlySearchableVsOldColumn2,
    { total: 2, oldColumn5Only: 1, absentFromOldFile: 1 });
});

test("legacy compounds, CAS and exact names survive engine rejection or changed InChIKey", async () => {
  const baseline = parseRows(`${aspirinSmiles}\tlegacy alias\t50-78-2\t${ASPIRIN}\tlegacy stereo name\n`);
  const [item] = collectItems(fixture);
  for (const keyOf of [() => undefined, () => PARACETAMOL]) {
    const rows = await buildRows([{ ...item, labels: [], aliases: [], german: [] }], { ...services, baseline, keyOf });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].smiles, aspirinSmiles);
    assert.equal(rows[0].key, ASPIRIN);
    assert.deepEqual(rows[0].names, ["legacy alias"]);
    assert.deepEqual(rows[0].suggest, ["legacy stereo name"]);
    const counts = snapshotCounts(rows, baseline);
    assert.deepEqual(counts.compoundsLost, []);
    assert.deepEqual(counts.casAssignmentsLost, []);
  }
  const rows = await buildRows([], { ...services, baseline });
  assert.equal(rows[0].key, ASPIRIN, "even an item absent from the current selection retains its baseline row");
});

test("offline requests fail loudly for absent cache files; uncached gate evidence is explicit abstention", async () => {
  await assert.rejects(cachedJson(fileURLToPath(new URL("./fixtures/", import.meta.url)), "pubchem",
    { key: "synthetic uncached name", url: "https://example.invalid" }, true), /Offline cache miss: pubchem.*synthetic uncached name/);
  assert.equal(await nameAccuracy("unknown alias", { key: ASPIRIN }, {
    ...services, pubchemAvailable: () => false, pubchem: async () => { throw new Error("must not request"); }
  }), "unverifiable");
});

test("PubChem resolves each name collision independently and keeps only its compound", async () => {
  const rows = await buildRows(collectItems(fixture), { ...services, pubchem: async name => {
    if (nameKey(name) === "sharedname") return { key: ASPIRIN, smiles: aspirinSmiles };
    if (name === "second collision") return { key: PARACETAMOL, smiles: paracetamolSmiles };
  } });
  assert.ok(rows.find(row => row.key === ASPIRIN).names.includes("shared name"));
  assert.ok(!rows.find(row => row.key === PARACETAMOL).names.includes("shared-name"));
  assert.ok(rows.find(row => row.key === PARACETAMOL).names.includes("second collision"));
  assert.ok(!rows.find(row => row.key === ASPIRIN).names.includes("second collision"));
});

test("only single-active-ingredient brands become aliases", () => {
  const binding = (brand, label, ingredient) => ({ brand: { value: `http://www.wikidata.org/entity/${brand}` },
    label: { value: label }, ingredient: { value: `http://www.wikidata.org/entity/${ingredient}` } });
  const items = collectItems(fixture, { results: { bindings: [
    binding("Q1", "Tylenol", "Q57055"), binding("Q1", "Tylenol", "Q57055"),
    binding("Q2", "Synthetic combination", "Q18216"), binding("Q2", "Synthetic combination", "Q57055")
  ] } });
  assert.ok(items.find(it => it.id === "Q57055").aliases.includes("Tylenol"));
  assert.ok(items.every(it => !it.aliases.includes("Synthetic combination")));
});

test("format, identifier, formula and name filters retain upstream behavior", () => {
  for (const invalid of ["C6H6", "Zn2+", "As₂O₃", "11Na", "CCO", "InChI=1S/CH4/h1H4", ASPIRIN,
    "50-78-2", "123-456-7", "12345", "A123456789", "https://example.test", "a|b", "a\tb", "a\nb", "!name", "x".repeat(81)]) {
    assert.deepEqual(usableNames(invalid), [], invalid);
  }
  assert.deepEqual(usableNames("α-pinene™"), ["α-pinene", "alpha-pinene"]);
  assert.deepEqual(usableNames("Essigsäure®"), ["Essigsäure", "Essigsaeure"]);
  assert.ok(casValid("50-78-2")); assert.ok(!casValid("50-78-3"));
  assert.ok(risky("TEN", new Set())); assert.ok(risky("beans", new Set(["bean"])));
  assert.ok(!risky("benzaldehyde", new Set()));
});

test("structure selection prefers isomeric SMILES and matching full InChIKey, merges equal identities", async () => {
  const [item] = collectItems(fixture);
  const rows = await buildRows([
    { ...item, canonical: [paracetamolSmiles], isomeric: [aspirinSmiles] },
    { ...item, id: "Q99999", labels: ["synthetic alternate name"] },
    { ...item, id: "Q100000", keys: [], canonical: [aspirinSmiles, paracetamolSmiles], isomeric: [] },
    { ...item, id: "Q100001", canonical: ["unreadable"], isomeric: [] }
  ], services);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].smiles, aspirinSmiles);
  assert.ok(rows[0].names.includes("synthetic alternate name"));
});

test("shuffled endpoint rows produce identical sorted TSV and stable gzip bytes", async () => {
  const a = await buildRows(collectItems(fixture), services);
  const reversed = { ...fixture, results: { bindings: [...fixture.results.bindings].reverse() } };
  const b = await buildRows(collectItems(reversed).reverse(), services);
  assert.equal(serializeRows(a), serializeRows(b));
  assert.deepEqual(compressRows(a), compressRows(b));
  assert.equal(compressRows(a).readUInt32LE(4), 0);
  assert.equal(compressRows(a)[9], 255);
  assert.equal(gunzipSync(compressRows(a)).toString("utf8"), serializeRows(a));
  assert.ok(serializeRows(a).slice(0, -1).split("\n").every(line => line.split("\t").length === 5));
});

test("dry-run prints selection, details and brand SPARQL without loading engines or fetching", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./build-name-dictionary.mjs", import.meta.url)), "--dry-run"], { encoding: "utf8" });
  assert.equal((output.match(/SELECT DISTINCT \?item/g) ?? []).length, 10);
  assert.match(output, /SELECT \?item \?kind \?v/);
  assert.match(output, /skos:altLabel/);
  assert.match(output, /LANG\(\?v\) = "en"/);
  assert.match(output, /wdt:P3781/);
});
