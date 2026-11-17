import test from 'node:test';
import assert from 'node:assert/strict';
import { nextListPart, rangeSelection } from '../shared/selection.ts';
import { emptyProject, applyCommand } from '../shared/document.ts';
import type { Model } from '../shared/types.ts';

test('Shift selection extends and contracts from the same anchor in visible list order', () => {
  const order = ['A', 'B', 'C', 'D', 'E'];
  assert.deepEqual(rangeSelection(order, 'B', 'E'), ['B', 'C', 'D', 'E']);
  assert.deepEqual(rangeSelection(order, 'B', 'C', ['B', 'C', 'D', 'E']), ['B', 'C']);
  assert.deepEqual(rangeSelection(order, 'D', 'A'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(rangeSelection(['A', 'C', 'E'], 'A', 'E'), ['A', 'C', 'E']);
  assert.deepEqual(rangeSelection(order, 'C', 'E', ['A'], true), ['A', 'C', 'D', 'E']);
});
test('Tab and Shift+Tab advance in visible list order and wrap at its boundaries', () => {
  assert.equal(nextListPart(['A', 'C', 'E'], 'A', 1), 'C');
  assert.equal(nextListPart(['A', 'C', 'E'], 'E', 1), 'A');
  assert.equal(nextListPart(['A', 'C', 'E'], 'A', -1), 'E');
  assert.equal(nextListPart([], 'A', 1), undefined);
});
test('inserting before a step preserves the identities and ordering of the surrounding steps', () => {
  const model: Model = { id: 'model', name: 'Model', sourceFile: 'Model.3mf', revision: 1, importedAt: '', parts: [], materials: [] };
  const project = emptyProject(model); const first = applyCommand(project, { type: 'step.add', name: 'First' })!; const last = applyCommand(project, { type: 'step.add', name: 'Last' })!;
  const middle = applyCommand(project, { type: 'step.add', name: 'Middle', before: last })!;
  assert.deepEqual(project.steps.map(step => step.id), [first, middle, last]);
  assert.equal(project.steps[1].frames[0].kind, 'start'); assert.equal(project.steps[1].frames[1].kind, 'end');
  assert.throws(() => applyCommand(project, { type: 'step.add', before: 'missing' }), /Unknown step/);
});
