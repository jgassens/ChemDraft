// Parse feeds as XML, retaining raw item text so published signatures/entries never get rewritten.
import { JSDOM } from "jsdom";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { targetArchitecture } from "./macos-mach-o.mjs";

const SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
export const NOTES_PREFIX = "https://raw.githubusercontent.com/jgassens/ChemDraft/main/";

export function appcastConfiguration(target) {
  const architecture = targetArchitecture(target);
  return {
    architecture,
    filename: architecture === "arm64" ? "appcast.xml" : "appcast-intel.xml",
    notesDirectory: architecture === "arm64" ? "release-notes/macos" : "release-notes/macos-intel"
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
      const enclosures = [...element.getElementsByTagName("enclosure")];
      if (!sparkle("version") || enclosures.length !== 1) throw new Error("Each appcast item needs a version and exactly one DMG enclosure (no deltas)");
      const enclosure = enclosures[0];
      return {
        raw: raw[index], version: sparkle("version"), url: enclosure.getAttribute("url"),
        length: enclosure.getAttribute("length"), edSignature: enclosure.getAttributeNS(SPARKLE, "edSignature"),
        notes: sparkle("releaseNotesLink"), hardware: sparkle("hardwareRequirements")
      };
    });
  } finally { dom.window.close(); }
}

export function loadSparklePublicKey(plist = new URL("../../apps/desktop/src-tauri/Info.plist", import.meta.url)) {
  // JSDOM does not load external resources; the plist's standard DOCTYPE stays offline.
  const dom = new JSDOM(readFileSync(plist, "utf8"), { contentType: "application/xml" });
  try {
    const entries = [...dom.window.document.querySelectorAll("plist > dict > key")]
      .filter((key) => key.textContent.trim() === "SUPublicEDKey");
    const value = entries[0]?.nextElementSibling;
    if (entries.length !== 1 || value?.tagName !== "string" || !value.textContent.trim()) {
      throw new Error("Info.plist: SUPublicEDKey: expected exactly one nonempty public key string");
    }
    return value.textContent.trim();
  } finally { dom.window.close(); }
}

export function verifyDmgEnclosure(item, bytes, encodedPublicKey = loadSparklePublicKey()) {
  const label = `Appcast item ${item.version} (${item.url})`;
  if (!/^\d+$/.test(item.length ?? "") || BigInt(item.length) !== BigInt(bytes.length)) {
    throw new Error(`${label}: length: expected ${bytes.length}, found ${item.length ?? "missing"}`);
  }
  const key = Buffer.from(encodedPublicKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedPublicKey) {
    throw new Error("Info.plist: SUPublicEDKey: expected a base64 raw 32-byte Ed25519 public key");
  }
  // RFC 8410 SubjectPublicKeyInfo wrapper around Sparkle's raw Ed25519 key.
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
    format: "der", type: "spki"
  });
  const signature = Buffer.from(item.edSignature ?? "", "base64");
  if (signature.length !== 64 || signature.toString("base64") !== item.edSignature ||
      !verify(null, bytes, publicKey, signature)) {
    throw new Error(`${label}: sparkle:edSignature: expected a valid Ed25519 signature over the DMG bytes using SUPublicEDKey, found ${item.edSignature ?? "missing"}`);
  }
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
