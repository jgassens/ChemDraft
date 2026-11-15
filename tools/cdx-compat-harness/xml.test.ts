import { describe, expect, it } from "vitest";
import { parseSourceXml } from "./xml";

describe("source XML element tree (synthetic inputs)", () => {
  it("retains attributes, nesting and source order for survival objects", () => {
    const root = parseSourceXml(`<CDXML><page id="001"><scheme><step ReactionStepArrows='050 051' /></scheme>
      <graphic id="050" GraphicType="Line" SupersededBy="051"/><arrow id="051"/>
      <fragment><n NodeType="Nickname"><t><s>Me</s></t>
        <fragment><curve/></fragment></n><t><s>caption</s></t></fragment></page></CDXML>`);
    const page = root.kids[0];
    expect(page.attrs.id).toBe("001");
    expect(page.kids.map(n => n.name)).toEqual(["scheme", "graphic", "arrow", "fragment"]);
    expect(page.kids[0].kids[0].attrs.ReactionStepArrows).toBe("050 051");
    expect(page.kids[1].attrs).toEqual({ id: "050", GraphicType: "Line", SupersededBy: "051" });
    const node = page.kids[3].kids[0];
    expect(node.attrs.NodeType).toBe("Nickname");
    expect(node.kids[0].kids[0].text).toBe("Me");
    expect(node.kids[1].kids[0].name).toBe("curve");
    expect(page.kids[3].kids[1].kids[0].text).toBe("caption");
  });

  it("decodes XML entities once in text and either attribute quote style", () => {
    const root = parseSourceXml(`<t a="&lt;&gt;&amp;&quot;&apos;&#10;&#x9;&#x1F9EA;" b='&quot; > /&gt;'>
      <s>&amp;#32;&amp;amp; &unknown; &#32;&#x20;&lt;&gt;&quot;&apos;</s></t>`);
    expect(root.attrs.a).toBe('<>&"\'\n\t🧪');
    expect(root.attrs.b).toBe('" > />');
    expect(root.kids[0].text).toBe('&#32;&amp; &unknown;   <>"\'');
  });

  it("preserves whitespace and CDATA and ignores comments, instructions and DTD declarations", () => {
    const root = parseSourceXml(`\uFEFF<?xml version="1.0"?>
      <!DOCTYPE CDXML SYSTEM "unused>file" [<!ENTITY custom "not expanded">]>
      <!-- <graphic/> --><CDXML><?ignored value?><page><t><s>  \n</s>
      <![CDATA[<arrow/> &amp;]]><s>&custom;</s></t></page></CDXML>`);
    expect(root.kids[0].kids.map(n => n.name)).toEqual(["t"]);
    const text = root.kids[0].kids[0];
    expect(text.kids[0].text).toBe("  \n");
    expect(text.text).toContain("<arrow/> &amp;");
    expect(text.kids[1].text).toBe("&custom;");
  });

  it("handles empty elements and consecutive reads without retaining parser state", () => {
    for (const xml of ["<CDXML/>", "<CDXML />", "<CDXML></CDXML>"]) {
      expect(parseSourceXml(xml)).toEqual({ name: "CDXML", attrs: {}, kids: [], text: "" });
    }
  });

  it.each([
    "", "<CDXML>", "<CDXML><page></CDXML>", "<CDXML/><page/>",
    "<CDXML id=1/>", '<CDXML id="1" id="2"/>', '<CDXML id="<arrow/>"/>',
    "<CDXML><!--unfinished</CDXML>", "<CDXML><![CDATA[unfinished</CDXML>",
    "<!DOCTYPE CDXML [<CDXML/>", "text<CDXML/>", "<CDXML/>text", "<CDXML>&#0;</CDXML>"
  ])("rejects malformed or incomplete source XML: %s", xml => {
    expect(() => parseSourceXml(xml)).toThrow(/source XML/i);
  });
});
