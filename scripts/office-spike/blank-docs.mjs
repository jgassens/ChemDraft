// Dependency-free, deterministic blank Office packages for the clipboard measurement.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

/** Classic ZIP records, UTF-8 names, and a fixed DOS epoch (1980-01-01). */
export function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name, 'utf8'), data = Buffer.from(text, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(0x21, 12); // DOS date; time is zero
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by DOS, version 2.0
    local.copy(central, 6, 4, 30); // shared fields through extra length
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const ns = 'http://schemas.openxmlformats.org';
const officeRel = `${ns}/officeDocument/2006/relationships`;
const a = `${ns}/drawingml/2006/main`, p = `${ns}/presentationml/2006/main`, w = `${ns}/wordprocessingml/2006/main`;
const xml = text => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}\n`;
const rels = entries => xml(`<Relationships xmlns="${ns}/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http:') ? type : `${officeRel}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`);
const contentTypes = parts => xml(`<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('')}</Types>`);
const core = xml(`<cp:coreProperties xmlns:cp="${ns}/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>ChemDraft</dc:creator><cp:lastModifiedBy>ChemDraft</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`);
const app = (name, extra = '') => xml(`<Properties xmlns="${ns}/officeDocument/2006/extended-properties" xmlns:vt="${ns}/officeDocument/2006/docPropsVTypes"><Application>${name}</Application>${extra}<AppVersion>16.0000</AppVersion></Properties>`);
const rootRels = target => rels([
  ['rId1', 'officeDocument', target],
  ['rId2', `${ns}/package/2006/relationships/metadata/core-properties`, 'docProps/core.xml'],
  ['rId3', 'extended-properties', 'docProps/app.xml'],
]);
const metadataTypes = [
  ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ['docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
];

function wordParts() {
  const types = [
    ['word/document.xml', 'document.main'], ['word/styles.xml', 'styles'], ['word/settings.xml', 'settings'],
  ].map(([name, type]) => [name, `application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml`]);
  return [
    ['[Content_Types].xml', contentTypes([...types, ...metadataTypes])],
    ['_rels/.rels', rootRels('word/document.xml')],
    ['word/document.xml', xml(`<w:document xmlns:w="${w}" xmlns:r="${officeRel}"><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`)],
    ['word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'settings', 'settings.xml']])],
    ['word/styles.xml', xml(`<w:styles xmlns:w="${w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`)],
    ['word/settings.xml', xml(`<w:settings xmlns:w="${w}"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`)],
    ['docProps/core.xml', core], ['docProps/app.xml', app('Microsoft Office Word')],
  ];
}

// Original neutral theme; each DrawingML format list has exactly three entries.
function theme() {
  const colours = [
    ['dk1', '202020'], ['lt1', 'FFFFFF'], ['dk2', '384454'], ['lt2', 'F2F4F6'],
    ['accent1', '356A95'], ['accent2', 'BD633C'], ['accent3', '65834B'],
    ['accent4', '82649A'], ['accent5', '34888C'], ['accent6', 'BE963F'],
    ['hlink', '0000FF'], ['folHlink', '800080'],
  ].map(([name, rgb]) => `<a:${name}><a:srgbClr val="${rgb}"/></a:${name}>`).join('');
  const fonts = kind => `<a:${kind}Font><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:${kind}Font>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const lines = [9525, 25400, 38100].map(width => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('');
  return xml(`<a:theme xmlns:a="${a}" name="ChemDraft Neutral"><a:themeElements><a:clrScheme name="ChemDraft Neutral">${colours}</a:clrScheme><a:fontScheme name="ChemDraft Neutral">${fonts('major')}${fonts('minor')}</a:fontScheme><a:fmtScheme name="ChemDraft Neutral"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`);
}
const spTree = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
const clrMapOvr = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';
const pNamespaces = `xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${officeRel}"`;

function powerpointParts() {
  const types = [
    ['ppt/presentation.xml', 'presentation.main'], ['ppt/presProps.xml', 'presProps'],
    ['ppt/viewProps.xml', 'viewProps'], ['ppt/tableStyles.xml', 'tableStyles'],
    ['ppt/slideMasters/slideMaster1.xml', 'slideMaster'], ['ppt/slideLayouts/slideLayout1.xml', 'slideLayout'],
    ['ppt/slides/slide1.xml', 'slide'],
  ].map(([name, type]) => [name, `application/vnd.openxmlformats-officedocument.presentationml.${type}+xml`]);
  return [
    ['[Content_Types].xml', contentTypes([...types, ['ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'], ...metadataTypes])],
    ['_rels/.rels', rootRels('ppt/presentation.xml')],
    ['ppt/presentation.xml', xml(`<p:presentation ${pNamespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)],
    ['ppt/_rels/presentation.xml.rels', rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'presProps', 'presProps.xml'], ['rId4', 'viewProps', 'viewProps.xml'], ['rId5', 'tableStyles', 'tableStyles.xml'],
    ])],
    ['ppt/presProps.xml', xml(`<p:presentationPr ${pNamespaces}/>`)],
    ['ppt/viewProps.xml', xml(`<p:viewPr ${pNamespaces}/>`)],
    ['ppt/tableStyles.xml', xml(`<a:tblStyleLst xmlns:a="${a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)],
    ['ppt/slideMasters/slideMaster1.xml', xml(`<p:sldMaster ${pNamespaces}><p:cSld>${spTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`)],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', xml(`<p:sldLayout ${pNamespaces} type="blank" preserve="1"><p:cSld name="Blank">${spTree}</p:cSld>${clrMapOvr}</p:sldLayout>`)],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slides/slide1.xml', xml(`<p:sld ${pNamespaces}><p:cSld>${spTree}</p:cSld>${clrMapOvr}</p:sld>`)],
    ['ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])],
    ['ppt/theme/theme1.xml', theme()],
    ['docProps/core.xml', core],
    ['docProps/app.xml', app('Microsoft Office PowerPoint', '<PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>1</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides>')],
  ];
}

export function writeBlankDocuments(outdir) {
  const directory = resolve(outdir);
  mkdirSync(directory, { recursive: true });
  return [['blank.docx', wordParts()], ['blank.pptx', powerpointParts()]].map(([name, parts]) => {
    const path = join(directory, name);
    writeFileSync(path, writeZip(parts));
    return path;
  });
}

// realpath also permits invoking this CLI through a directory symlink/junction.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
    console.error('Usage: node scripts/office-spike/blank-docs.mjs <outdir>');
    process.exitCode = 2;
  } else {
    try {
      for (const path of writeBlankDocuments(process.argv[2])) console.log(path);
    } catch (error) {
      console.error(`Could not write blank Office documents: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
