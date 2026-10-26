import { describe, expect, it } from 'vitest';
import { applyPatches, deserializeDocument, serializeDocument, type ChemDraftDocument, type GraphicObject } from '@chemdraft/chem-core';
import { attachReactionArrowOffshoot, reactionConditionsDraft, setReactionArrowConditions } from '@chemdraft/document-workflow-core';
import { arrowAttachmentFrame, nearestArrowObjectAtPoint } from '@chemdraft/layout-engine';
import { graphicPathEditPoints, quadraticArrowGeometry } from '@chemdraft/art-engine';
import { exportDocumentToSvg } from '@chemdraft/export-engine';
import { changeConditionsText } from '../../apps/desktop/src/dialogs/ReactionConditionsForm';
import { createNativeArtLineGraphicObject, createPhase4Document, setDocumentCustomPageSize, normalizeCommittedDocument,
  rotateDocumentObjectsAroundPoint, scaleDocumentObjectsAroundPoint, moveDocumentObjects,
  selectDocumentObjects, duplicateSelectedDocumentObjects, createSelectionClipboardPayload,
  pasteSelectionClipboardPayload, deleteSelectedDocumentObjects } from '../../apps/desktop/src/documentWorkflow';

function tree(depth = 7) {
  let d = setDocumentCustomPageSize(createPhase4Document('Adversarial arrow tree'), { width: 12000, height: 12000, unit: 'css-px' });
  const root = createNativeArtLineGraphicObject(d, { x: 5000, y: 6000 }, { x: 5800, y: 6000 }, 'tool.art.reactionArrow')!;
  const curved = quadraticArrowGeometry(root, { x: 5000, y: 6000 }, { x: 5800, y: 6000 }, { x: 5400, y: 5700 });
  d = applyPatches(d, [{ op: 'addObject', pageId: d.pages[0].id, object: curved }]);
  let parent = root.id;
  for (let i = 0; i < depth; i++) {
    d = attachReactionArrowOffshoot(d, parent, i % 2 ? 'below' : 'above', i % 3 ? 'fullCurve' : undefined);
    parent = d.pages[0].objects.at(-1)!.id;
  }
  d = setReactionArrowConditions(d, parent, { side: 'above', spans: [
    { text: 'H', script: 'normal' }, { text: '2', script: 'subscript' },
    { text: 'O\nZn', script: 'normal' }, { text: '2+', script: 'superscript' },
    { text: '\n\n80 °C, μmol', script: 'normal' }
  ] });
  return { d: normalizeCommittedDocument(d), root: root.id, leaf: parent };
}
function assertTree(d: ChemDraftDocument) {
  for (const object of d.pages[0].objects) {
    expect([object.x, object.y, object.width, object.height, object.rotation].every(Number.isFinite)).toBe(true);
    const a = object.arrowAttachment;
    if (a?.kind !== 'offshoot') continue;
    const parent = d.pages[0].objects.find(o => o.id === a.parentObjectId)!;
    const frame = arrowAttachmentFrame(d.pages[0], parent, a.tetherFraction ?? .5)!;
    const points = graphicPathEditPoints(object as GraphicObject)!;
    const junction = a.mode === 'fullCurve' ? points.middle : points.start;
    expect(junction.x).toBeCloseTo(frame.origin.x, 5);
    expect(junction.y).toBeCloseTo(frame.origin.y, 5);
  }
}

