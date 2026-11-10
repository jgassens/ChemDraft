export interface FixtureDescriptor {
  id: string;
  format: string;
  description: string;
  path: string;
}

export const cdxmlFixtureDescriptors: FixtureDescriptor[] = [
  { id: "cdxml.brackets-native-multiple", format: "cdxml", description: "Synthetic native multiple bracket group with repeat count and a scoped crossing bond.", path: "packages/fixtures/cdxml/brackets-native-multiple.cdxml" },
  { id: "cdxml.brackets-native-sru", format: "cdxml", description: "Synthetic native SRU bracket group with repeat label, crossing bond and reversed graphic endpoints.", path: "packages/fixtures/cdxml/brackets-native-sru.cdxml" },
  { id: "cdxml.brackets-square", format: "cdxml", description: "Synthetic square bracket graphics with pair attachments.", path: "packages/fixtures/cdxml/brackets-square.cdxml" },
  { id: "cdxml.brackets-round", format: "cdxml", description: "Synthetic round bracket graphics with pair attachments.", path: "packages/fixtures/cdxml/brackets-round.cdxml" },
  { id: "cdxml.brackets-repeat-labels", format: "cdxml", description: "Synthetic SRU brackets and independent n/m label text; repeat-label association remains unsupported.", path: "packages/fixtures/cdxml/brackets-repeat-labels.cdxml" },
  { id: "cdxml.brackets-sru", format: "cdxml", description: "Synthetic SRU bracket group containing a fragment.", path: "packages/fixtures/cdxml/brackets-sru.cdxml" },
  { id: "cdxml.brackets-sru-crossing", format: "cdxml", description: "Synthetic SRU bracket group with a crossing bond.", path: "packages/fixtures/cdxml/brackets-sru-crossing.cdxml" },
  { id: "cdxml.brackets-unresolved-membership", format: "cdxml", description: "Synthetic SRU bracket group with unresolved membership.", path: "packages/fixtures/cdxml/brackets-unresolved-membership.cdxml" },
  { id: "cdxml.brackets-unsupported-usage", format: "cdxml", description: "Synthetic bracket group with unsupported component usage.", path: "packages/fixtures/cdxml/brackets-unsupported-usage.cdxml" },
  { id: "cdxml.scheme-and-sru", format: "cdxml", description: "Synthetic reaction scheme and atom-level polyethylene SRU written for the binary-CDX bracket-reference regression test.", path: "packages/fixtures/cdxml/scheme-and-sru.cdxml" },
  {
    id: "cdxml.empty-page",
    format: "cdxml",
    description: "Synthetic CDXML document with a single empty page.",
    path: "packages/fixtures/cdxml/empty-page.cdxml"
  },
  {
    id: "cdxml.single-bond",
    format: "cdxml",
    description: "Synthetic carbon-carbon single bond fragment.",
    path: "packages/fixtures/cdxml/single-bond.cdxml"
  },
  {
    id: "cdxml.heteroatom-double",
    format: "cdxml",
    description: "Synthetic carbon-oxygen double bond fragment with charge metadata.",
    path: "packages/fixtures/cdxml/heteroatom-double.cdxml"
  },
  {
    id: "cdxml.triple-bond",
    format: "cdxml",
    description: "Synthetic carbon-nitrogen triple bond fragment.",
    path: "packages/fixtures/cdxml/triple-bond.cdxml"
  },
  {
    id: "cdxml.aromatic-bond",
    format: "cdxml",
    description: "Synthetic aromatic bond fixture for approximation warnings.",
    path: "packages/fixtures/cdxml/aromatic-bond.cdxml"
  },
  {
    id: "cdxml.wedge-hash-dash-bold",
    format: "cdxml",
    description: "Synthetic bond display fixture for unsupported visible display warnings.",
    path: "packages/fixtures/cdxml/wedge-hash-dash-bold.cdxml"
  },
  {
    id: "cdxml.crossing-bonds",
    format: "cdxml",
    description: "Synthetic CDXML crossing fixture with reciprocal CrossingBonds and crossingbond attachment metadata.",
    path: "packages/fixtures/cdxml/crossing-bonds.cdxml"
  },
  {
    id: "cdxml.bactvue-visible-subset",
    format: "cdxml",
    description: "Synthetic BactVue-style integration fixture with text, arrow, bond display marks, and crossing metadata.",
    path: "packages/fixtures/cdxml/bactvue-visible-subset.cdxml"
  },
  {
    id: "cdxml.text-plus-molecule",
    format: "cdxml",
    description: "Synthetic CDXML page containing text, plus sign text, and a molecule.",
    path: "packages/fixtures/cdxml/text-plus-molecule.cdxml"
  },
  {
    id: "cdxml.reaction-arrow",
    format: "cdxml",
    description: "Synthetic line graphic with reaction-arrow metadata.",
    path: "packages/fixtures/cdxml/reaction-arrow.cdxml"
  },
  {
    id: "cdxml.scheme-and-sru",
    format: "cdxml",
    description: "Synthetic two-step reaction scheme and SRU bracket group with crossing bonds.",
    path: "packages/fixtures/cdxml/scheme-and-sru.cdxml"
  },
  {
    id: "cdxml.arrow-heads",
    format: "cdxml",
    description: "Synthetic standalone <arrow> elements covering the ArrowheadHead/ArrowheadTail/ArrowheadType spellings.",
    path: "packages/fixtures/cdxml/arrow-heads.cdxml"
  },
  {
    id: "cdxml.unsupported-step",
    format: "cdxml",
    description: "Synthetic unsupported step object for unknown compatibility preservation.",
    path: "packages/fixtures/cdxml/unsupported-step.cdxml"
  },
  {
    id: "cdxml.ten-metals",
    format: "cdxml",
    description: "Synthetic C–M–Cl fragments for Fe, Zn, Cu, Ni, Pd, Pt, Sn, Se, Hg and Au, each written by atomic number.",
    path: "packages/fixtures/cdxml/ten-metals.cdxml"
  },
  {
    id: "cdxml.invalid-element",
    format: "cdxml",
    description: "Synthetic O–X–N fragment whose middle atom has Element=\"119\", a number that names no element.",
    path: "packages/fixtures/cdxml/invalid-element.cdxml"
  }
];

export const fixtureDescriptors: FixtureDescriptor[] = [...cdxmlFixtureDescriptors];

// The `cdxml/` directory is the single source of truth. Vite inlines each file's
// text at build time, so importing this module never touches the filesystem and
// stays usable in browser and jsdom contexts.
const cdxmlModules = import.meta.glob<string>("../cdxml/*.cdxml", {
  query: "?raw",
  import: "default",
  eager: true
});

export const cdxmlFixtures: Record<string, string> = Object.fromEntries(
  Object.entries(cdxmlModules).map(([path, source]) => [path.slice(path.lastIndexOf("/") + 1), source])
);
