import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeLabelBoxes, measureLabelBox, wrapLabelText } from '../shared/text-layout.ts';
import { easeMotion } from '../shared/playback.ts';
import { labelMotionOffset, planLabelMotion } from '../src/label-motion.ts';

test('assembly note capture preserves explicit instructions and wraps at available width', () => {
  const instruction = 'ALIGN GUIDE RAIL\nTIGHTEN UNTIL FLUSH';
  assert.deepEqual(wrapLabelText(instruction, 24, value => value.length), ['ALIGN GUIDE RAIL', 'TIGHTEN UNTIL FLUSH']);
  assert.deepEqual(wrapLabelText(instruction, 18, value => value.length), ['ALIGN GUIDE RAIL', 'TIGHTEN UNTIL', 'FLUSH']);
  assert.deepEqual(wrapLabelText('First\n\nSecond\n', 20, value => value.length), ['First', '', 'Second']);
});

test('long labels wrap without compressed text or discarded characters', () => {
  assert.deepEqual(wrapLabelText('拧紧固定支架螺栓', 4, value => [...value].length), ['拧紧固定', '支架螺栓']);
  assert.equal(wrapLabelText('Access cover support bracket', 14, value => value.length).join(' '), 'Access cover support bracket');
});

test('capture boxes include complete adhesive and part names despite fractional font widths', () => {
  const measure = (value: string): number => value.length * 10.73, insets = { left: 8, right: 8, top: 5, bottom: 5 };
  for (const text of ['FAST ADHESIVE', 'Front Case', 'lower housing support plate']) {
    const box = measureLabelBox(text, 420, 28.35, insets, measure);
    assert.deepEqual(box.lines, [text]); assert.ok(box.width - 16 >= measure(text)); assert.ok(box.height >= 38.35);
  }
  const box = measureLabelBox('ALIGN GUIDE RAIL\nTIGHTEN UNTIL FLUSH', 235, 28.35, insets, measure);
  assert.equal(box.lines.join(' '), 'ALIGN GUIDE RAIL TIGHTEN UNTIL FLUSH'); assert.ok(box.height >= box.lines.length * 28.35 + 10);
});

test('capture-only label layout resolves the mount instruction overlap without mutating authored positions', () => {
  const labels = [
    { id: 'instruction', x: 430, y: 600, width: 320, height: 70, anchorX: 660, anchorY: 565 },
    { id: 'mount', x: 515, y: 655, width: 270, height: 38, anchorX: 660, anchorY: 550 },
    { id: 'front-shell', x: 420, y: 620, width: 330, height: 38, anchorX: 585, anchorY: 515 },
  ];
  const original = structuredClone(labels), result = arrangeLabelBoxes(labels, 1600, 938);
  assert.deepEqual(labels, original); assert.deepEqual(result[0], original[0]);
  for (const a of result) {
    assert.ok(a.x >= 12 && a.y >= 12 && a.x + a.width <= 1588 && a.y + a.height <= 926);
    for (const b of result) if (a !== b) assert.ok(a.x >= b.x + b.width + 12 || a.x + a.width + 12 <= b.x || a.y >= b.y + b.height + 12 || a.y + a.height + 12 <= b.y);
  }
  const obstructed = arrangeLabelBoxes(labels, 1600, 938, [{ x: 400, y: 580, width: 400, height: 180 }]);
  for (const box of obstructed) assert.ok(box.x >= 812 || box.x + box.width + 12 <= 400 || box.y >= 772 || box.y + box.height + 12 <= 580);
});

test('a large detour starts settling before the last six video frames', () => {
  const positions = (progress: number) => {
    const x = 555 + 250 * easeMotion(progress);
    return [
      { id: 'instruction', x: 430, y: 315, width: 350, height: 270, anchorX: 640, anchorY: 490 },
      { id: 'gauge', x, y: 432, width: 112, height: 36, anchorX: x - 20, anchorY: 462 },
    ];
  };
  const track = planLabelMotion(1.6, 1600, 938, positions).get('gauge');
  assert.ok(track);
  const offsets = Array.from({ length: 49 }, (_, index) => labelMotionOffset(track, index / 48));
  assert.ok(Math.max(...offsets.map(([dx, dy]) => Math.hypot(dx, dy))) > 185);
  assert.deepEqual(offsets.at(-1), [0, 0]);
  let tailTravel = 0;
  offsets.forEach(([dx, dy], index) => {
    const [note, label] = positions(index / 48), x = label.x + dx, y = label.y + dy;
    assert.ok(x >= note.x + note.width || x + label.width <= note.x || y >= note.y + note.height || y + label.height <= note.y);
    if (index > 42) tailTravel += Math.hypot(dx - offsets[index - 1][0], dy - offsets[index - 1][1]);
  });
  assert.ok(tailTravel < 55, `Final six frames should not contain the full return from the detour. Travel: ${tailTravel}px.`);
  const still = planLabelMotion(1.6, 1600, 938, () => positions(0)).get('gauge');
  assert.deepEqual(labelMotionOffset(still, .5), labelMotionOffset(still, 0));
});
