// Parse feeds as XML, retaining raw item text so published signatures/entries never get rewritten.
import { JSDOM } from "jsdom";
import { targetArchitecture } from "./macos-mach-o.mjs";
import { feedForTarget } from "./verify-macos-app.mjs";

const SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
export const NOTES_PREFIX = "https://raw.githubusercontent.com/jgassens/ChemDraft/main/";

export function appcastConfiguration(target) {
  const architecture = targetArchitecture(target);
  return {
    architecture,
    filename: architecture === "arm64" ? "appcast.xml" : "appcast-intel.xml",
    notesDirectory: architecture === "arm64" ? "release-notes/macos" : "release-notes/macos-intel",
    feedURL: feedForTarget(target)
  };
}

export function targetForFeed(filename) {
  if (filename === "appcast.xml") return "aarch64-apple-darwin";
  if (filename === "appcast-intel.xml") return "x86_64-apple-darwin";
  throw new Error(`Unknown macOS feed: ${filename}`);
}

export function emptyAppcast(target) {
  const { architecture } = appcastConfiguration(target);
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<rss xmlns:sparkle="${SPARKLE}" version="2.0">
    <channel>
        <title>ChemDraft Updates${architecture === "x86_64" ? " (Intel)" : ""}</title>
        <link>https://github.com/jgassens/ChemDraft</link>
        <description>Signed ChemDraft updates for macOS${architecture === "x86_64" ? " Intel" : ""}.</description>
        <language>en</language>
    </channel>
</rss>
`;
}

export function parseAppcast(xml) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("Appcasts must not contain a DOCTYPE");
  const dom = new JSDOM(xml, { contentType: "application/xml" });
  try {
    const document = dom.window.document;
    const channel = document.documentElement.children[0];
    if (document.documentElement.tagName !== "rss" || document.documentElement.getAttribute("version") !== "2.0" ||
        document.documentElement.children.length !== 1 || channel?.tagName !== "channel") throw new Error("Expected an RSS 2.0 channel");
    const elements = [...channel.children].filter((element) => element.tagName === "item");
    const raw = [...xml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item\s*>/g)].map((match) => match[0]);
    if (raw.length !== elements.length) throw new Error("Unsupported appcast item layout");
    return elements.map((element, index) => {
      const sparkle = (name) => element.getElementsByTagNameNS(SPARKLE, name)[0]?.textContent.trim();
      const enclosures = [...element.getElementsByTagName("enclosure")].map((entry) => entry.getAttribute("url"));
      if (!sparkle("version") || enclosures.length !== 1) throw new Error("Each appcast item needs a version and exactly one DMG enclosure (no deltas)");
      return { raw: raw[index], version: sparkle("version"), url: enclosures[0], notes: sparkle("releaseNotesLink"), hardware: sparkle("hardwareRequirements") };
    });
  } finally { dom.window.close(); }
}

export function dmgArchitecture(url) {
  const name = decodeURIComponent(new URL(url, "https://local.invalid/").pathname);
  if (/_(?:aarch64|arm64)\.dmg$/.test(name)) return "arm64";
  if (/_(?:x86_64|x64)\.dmg$/.test(name)) return "x86_64";
  throw new Error(`DMG has no recognized architecture suffix: ${url}`);
}

export function verifyAppcast(xml, target) {
  const { architecture, notesDirectory } = appcastConfiguration(target);
  const items = parseAppcast(xml);
  const versions = new Set();
  for (const item of items) {
    if (versions.has(item.version)) throw new Error(`Duplicate feed version: ${item.version}`);
    versions.add(item.version);
    if (dmgArchitecture(item.url) !== architecture) throw new Error(`${item.url}: feed requires ${architecture} DMGs`);
    if (item.hardware && item.hardware !== architecture) throw new Error(`${item.version}: wrong hardware requirements for ${architecture}`);
    const notesRoot = `${NOTES_PREFIX}${notesDirectory}/`;
    if (!item.notes?.startsWith(notesRoot) || !/^[^/]+\.md$/.test(item.notes.slice(notesRoot.length))) throw new Error(`${item.version}: release notes must come from ${notesDirectory}/`);
  }
  return items;
}
