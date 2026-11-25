import { posix } from 'node:path';

const ns = 'http://schemas.openxmlformats.org';
const office = `${ns}/officeDocument/2006/relationships`;
const strictOffice = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const rels = `${ns}/package/2006/relationships`;
const a = `${ns}/drawingml/2006/main`;
const p = `${ns}/presentationml/2006/main`;
const w = `${ns}/wordprocessingml/2006/main`;
const v = 'urn:schemas-microsoft-com:vml';
const o = 'urn:schemas-microsoft-com:office:office';
const mc = `${ns}/markup-compatibility/2006`;
const slidePart = /^ppt\/slides\/[^/]+\.xml$/;

function xmlText(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&([^&;]*);|&/g, (_, key) => {
    if (Object.hasOwn(entities, key)) return entities[key];
    if (/^#(?:x[\da-fA-F]+|\d+)$/.test(key)) {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    throw new Error('Invalid XML entity');
  });
}

const xmlName = '[\\p{L}_][\\p{L}\\p{N}\\p{M}_.-]*';
const qName = `${xmlName}(?::${xmlName})?`;
const xmlAttribute = `\\s+(${qName})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`;
const xmlTag = `<(${qName})((?:${xmlAttribute})*)\\s*(/?)>`;
const splitName = name => name.includes(':') ? name.split(':') : ['', name];

// The probe only needs element and attribute names and values. Reject DTDs and
// bound the tree so the standalone Node script can inspect an untrusted package.
function parseXml(bytes, part) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const token = new RegExp(`<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|</(${qName})\\s*>|${xmlTag}`, 'uy');
  const attributes = new RegExp(xmlAttribute, 'gu');
  let root, parent, depth = 0, count = 0;
  const invalid = () => new Error(`Invalid or unsupported XML in ${part}`);
  for (let offset = 0; offset < xml.length;) {
    const start = xml.indexOf('<', offset);
    if (!parent && xml.slice(offset, start < 0 ? xml.length : start).trim()) throw invalid();
    if (start < 0) break;
    token.lastIndex = start;
    const match = token.exec(xml);
    if (!match) throw invalid();
    offset = token.lastIndex;
    const [, closing, name, attributeText, , , , selfClosing] = match;
    if (closing) {
      if (parent?.name !== closing) throw invalid();
      parent = parent.parent;
      depth--;
      continue;
    }
    if (!name) continue;
    if ((!parent && root) || depth >= 256 || ++count > 200_000) throw invalid();
    const bindings = Object.create(parent?.bindings ?? null);
    const attrs = new Map();
    for (const [, key, double, single] of attributeText.matchAll(attributes)) {
      if (attrs.has(key)) throw invalid();
      const value = xmlText(double ?? single);
      if (key === 'xmlns') bindings[''] = value;
      else if (key.startsWith('xmlns:')) bindings[key.slice(6)] = value;
      attrs.set(key, value);
    }
    const [prefix, local] = splitName(name);
    if (prefix && !bindings[prefix]) throw invalid();
    const node = { name, local, ns: bindings[prefix] ?? '', bindings, attrs, parent, children: [] };
    if (parent) parent.children.push(node);
    else root = node;
    if (!selfClosing) {
      parent = node;
      depth++;
    }
  }
  if (!root || parent) throw invalid();
  return root;
}

function is(node, namespace, local) {
  return node?.ns === namespace && node.local === local;
}

function attribute(node, namespace, local) {
  for (const [key, value] of node.attrs) {
    const [prefix, name] = splitName(key);
    if (name === local && prefix && node.bindings[prefix] === namespace) return value;
  }
}

const relationshipId = (node, name = 'id') => attribute(node, office, name) ?? attribute(node, strictOffice, name);

function* elements(node) {
  yield node;
  for (const child of node.children) yield* elements(child);
}

function ancestor(node, namespace, local) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (is(parent, namespace, local)) return parent;
  }
}

function branchNodes(node) {
  const branches = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (is(parent.parent, mc, 'AlternateContent') && (is(parent, mc, 'Choice') || is(parent, mc, 'Fallback'))) {
      branches.unshift(parent);
    }
  }
  return branches;
}

