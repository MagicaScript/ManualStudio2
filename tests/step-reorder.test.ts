import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, copy, emptyProject } from '../shared/document.ts';
import { stepReorderChanges } from '../shared/step-order.ts';
import type { Model } from '../shared/types.ts';

test('reordering a step back to its own card or adjacent original gaps is a no-op', () => {
  const model: Model = { id: 'model', name: 'Model', sourceFile: 'Model.3mf', revision: 1, importedAt: '', parts: [], materials: [] };
  const project = emptyProject(model);
  for (let index = 1; index <= 4; index++) applyCommand(project, { type: 'step.add', name: `Operation ${index}` });
  const order = project.steps.map(step => step.id), original = copy(project), originalArray = project.steps;
  for (const before of [order[3], undefined]) {
    assert.equal(stepReorderChanges(order, order[3], before), false);
    applyCommand(project, { type: 'step.reorder', stepId: order[3], before });
    assert.strictEqual(project.steps, originalArray);
    assert.deepEqual(project, original);
  }
  applyCommand(project, { type: 'step.reorder', stepId: order[1], before: order[2] });
  assert.strictEqual(project.steps, originalArray);
  assert.throws(() => applyCommand(project, { type: 'step.reorder', stepId: order[3], before: 'missing' }), /Unknown step/);
  assert.deepEqual(project, original, 'An invalid insertion target must not remove the dragged step.');
  applyCommand(project, { type: 'step.reorder', stepId: order[3], before: order[0] });
  assert.deepEqual(project.steps.map(step => step.id), [order[3], ...order.slice(0, 3)]);
  assert.deepEqual(project.steps[0], original.steps[3]);
});
