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
    id: "cdxml.unsupported-step",
    format: "cdxml",
    description: "Synthetic unsupported step object for unknown compatibility preservation.",
    path: "packages/fixtures/cdxml/unsupported-step.cdxml"
  }
];

export const fixtureDescriptors: FixtureDescriptor[] = [...cdxmlFixtureDescriptors];

export const cdxmlFixtures: Record<string, string> = {
  "empty-page.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792"/>
</CDXML>
`,
  "single-bond.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f1">
      <n id="a1" p="75 75"/>
      <n id="a2" p="111 75"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
  </page>
</CDXML>
`,
  "heteroatom-double.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f1">
      <n id="a1" p="75 75"/>
      <n id="a2" p="111 75" Element="8" Charge="-1"/>
      <b id="b1" B="a1" E="a2" Order="2"/>
    </fragment>
  </page>
</CDXML>
`,
  "triple-bond.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f1">
      <n id="a1" p="96 96"/>
      <n id="a2" p="132 96" Element="7"/>
      <b id="b1" B="a1" E="a2" Order="3"/>
    </fragment>
  </page>
</CDXML>
`,
  "aromatic-bond.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f1">
      <n id="a1" p="120 120"/>
      <n id="a2" p="156 120"/>
      <b id="b1" B="a1" E="a2" Order="1.5"/>
    </fragment>
  </page>
</CDXML>
`,
  "wedge-hash-dash-bold.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f1">
      <n id="a1" p="150 150"/>
      <n id="a2" p="186 150"/>
      <n id="a3" p="150 186"/>
      <n id="a4" p="186 186"/>
      <n id="a5" p="168 222"/>
      <b id="b1" B="a1" E="a2" Order="1" Display="WedgeBegin"/>
      <b id="b2" B="a1" E="a3" Order="1" Display="Hash"/>
      <b id="b3" B="a2" E="a4" Order="1" Display="Dash"/>
      <b id="b4" B="a3" E="a5" Order="1" Display="Bold"/>
    </fragment>
  </page>
</CDXML>
`,
  "crossing-bonds.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <fragment id="f_back">
      <n id="a1" p="144 144"/>
      <n id="a2" p="216 216"/>
      <b id="b_back" B="a1" E="a2" Order="1" Z="1" CrossingBonds="b_front"/>
    </fragment>
    <fragment id="f_front">
      <n id="a3" p="216 144"/>
      <n id="a4" p="144 216"/>
      <b id="b_front" B="a3" E="a4" Order="1" Z="2" Display="Bold" CrossingBonds="b_back"/>
    </fragment>
    <graphic id="g_crossing" BoundingBox="174 174 186 186" GraphicType="Bracket" BracketType="Round" LipSize="60"/>
    <bracketedgroup id="bg_crossing" BracketedObjectIDs="a1 a2">
      <bracketattachment id="ba_crossing" GraphicID="g_crossing">
        <crossingbond id="cb_crossing" BondID="b_back" InnerAtomID="a1"/>
      </bracketattachment>
    </bracketedgroup>
  </page>
</CDXML>
`,
  "bactvue-visible-subset.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <t id="conditions" p="120 84">DIPEA, DMSO</t>
    <graphic id="arrow1" GraphicType="Line" ArrowType="FullHead" BoundingBox="156 96 252 96" Start="156 96" End="252 96"/>
    <fragment id="f_stereo_display">
      <n id="s1" p="168 168"/>
      <n id="s2" p="204 168"/>
      <n id="s3" p="168 204"/>
      <n id="s4" p="204 204"/>
      <n id="s5" p="186 240"/>
      <b id="sb1" B="s1" E="s2" Order="1" Display="WedgeBegin"/>
      <b id="sb2" B="s1" E="s3" Order="1" Display="WedgedHashBegin"/>
      <b id="sb3" B="s2" E="s4" Order="1" Display="Dash"/>
      <b id="sb4" B="s3" E="s5" Order="1" Display="Bold"/>
    </fragment>
    <fragment id="f_back">
      <n id="c1" p="168 300"/>
      <n id="c2" p="240 372"/>
      <b id="b_back" B="c1" E="c2" Order="1" Z="1" CrossingBonds="b_front"/>
    </fragment>
    <fragment id="f_front">
      <n id="c3" p="168 372"/>
      <n id="c4" p="240 300"/>
      <b id="b_front" B="c3" E="c4" Order="1" Z="2" Display="Bold" CrossingBonds="b_back"/>
    </fragment>
    <graphic id="g_crossing" BoundingBox="198 330 210 342" GraphicType="Bracket" BracketType="Round" LipSize="60"/>
    <bracketedgroup id="bg_crossing" BracketedObjectIDs="c1 c2">
      <bracketattachment id="ba_crossing" GraphicID="g_crossing">
        <crossingbond id="cb_crossing" BondID="b_back" InnerAtomID="c1"/>
      </bracketattachment>
    </bracketedgroup>
  </page>
</CDXML>
`,
  "text-plus-molecule.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <t id="t1" p="72 72">  reagent &amp; label  </t>
    <t id="plus1" p="144 96">+</t>
    <fragment id="f1">
      <n id="a1" p="180 120"/>
      <n id="a2" p="216 120" Element="17"/>
      <b id="b1" B="a1" E="a2" Order="1"/>
    </fragment>
  </page>
</CDXML>
`,
  "reaction-arrow.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <graphic id="arrow1" GraphicType="Line" ArrowType="forward" BoundingBox="120 120 216 120" Start="120 120" End="216 120"/>
  </page>
</CDXML>
`,
  "unsupported-step.cdxml": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">
<CDXML CreationProgram="ChemDraft Synthetic Fixture">
  <page id="p1" BoundingBox="0 0 612 792">
    <step id="step1">
      <scheme id="scheme1"/>
    </step>
  </page>
</CDXML>
`
};