function reportBranches(node) {
  return branchNodes(node).map(branch => branch.local === 'Choice'
    ? { kind: 'choice', requires: (branch.attrs.get('Requires') ?? '').split(/\s+/).filter(Boolean) }
    : { kind: 'fallback' });
}

function compatibleBranches(first, second) {
  const firstBranches = branchNodes(first);
  return !branchNodes(second).some(branch =>
    firstBranches.some(other => other.parent === branch.parent && other !== branch));
}

function relatedParts(parts) {
  const bySource = new Map(), objects = new Map(), images = new Map();
  for (const [name, bytes] of parts) {
    const relation = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
    if (!relation) continue;
    const part = (relation[1] ?? '') + relation[2];
    const root = parseXml(bytes, name);
    if (!is(root, rels, 'Relationships')) continue;
    const byId = new Map();
    const seenIds = new Set();
    bySource.set(part, byId);
    for (const child of root.children.filter(node => is(node, rels, 'Relationship'))) {
      const id = child.attrs.get('Id');
      if (!id) continue;
      if (seenIds.has(id)) throw new Error(`Duplicate relationship ID ${id} in ${name}`);
      seenIds.add(id);
      const type = child.attrs.get('Type') ?? '';
      const kind = type.slice(type.lastIndexOf('/') + 1);
      const uri = child.attrs.get('Target');
      if (!uri || child.attrs.get('TargetMode') === 'External' ||
          (type !== `${office}/${kind}` && type !== `${strictOffice}/${kind}`) ||
          !['oleObject', 'image', 'vmlDrawing'].includes(kind)) continue;
      const path = decodeURIComponent(uri.split('#')[0]);
      if (!path || /^[\w+.-]+:/.test(path) || path.startsWith('//')) continue;
      const target = path.startsWith('/') ? posix.normalize(path).slice(1) : posix.join(posix.dirname(part), path);
      byId.set(id, { kind, target });
      const inventory = kind === 'oleObject' ? objects : kind === 'image' ? images : null;
      if (!inventory) continue;
      if (!inventory.has(target)) inventory.set(target, []);
      inventory.get(target).push({ part, id });
    }
  }
  return { bySource, objects, images };
}

function pictureBlips(picture) {
  return picture.children.filter(node => is(node, p, 'blipFill'))
    .flatMap(fill => fill.children.filter(node => is(node, a, 'blip')));
}

function* shapeImages(node, shapeId) {
  for (const child of elements(node)) {
    if (!is(child, v, 'imagedata')) continue;
    const shape = ancestor(child, v, 'shape');
    if (shape && (!shapeId || shape.attrs.get('id') === shapeId || attribute(shape, o, 'spid') === shapeId)) {
      yield child;
    }
  }
}

