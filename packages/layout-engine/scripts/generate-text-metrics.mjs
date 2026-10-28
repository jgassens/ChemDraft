import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/generate-text-metrics.mjs <AFM directory>");

// Adobe glyph names for ASCII, Latin-1, WinAnsi additions and ExtendedRoman symbols.
const names = {};
function mapNames(list, characters) {
  const keys = list.split(" ");
  if (keys.length !== [...characters].length) throw new Error("Invalid glyph-name table");
  keys.forEach((name, index) => { names[name] = [...characters][index].codePointAt(0); });
}
mapNames("space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash", " !\"#$%&'()*+,-./");
mapNames("zero one two three four five six seven eight nine colon semicolon less equal greater question at", "0123456789:;<=>?@");
mapNames("bracketleft backslash bracketright asciicircum underscore grave", "[\\]^_`");
mapNames("braceleft bar braceright asciitilde", "{|}~");
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") names[character] = character.codePointAt(0);
mapNames("exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown", "¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿");
mapNames("AE Eth Oslash Thorn germandbls ae eth oslash thorn multiply divide", "ÆÐØÞßæðøþ×÷");
mapNames("Euro quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE Zcaron quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe zcaron Ydieresis", "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
mapNames("fraction fi fl breve dotaccent ring hungarumlaut ogonek caron Lslash lslash dotlessi Dcroat dcroat lozenge partialdiff summation greaterequal lessequal Delta radical minus notequal", "⁄ﬁﬂ˘˙˚˝˛ˇŁłıĐđ◊∂∑≥≤∆√−≠");
names.commaaccent = 0x0326;
const accents = { grave: "\u0300", acute: "\u0301", circumflex: "\u0302", tilde: "\u0303", macron: "\u0304", breve: "\u0306", dotaccent: "\u0307", dieresis: "\u0308", ring: "\u030a", hungarumlaut: "\u030b", caron: "\u030c", cedilla: "\u0327", ogonek: "\u0328", commaaccent: "\u0326" };
// Adobe's legacy names use commaaccent for these cedilla characters.
mapNames("Gcommaaccent gcommaaccent Kcommaaccent kcommaaccent Lcommaaccent lcommaaccent Ncommaaccent ncommaaccent Rcommaaccent rcommaaccent Tcommaaccent tcommaaccent", "ĢģĶķĻļŅņŖŗŢţ");
function unicode(name) {
  if (names[name] !== undefined) return names[name];
  for (const [suffix, accent] of Object.entries(accents)) {
    if (name.length === suffix.length + 1 && name.endsWith(suffix)) {
      const composed = (name[0] + accent).normalize("NFC");
      if ([...composed].length === 1) return composed.codePointAt(0);
    }
  }
  return undefined;
}

const greek = {};
const greekNames = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega".split(" ");
greekNames.forEach((name, index) => {
  greek[name] = [..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"][index].codePointAt(0);
  greek[name.toLowerCase()] = [..."αβγδεζηθικλμνξοπρστυφχψω"][index].codePointAt(0);
});
Object.assign(greek, { theta1: 0x03d1, phi1: 0x03d5, sigma1: 0x03c2, omega1: 0x03d6, Upsilon1: 0x03d2,
  arrowboth: 0x2194, arrowleft: 0x2190, arrowup: 0x2191, arrowright: 0x2192, arrowdown: 0x2193,
  arrowdblboth: 0x21d4, arrowdblleft: 0x21d0, arrowdblup: 0x21d1, arrowdblright: 0x21d2, arrowdbldown: 0x21d3,
  carriagereturn: 0x21b5 });

const copyrightLines = new Set();
function readAfm(face) {
  const source = readFileSync(join(directory, `${face}.afm`), "utf8");
  const copyright = source.match(/^Comment Copyright.*$/m)?.[0];
  if (!copyright) throw new Error(`Missing copyright in ${face}`);
  copyrightLines.add(copyright);
  return new Map([...source.matchAll(/^C .*?; WX ([\d.]+) ; N (\S+) ;/gm)].map((match) => [match[2], Number(match[1]) / 1000]));
}
function verifyOblique(upright, oblique) {
  if (upright.size !== oblique.size || [...upright].some(([name, width]) => oblique.get(name) !== width)) {
    throw new Error("Oblique advance widths differ from upright widths");
  }
}
const regular = readAfm("Helvetica"), bold = readAfm("Helvetica-Bold");
verifyOblique(regular, readAfm("Helvetica-Oblique"));
verifyOblique(bold, readAfm("Helvetica-BoldOblique"));
const symbol = readAfm("Symbol");
function widths(metrics) {
  const result = {};
  for (const [name, width] of metrics) {
    const codePoint = unicode(name);
    if (codePoint === undefined) throw new Error(`Unmapped ExtendedRoman glyph: ${name}`);
    result[codePoint] = width;
  }
  for (const [name, codePoint] of Object.entries(greek)) {
    if (!symbol.has(name)) throw new Error(`Missing Symbol glyph: ${name}`);
    result[codePoint] = symbol.get(name);
  }
  return result;
}
const license = readFileSync(join(directory, "readme.txt"), "utf8").match(/This file and the 14 PostScript\(R\) AFM files[\s\S]*?to support the use of the AFM files\./)?.[0];
if (!license) throw new Error("Missing Adobe licence paragraph");
const header = `/*\n${[...copyrightLines].join("\n")}\n\n${license}\n\nModified: reduced to advance widths per Unicode code point by scripts/generate-text-metrics.mjs.\nGenerated file; do not edit.\n*/\n`;
const output = header + `\nexport const helveticaAdvances: Readonly<Record<number, number>> = ${JSON.stringify(widths(regular), null, 2)};\n\nexport const helveticaBoldAdvances: Readonly<Record<number, number>> = ${JSON.stringify(widths(bold), null, 2)};\n`;
writeFileSync(new URL("../src/textMetrics.generated.ts", import.meta.url), output);
