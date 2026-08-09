export interface FixtureDescriptor {
  id: string;
  format: string;
  description: string;
  path: string;
}

export const cdxmlFixtureDescriptors: FixtureDescriptor[] = [
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
