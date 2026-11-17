import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../shared/document.ts';
import { playbackCard, playbackDuration, playbackFrame, playbackPlan, resumeAfterTitle } from '../shared/playback.ts';
import type { AssemblyStep, Keyframe, Model } from '../shared/types.ts';

function fixture() {
  const model: Model = { id: 'model', name: 'Model', sourceFile: 'Model.3mf', revision: 1, importedAt: '', parts: [], materials: [] };
  const project = emptyProject(model); project.settings.title = 'Head Assembly';
  project.steps = Array.from({ length: 3 }, (_, index): AssemblyStep => {
    const from: Keyframe = { id: `start-${index}`, kind: 'start', name: 'Start', duration: 2, poses: { support: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } }, hidden: [], notes: [] };
    const to: Keyframe = { ...from, id: `end-${index}`, kind: 'end', name: 'End', poses: { support: { position: [0, 0, 10], quaternion: [0, 0, 0, 1] } }, hidden: ['support'] };
    return { id: `step-${index}`, name: `Step ${index + 1}`, partIds: ['support'], groups: [], removePartIds: ['support'], frames: [from, to], final: false, description: '' };
  }); return project;
}

test('global playback places Bambu title cards before steps and holds every completed assembly', () => {
  const project = fixture(), snapshot = structuredClone(project), plan = playbackPlan(project);
  assert.deepEqual(plan.map(segment => segment.kind), ['cover', 'title', 'motion', 'hold', 'title', 'motion', 'hold', 'title', 'motion', 'hold']);
  assert.equal(plan.reduce((sum, segment) => sum + playbackDuration(segment), 0), 18.5);
  assert.equal(plan.reduce((sum, segment) => sum + playbackDuration(segment, 2), 0), 12.5, 'Playback speed scales transitions and holds while title timings stay fixed.');
  assert.deepEqual(playbackCard(project, plan[0]), { title: 'Head Assembly', subtitle: '---- Assembly Guide' });
  assert.deepEqual(playbackCard(project, plan[4]), { title: 'Step 2' });
  assert.equal(playbackCard(project, plan[2]), undefined);
  for (const segment of plan.filter(segment => segment.kind === 'motion')) { assert.deepEqual(playbackFrame(segment, 0), segment.from); assert.deepEqual(playbackFrame(segment, 1), segment.to); }
  for (const segment of plan.filter(segment => segment.kind === 'hold')) assert.deepEqual(playbackFrame(segment, .5).hidden, ['support']);
  assert.deepEqual(project, snapshot, 'Building and sampling playback must leave authored data intact.');
});

test('local playback omits global cards and pausing titles lands on the announced assembly', () => {
  const project = fixture(), local = playbackPlan(project, project.steps[1].id), global = playbackPlan(project);
  assert.deepEqual(local.map(segment => segment.kind), ['motion', 'hold']); assert.equal(local.reduce((sum, segment) => sum + segment.duration, 0), 4);
  assert.equal(resumeAfterTitle(global, 0), 2); assert.equal(resumeAfterTitle(global, 4), 5); assert.equal(resumeAfterTitle(global, 5), 5);
  assert.equal(global[resumeAfterTitle(global, 4)].step.id, project.steps[1].id);
});

test('empty steps play only their title and do not create phantom transition or hold time', () => {
  const project = fixture(); project.steps[1].partIds = [];
  const plan = playbackPlan(project), emptySegments = plan.filter(segment => segment.step.id === project.steps[1].id);
  assert.deepEqual(emptySegments.map(segment => segment.kind), ['title']); assert.equal(plan.reduce((sum, segment) => sum + segment.duration, 0), 14.5);
  assert.deepEqual(playbackPlan(project, project.steps[1].id), []);
});