export function inspectOleMarkup(parts) {
  const { bySource, objects, images } = relatedParts(parts);
  const embeddings = [];
  const imageUses = new Set(), inspectedSources = new Set();
  const drawings = new Map();

  function resolve(part, id, kind) {
    const relationship = bySource.get(part)?.get(id);
    const target = relationship?.kind === kind ? relationship.target : null;
    return { part, id: id ?? null, target, exists: target !== null && parts.has(target) };
  }

  function image(part, id, branchSource) {
    const ref = resolve(part, id, 'image');
    if (ref.exists) imageUses.add(ref.target);
    return { ...ref, branches: reportBranches(branchSource) };
  }

  function vmlPreview(part, node, shapeId, drawingIds) {
    const matches = [];
    for (const [id, relationship] of bySource.get(part) ?? []) {
      const { kind, target } = relationship;
      if (kind !== 'vmlDrawing' || (drawingIds.size && !drawingIds.has(id)) || !parts.has(target)) continue;
      if (!drawings.has(target)) drawings.set(target, parseXml(parts.get(target), target));
      for (const picture of shapeImages(drawings.get(target), shapeId)) matches.push({ target, picture });
    }
    // Without an explicit drawing ID, only a unique shape match proves the association.
    if (matches.length !== 1) return [];
    const [{ target, picture }] = matches;
    return [image(target, attribute(picture, o, 'relid') ?? relationshipId(picture), node)];
  }

  for (const [part, bytes] of parts) {
    const isWord = part === 'word/document.xml';
    if (!isWord && !slidePart.test(part)) continue;
    inspectedSources.add(part);
    const root = parseXml(bytes, part);
    if (!(isWord ? is(root, w, 'document') : is(root, p, 'sld'))) continue;

    const drawingIds = new Set();
    const candidates = [];
    const pictureFallbacks = new Map();
    for (const node of elements(root)) {
      if (is(node, v, 'imagedata')) image(part, relationshipId(node) ?? attribute(node, o, 'relid'), node);
      if (is(node, a, 'blip')) image(part, relationshipId(node, 'embed'), node);
      if (is(node, p, 'legacyDrawing') && relationshipId(node)) drawingIds.add(relationshipId(node));
      if (isWord && is(node, o, 'OLEObject') && node.attrs.get('Type') !== 'Link') {
        const container = ancestor(node, w, 'object');
        if (container) candidates.push({ node, container });
      } else if (!isWord && is(node, p, 'oleObj') && !node.children.some(child => is(child, p, 'link'))) {
        candidates.push({ node });
      } else if (!isWord && is(node, p, 'pic') && !ancestor(node, p, 'oleObj')) {
        const branch = branchNodes(node).at(-1);
        if (is(branch, mc, 'Fallback')) {
          const group = branch.parent;
          if (!pictureFallbacks.has(group)) pictureFallbacks.set(group, []);
          pictureFallbacks.get(group).push(node);
        }
      }
    }

    const choiceEmbeddings = new Map();
    const fallbackEmbeddings = new Set();
    for (const { node, container } of candidates) {
      const object = resolve(part, relationshipId(node), 'oleObject');
      let previews;
      if (isWord) {
        previews = [...shapeImages(container, node.attrs.get('ShapeID'))]
          .filter(picture => compatibleBranches(node, picture))
          .map(picture => image(part, relationshipId(picture) ?? attribute(picture, o, 'relid'), picture));
      } else {
        previews = node.children.filter(child => is(child, p, 'pic')).flatMap(pictureBlips)
          .map(blip => image(part, relationshipId(blip, 'embed'), blip));
        const shapeId = node.attrs.get('spid');
        if (shapeId && !previews.length) previews = vmlPreview(part, node, shapeId, drawingIds);
      }
      const embedding = { ...object, live: object.exists, branches: reportBranches(node), previews };
      embeddings.push(embedding);
      if (isWord) continue;
      for (const branch of branchNodes(node)) {
        const group = branch.parent;
        if (is(branch, mc, 'Fallback')) fallbackEmbeddings.add(group);
        if (!embedding.live || !is(branch, mc, 'Choice')) continue;
        if (!choiceEmbeddings.has(group)) choiceEmbeddings.set(group, []);
        choiceEmbeddings.get(group).push({ embedding, branch });
      }
    }

    // A fallback can replace a single OLE frame with a picture outside p:oleObj. Each Choice must
    // hold exactly one frame: two frames in one Choice leave the picture ambiguous even when they
    // share an object part, while mutually exclusive Choices may each describe the one frame.
    for (const [group, pictures] of pictureFallbacks) {
      const choices = choiceEmbeddings.get(group) ?? [];
      const framesPerChoice = new Map();
      for (const { branch } of choices) framesPerChoice.set(branch, (framesPerChoice.get(branch) ?? 0) + 1);
      if (fallbackEmbeddings.has(group) || pictures.length !== 1 ||
          [...framesPerChoice.values()].some(count => count !== 1) ||
          new Set(choices.map(({ embedding }) => embedding.target)).size !== 1) continue;
      const previews = pictureBlips(pictures[0]).map(blip => image(part, relationshipId(blip, 'embed'), blip));
      for (const { embedding } of choices) embedding.previews.push(...previews);
    }
  }

  // Slide VML is in scope even when no matching OLE shape remains after a save.
  for (const [part, relationships] of bySource) {
    if (!slidePart.test(part) || !inspectedSources.has(part)) continue;
    for (const { kind, target } of relationships.values()) {
      if (kind === 'vmlDrawing') inspectedSources.add(target);
    }
  }
  return { objects, images, embeddings, imageUses, inspectedSources };
}
