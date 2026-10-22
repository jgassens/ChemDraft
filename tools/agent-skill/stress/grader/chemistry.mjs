import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const METHOD_IDS = { logp: 'rdkit.crippen-logp', tpsa: 'rdkit.tpsa', hbd: 'rdkit.hbd', hba: 'rdkit.hba',
  'monoisotopic-mass': 'rdkit.monoisotopic-mass', 'average-mass': 'rdkit.average-mass', 'rotatable-bonds': 'rdkit.rotatable-bonds' };

/** Use the repo's adapter singleton. Do not invoke CLI run* functions here: their repeated
 * installNodeEngines calls reset the singleton, even inside a batch. The stereo perceptions,
 * counts and analysis summary below are the same helpers used by those commands. */
export async function createChemistry(checkout) {
  const require = createRequire(join(checkout, 'package.json'));
  const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  register({ tsconfig: join(checkout, 'tsconfig.json') });
  const cjs = await import(pathToFileURL(require.resolve('tsx/cjs/api')).href);
  cjs.register();
  const load = (path) => import(pathToFileURL(join(checkout, path)).href);
  const document = await load('packages/chemdraft-cli/src/document.ts');
  const { installNodeEngines } = await load('packages/chemdraft-cli/src/engine.ts');
  const { perceiveDoubleBondStereo } = await load('packages/chemdraft-cli/src/commands/stereo.ts');
  const { summarizeAnalysisRun } = await load('packages/chemdraft-cli/src/commands/analyze.ts');
  // Resolve through the CLI package, as its document/stereo/analysis modules do. This also
  // keeps worktrees with symlinked dependencies on the same adapter module instance.
  const cliRequire = createRequire(join(checkout, 'packages/chemdraft-cli/package.json'));
  const adapter = await import(pathToFileURL(cliRequire.resolve('@chemdraft/rdkit-adapter')).href);
  const ocl = await import(pathToFileURL(cliRequire.resolve('@chemdraft/ocl-adapter')).href);
  const workflow = await import(pathToFileURL(cliRequire.resolve('@chemdraft/document-workflow-core')).href);
  const { computeStructureIdentifiers } = await import(pathToFileURL(cliRequire.resolve('@chemdraft/rdkit-adapter/identifiers')).href);
  const { loadAgentDocument } = await load('packages/chemdraft-cli/src/documentInput.ts');
  installNodeEngines();
  let engineLoads = 0;
  let engine;
  const warm = async () => {
    if (!engine) { engine = await adapter.ensureRdkit(); engineLoads++; }
    return engine;
  };
  const cache = new Map();
  async function canonical(smiles, constitution = false) {
    const key = `${constitution}:${smiles}`;
    if (!cache.has(key)) {
      await warm();
      // Removing SMILES stereo descriptors only is lossless for constitution, isotopes,
      // charge and disconnected components. RDKit then canonicalises the resulting graph.
      const input = constitution ? smiles.replace(/@(?:TH|AL|SP|TB|OH)\d+|@@?/g, '').replace(/[\\/]/g, '') : smiles;
      cache.set(key, await document.canonicalSmiles(input, 'grader input'));
    }
    return cache.get(key);
  }
  const stereoCache = new Map();
  async function stereo(smiles) {
    if (!stereoCache.has(smiles)) {
      await warm();
      const molfile = await adapter.generateSmiles2DMolfile(smiles);
      const centers = ocl.perceiveStereoCentersFromMolfile(molfile);
      const doubleBonds = await perceiveDoubleBondStereo(molfile);
      const counts = document.stereoCenterCounts(centers);
      const unspecifiedDoubleBonds = doubleBonds.filter((bond) => bond.descriptor === 'unspecified').length;
      stereoCache.set(smiles, { ...counts, unspecifiedDoubleBonds,
        unspecifiedCount: counts.unspecifiedStereoCenters + unspecifiedDoubleBonds });
    }
    return stereoCache.get(smiles);
  }
  async function analyze(smiles, methods) {
    await warm();
    const methodIds = methods.map((method) => METHOD_IDS[method] ?? method);
    const { run } = await adapter.analyzeStructureDetailed({ format: 'smiles', value: smiles, methodIds,
      runId: 'stress-grader', startedAt: new Date().toISOString() });
    const summary = summarizeAnalysisRun(run);
    return methods.map((method, i) => {
      const source = run.results.find((entry) => entry.methodId === methodIds[i] && entry.interpretationId === 'source');
      const fallback = summary[method === 'logp' ? 'logP' : method];
      return { method, methodId: methodIds[i], value: source?.value ?? fallback?.value ?? null,
        status: source?.status ?? fallback?.status ?? 'not-requested' };
    });
  }
  async function native(file) {
    await warm();
    // Separate unreadable retained artifacts (grader failure) from a readable
    // document whose content the agent got wrong. Engine errors stay untagged.
    await readFile(file);
    let nativeDocument;
    try { ({ document: nativeDocument } = await loadAgentDocument(file)); }
    catch (error) { error.agentInput = !/\b(?:ENOENT|EACCES|EPERM|EIO)\b/.test(error.message); throw error; }
    const molecules = [];
    for (const page of nativeDocument.pages) for (const object of page.objects) {
      if (object.type !== 'molecule') continue;
      const warnings = [];
      const smiles = await workflow.moleculeSmiles(object, molecules.length, warnings,
        computeStructureIdentifiers, undefined, { requireEngineAtomStates: true });
      if (warnings.some((warning) => !['export.smiles_abbreviation_expanded', 'export.smiles_charge_separated'].includes(warning.code))) {
        throw new Error(`Cannot recover native molecule ${object.id}: ${warnings.map((warning) => warning.message).join('; ')}`);
      }
      molecules.push({ smiles: await canonical(smiles), objectId: object.id, pageId: page.id, object });
    }
    return { document: nativeDocument, molecules };
  }
  return { canonical, stereo, analyze, native, svgToPng: document.svgToPng, get engineLoads() { return engineLoads; } };
}

export function invertTetrahedral(smiles) {
  // Canonical RDKit output uses @/@@ for tetrahedral stereo. Leave / and \\ (E/Z) alone.
  return smiles.replace(/\[[^\]]+\]/g, (atom) => atom.replace(/@TH[12]|@@|@(?![A-Z]{2}\d)/g,
    (tag) => ({ '@': '@@', '@@': '@', '@TH1': '@TH2', '@TH2': '@TH1' })[tag]));
}