describe('independent adversarial reaction arrows', () => {
  it.each([[.02, 20, 89.9], [15, .03, 179.9], [.1, .1, 1080], [3, 2, -719.5]])(
    'settles nested full/half trees at scale %s/%s and rotation %s', (sx, sy, angle) => {
      const source = tree();
      let d = rotateDocumentObjectsAroundPoint(source.d, [source.root], { x: 5400, y: 6000 }, angle);
      d = scaleDocumentObjectsAroundPoint(d, [source.root], { x: 5400, y: 6000 }, sx, sy);
      d = normalizeCommittedDocument(d);
      assertTree(d);
      expect(normalizeCommittedDocument(d).pages[0].objects).toEqual(d.pages[0].objects);
      const reopened = normalizeCommittedDocument(deserializeDocument(serializeDocument(d)));
      expect(reopened.pages[0].objects).toEqual(d.pages[0].objects);
      expect(exportDocumentToSvg(reopened).contents).toBe(exportDocumentToSvg(d).contents);
      expect(reactionConditionsDraft(reopened, source.leaf)).toEqual(reactionConditionsDraft(source.d, source.leaf));
    }
  );

  it('is independent of ancestor/label stacking order after a transform', () => {
    const source = tree(10);
    const transformed = rotateDocumentObjectsAroundPoint(source.d, [source.root], { x: 5400, y: 6000 }, 133);
    const canonical = normalizeCommittedDocument(transformed);
    const reversed = normalizeCommittedDocument({ ...transformed, pages: [{ ...transformed.pages[0], objects: [...transformed.pages[0].objects].reverse() }] });
    const sorted = (d: ChemDraftDocument) => [...d.pages[0].objects].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(reversed)).toEqual(sorted(canonical));
    assertTree(reversed);
    expect(normalizeCommittedDocument(reversed).pages[0].objects).toEqual(reversed.pages[0].objects);
  });

  it('copies a deep tree repeatedly without foreign attachment IDs or changes to originals', () => {
    const source = tree(12);
    const d = selectDocumentObjects(source.d, source.d.pages[0].id, [source.root]);
    const original = d.pages[0].objects;
    const originalIds = new Set(original.map(o => o.id));
    const payload = createSelectionClipboardPayload(d)!;
    for (const copy of [duplicateSelectedDocumentObjects(d), pasteSelectionClipboardPayload(d, payload, { x: 8000, y: 8000 })]) {
      const next = normalizeCommittedDocument(copy);
      const clones = next.pages[0].objects.filter(o => !originalIds.has(o.id));
      const ids = new Set(clones.map(o => o.id));
      expect(clones).toHaveLength(original.length);
      expect(clones.every(o => !o.arrowAttachment || ids.has(o.arrowAttachment.parentObjectId))).toBe(true);
      expect(next.pages[0].objects.filter(o => originalIds.has(o.id))).toEqual(original);
      assertTree(next);
    }
    expect(deleteSelectedDocumentObjects(d).pages[0].objects).toHaveLength(0);
  });

  it('does not confuse two nearly overlapping shaft targets', () => {
    const source = tree(0);
    const root = source.d.pages[0].objects[0] as GraphicObject;
    const parallel = { ...root, id: 'parallel', ...quadraticArrowGeometry(root, { x: 5000, y: 6002 }, { x: 5800, y: 6002 }, { x: 5400, y: 5702 }) };
    parallel.id = 'parallel';
    const d = applyPatches(source.d, [{ op: 'addObject', pageId: source.d.pages[0].id, object: parallel }]);
    for (const arrow of [root, parallel]) {
      const point = graphicPathEditPoints(arrow)!.middle;
      expect(nearestArrowObjectAtPoint(d.pages[0], point, 8)?.id).toBe(arrow.id);
    }
  });

  it('preserves manual label placement through repeated formatted replacements and reopen', () => {
    const source = tree(3);
    let d = source.d;
    const label = d.pages[0].objects.find(o => o.type === 'text')!;
    d = normalizeCommittedDocument(moveDocumentObjects(d, [label.id], 233, -177));
    const before = d.pages[0].objects.find(o => o.id === label.id)!;
    for (let i = 0; i < 10; i++) {
      d = setReactionArrowConditions(d, source.leaf, { side: 'above', spans: [
        { text: 'AA', script: i % 2 ? 'subscript' : 'superscript' }, { text: 'AA\nAA', script: 'normal' }
      ] });
      d = normalizeCommittedDocument(deserializeDocument(serializeDocument(d)));
      const after = d.pages[0].objects.find(o => o.id === label.id)!;
      expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 5);
      expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 5);
    }
  });

  it('keeps every surviving script when replacing each range in repeated text', () => {
    const old = 'AAAAAAAA';
    const scripts = ['normal', 'subscript', 'superscript'] as const;
    const draft = { side: 'above' as const, spans: [...old].map((text, i) => ({ text, script: scripts[i % 3] })) };
    for (let start = 0; start <= old.length; start++) for (let end = start; end <= old.length; end++) {
      const text = old.slice(0, start) + 'AA' + old.slice(end);
      const changed = changeConditionsText(draft, text, 'normal', { start, end });
      const chars = changed.spans.flatMap(s => [...s.text].map(text => ({ text, script: s.script })));
      expect(chars).toEqual([...draft.spans.slice(0, start), { text: 'A', script: 'normal' }, { text: 'A', script: 'normal' }, ...draft.spans.slice(end)]);
    }
  });
});
