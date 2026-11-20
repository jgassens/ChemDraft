import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chunks } from '../png.mjs';
import { CLSID, PROG_ID, USER_TYPE, writeCfb } from './cfb-writer.mjs';
import { previewEmf } from './emf-writer.mjs';
import { writeZip } from './zip-compat.mjs';

const ns = 'http://schemas.openxmlformats.org';
const office = `${ns}/officeDocument/2006/relationships`;
const a = `${ns}/drawingml/2006/main`;
const p = `${ns}/presentationml/2006/main`;
const w = `${ns}/wordprocessingml/2006/main`;
const v = 'urn:schemas-microsoft-com:vml';
const o = 'urn:schemas-microsoft-com:office:office';
const mc = `${ns}/markup-compatibility/2006`;
const oleMime = 'application/vnd.openxmlformats-officedocument.oleObject';
const imageMime = 'image/x-emf';
const vmlMime = 'application/vnd.openxmlformats-officedocument.vmlDrawing';
const pptMime = 'application/vnd.openxmlformats-officedocument.presentationml';
const inch = 914400; // EMUs.

const xml = text => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}\n`;
const rels = entries => xml(`<Relationships xmlns="${ns}/package/2006/relationships">\n${entries.map(([id, type, target]) =>
  `<Relationship Id="rId${id}" Type="${office}/${type}" Target="${target}"/>`).join('\n')}\n</Relationships>`);
const types = (defaults, overrides) => xml(`<Types xmlns="${ns}/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="emf" ContentType="${imageMime}"/>
<Default Extension="bin" ContentType="${oleMime}"/>
${defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('\n')}
${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('\n')}
</Types>`);

const pictureShapeType = `<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t"
path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">
<v:stroke joinstyle="miter"/>
<v:formulas>${['if lineDrawn pixelLineWidth 0', 'sum @0 1 0', 'sum 0 0 @1', 'prod @2 1 2',
  'prod @3 21600 pixelWidth', 'prod @3 21600 pixelHeight', 'sum @0 0 1', 'prod @6 1 2',
  'prod @7 21600 pixelWidth', 'sum @8 21600 0', 'prod @7 21600 pixelHeight', 'sum @10 21600 0']
  .map(eq => `<v:f eq="${eq}"/>`).join('')}</v:formulas>
<v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/>
<o:lock v:ext="edit" aspectratio="t"/>
</v:shapetype>`;

function wordParts(emf, object, cx, cy) {
  const points = `width:${cx / 12700}pt;height:${cy / 12700}pt`;
  const document = xml(`<w:document xmlns:w="${w}" xmlns:r="${office}" xmlns:v="${v}" xmlns:o="${o}">
<w:body><w:p><w:r>
<w:object w:dxaOrig="${Math.round(cx / 635)}" w:dyaOrig="${Math.round(cy / 635)}">
${pictureShapeType}
<v:shape id="_x0000_i1025" type="#_x0000_t75" style="${points}" o:ole="">
<v:imagedata r:id="rId1" o:title=""/>
</v:shape>
<o:OLEObject Type="Embed" ProgID="${PROG_ID}" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1234567890" r:id="rId2"/>
</w:object></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`);
  return [
    ['[Content_Types].xml', types([], [
      ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ['word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ])],
    ['_rels/.rels', rels([[1, 'officeDocument', 'word/document.xml']])],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', rels([
      [1, 'image', 'media/image1.emf'], [2, 'oleObject', 'embeddings/oleObject1.bin'], [3, 'settings', 'settings.xml'],
    ])],
    ['word/settings.xml', xml(`<w:settings xmlns:w="${w}"><w:compat>
<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
</w:compat></w:settings>`)],
    ['word/media/image1.emf', emf],
    ['word/embeddings/oleObject1.bin', object],
  ];
}

const pNs = `xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${office}"`;
const groupStart = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const colorMapOverride = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';

function theme() {
  const colors = Object.entries({
    dk1: '202020', lt1: 'FFFFFF', dk2: '384454', lt2: 'F2F4F6', accent1: '356A95', accent2: 'BD633C',
    accent3: '65834B', accent4: '82649A', accent5: '34888C', accent6: 'BE963F', hlink: '0000FF', folHlink: '800080',
  }).map(([name, hex]) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`).join('');
  const fonts = ['major', 'minor'].map(kind => `<a:${kind}Font><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:${kind}Font>`).join('');
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const lines = [9525, 25400, 38100].map(width => `<a:ln w="${width}">${fill}</a:ln>`).join('');
  return xml(`<a:theme xmlns:a="${a}" name="ChemDraft Probe"><a:themeElements>
<a:clrScheme name="Probe">${colors}</a:clrScheme>
<a:fontScheme name="Probe">${fonts}</a:fontScheme>
<a:fmtScheme name="Probe">
<a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>
<a:lnStyleLst>${lines}</a:lnStyleLst>
<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>
<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`);
}

function powerpointParts(emf, object, cx, cy) {
  const offset = inch / 4;
  const position = `<a:off x="${offset}" y="${offset}"/><a:ext cx="${cx}" cy="${cy}"/>`;
  const picture = `<p:pic>
<p:nvPicPr><p:cNvPr id="3" name="ChemDraft preview"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm>${position}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>`;
  const oleAttrs = `name="${USER_TYPE}" r:id="rId2" imgW="${cx}" imgH="${cy}" progId="${PROG_ID}"`;
  // Office's VML choice uses spid to find the preview in its related VML drawing.
  const frame = `<p:graphicFrame>
<p:nvGraphicFramePr><p:cNvPr id="2" name="${USER_TYPE}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm>${position}</p:xfrm>
<a:graphic><a:graphicData uri="${ns}/presentationml/2006/ole">
<mc:AlternateContent>
<mc:Choice Requires="v"><p:oleObj ${oleAttrs} spid="_x0000_s1025"><p:embed/></p:oleObj></mc:Choice>
<mc:Fallback><p:oleObj ${oleAttrs}><p:embed/>${picture}</p:oleObj></mc:Fallback>
</mc:AlternateContent>
</a:graphicData></a:graphic>
</p:graphicFrame>`;
  const vml = xml(`<xml xmlns:v="${v}" xmlns:o="${o}">
<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>
${pictureShapeType}
<v:shape id="_x0000_s1025" type="#_x0000_t75" style="position:absolute;left:18pt;top:18pt;width:${cx / 12700}pt;height:${cy / 12700}pt" o:ole="">
<v:imagedata o:relid="rId1" o:title=""/>
</v:shape></xml>`);
  const overrides = [
    ['ppt/presentation.xml', 'presentation.main'],
    ['ppt/slides/slide1.xml', 'slide'],
    ['ppt/slideLayouts/slideLayout1.xml', 'slideLayout'],
    ['ppt/slideMasters/slideMaster1.xml', 'slideMaster'],
  ].map(([part, type]) => [part, `${pptMime}.${type}+xml`]);
  overrides.push(['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml']);

  return [
    ['[Content_Types].xml', types([['vml', vmlMime]], overrides)],
    ['_rels/.rels', rels([[1, 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', xml(`<p:presentation ${pNs}>
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`)],
    ['ppt/_rels/presentation.xml.rels', rels([[1, 'slideMaster', 'slideMasters/slideMaster1.xml'], [2, 'slide', 'slides/slide1.xml']])],
    ['ppt/slides/slide1.xml', xml(`<p:sld ${pNs} xmlns:mc="${mc}" xmlns:v="${v}"><p:cSld>${groupStart}${frame}</p:spTree></p:cSld>${colorMapOverride}</p:sld>`)],
    ['ppt/slides/_rels/slide1.xml.rels', rels([
      [1, 'slideLayout', '../slideLayouts/slideLayout1.xml'], [2, 'oleObject', '../embeddings/oleObject1.bin'],
      [3, 'image', '../media/image1.emf'], [4, 'vmlDrawing', '../drawings/vmlDrawing1.vml'],
    ])],
    ['ppt/drawings/vmlDrawing1.vml', vml],
    ['ppt/drawings/_rels/vmlDrawing1.vml.rels', rels([[1, 'image', '../media/image1.emf']])],
    ['ppt/slideLayouts/slideLayout1.xml', xml(`<p:sldLayout ${pNs} type="blank" preserve="1">
<p:cSld name="Blank">${groupStart}</p:spTree></p:cSld>${colorMapOverride}</p:sldLayout>`)],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([[1, 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slideMasters/slideMaster1.xml', xml(`<p:sldMaster ${pNs}>
<p:cSld>${groupStart}</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`)],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([[1, 'slideLayout', '../slideLayouts/slideLayout1.xml'], [2, 'theme', '../theme/theme1.xml']])],
    ['ppt/theme/theme1.xml', theme()],
    ['ppt/media/image1.emf', emf],
    ['ppt/embeddings/oleObject1.bin', object],
  ];
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function makeOleDocuments({ png, document, outDir }) {
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document));
  const pngChunks = chunks(png);
  const header = pngChunks[0].data;
  if (header.length !== 13) throw new Error('Invalid PNG IHDR length');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const phys = pngChunks.find(item => item.type === 'pHYs')?.data;
  const density = phys?.length === 9 && phys[8] === 1 && phys.readUInt32BE(0) === phys.readUInt32BE(4)
    ? phys.readUInt32BE(0) * 0.0254 : 0;
  const dpi = Math.round(density) || 96;
  const emf = previewEmf({ png, widthPx: width, heightPx: height, dpi });
  const object = writeCfb(document);

  const inchesPerPixel = Math.min(1 / dpi, 6.5 / width, 7 / height);
  const cx = Math.round(width * inchesPerPixel * inch);
  const cy = Math.round(height * inchesPerPixel * inch);
  const manifest = {
    clsid: CLSID, progId: PROG_ID,
    widthPx: width, heightPx: height, dpi, displayWidthIn: cx / inch, displayHeightIn: cy / inch,
    sha256: { png: sha256(png), emf: sha256(emf), oleObject: sha256(object), json: sha256(document) },
  };
  const files = [
    ['preview.emf', emf],
    ['oleObject1.bin', object],
    ['ole-word.docx', writeZip(wordParts(emf, object, cx, cy))],
    ['ole-ppt.pptx', writeZip(powerpointParts(emf, object, cx, cy))],
    ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
  ];
  mkdirSync(outDir, { recursive: true });
  for (const [name, data] of files) writeFileSync(join(outDir, name), data);
  return manifest;
}

const fixture = name => new URL(`../../../packages/fixtures/office/${name}`, import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { png: { type: 'string' }, json: { type: 'string' }, out: { type: 'string' } } });
    if (!values.out) throw new Error('Usage: node make-ole-docs.mjs [--png carrier.png] [--json payload.json] --out dir');
    makeOleDocuments({
      png: readFileSync(values.png ?? fixture('carriers/png-itxt.png')),
      document: readFileSync(values.json ?? fixture('sample-document.json')),
      outDir: values.out,
    });
    console.log(`Wrote OLE probe files to ${values.out}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
