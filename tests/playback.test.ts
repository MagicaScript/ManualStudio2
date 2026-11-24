import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../shared/document.ts';
import { continuousBoundary, easeMotion, framePlayback, playbackCard, playbackDuration, playbackFrame, playbackPlan, resumeAfterTitle } from '../shared/playback.ts';
import { renderVideoSlices } from '../shared/render-scope.ts';
import type { AssemblyStep, FrameLabels, Keyframe, Model, Note, Vec3 } from '../shared/types.ts';

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

test('pass-through waypoints match velocities in seconds and stay within the authored positions', () => {
  const project = fixture(), step = project.steps[0];
  const labelSettings: FrameLabels = { showLabels: true, labelMode: 'part', labelOffsets: {}, hiddenLabels: [], labelFontSize: 16 };
  const note: Note = { id: 'guide', kind: 'text', text: 'Align the support', anchors: [], offset: [0, 0], color: '#ffffff', background: '#333333', size: 10 };
  const frame = (kind: Keyframe['kind'], duration: number, position: Vec3, turn: number, offset: number): Keyframe => ({
    id: kind, kind, duration, name: kind, hidden: [],
    poses: { support: { position, quaternion: [0, 0, Math.sin(turn / 2), Math.cos(turn / 2)] } },
    camera: { eye: [position[0], -50, 10], target: [position[0], 0, 0], up: [0, 0, 1], margin: 1.15 },
    notes: [{ ...note, offset: [offset, 20] }], labels: { ...labelSettings, labelOffsets: { support: [-offset, 10] } },
  });
  const start = frame('start', .1, [-20, 0, 0], 0, -80);
  const waypoint = frame('transition', .45, [0, 4, 0], .4, -20);
  const end = frame('end', .11, [8, 6, 0], .9, 0);
  step.frames = [start, waypoint, end];

  const x = (frame: Keyframe) => frame.poses.support.position[0];
  const stopped = framePlayback(project, start.id, step.id);
  assert.equal(x(playbackFrame(stopped, .25)), -20 + 20 * easeMotion(.25));
  assert.ok(Math.abs(x(playbackFrame(stopped, 1 - 1e-6))) < 1e-8);

  waypoint.passThrough = true;
  const [before, after] = playbackPlan(project, step.id);
  assert.ok(continuousBoundary(before, after));
  assert.deepEqual(before, framePlayback(project, start.id, step.id));
  assert.deepEqual(after, framePlayback(project, waypoint.id, step.id));
  assert.deepEqual(playbackFrame(before, 1), waypoint);
  assert.deepEqual(playbackFrame(after, 0), waypoint);
  const slices = renderVideoSlices(project, {});
  for (const slice of slices.filter(slice => slice.segment.kind === 'motion')) {
    assert.equal(slice.end, 1, 'A complete transition ends at the exact waypoint even after prior title cards.');
  }

  const seconds = 1e-6;
  const left = playbackFrame(before, 1 - seconds / before.duration), right = playbackFrame(after, seconds / after.duration);
  const turn = (frame: Keyframe) => 2 * Math.atan2(frame.poses.support.quaternion[2], frame.poses.support.quaternion[3]);
  const channels: [read: (frame: Keyframe) => number, speed: number][] = [
    [x, 20 / .45], [frame => frame.poses.support.position[1], 4 / .45], [turn, .4 / .45],
    [frame => frame.camera!.eye[0], 20 / .45], [frame => frame.camera!.target[0], 20 / .45],
    [frame => frame.notes[0].offset[0], 60 / .45], [frame => frame.labels!.labelOffsets.support[0], -60 / .45],
  ];
  for (const [read, speed] of channels) {
    assert.ok(Math.abs((read(waypoint) - read(left)) / seconds - speed) < .01);
    assert.ok(Math.abs((read(right) - read(waypoint)) / seconds - speed) < .01);
    for (const segment of [before, after]) {
      const lower = Math.min(read(segment.from), read(segment.to)), upper = Math.max(read(segment.from), read(segment.to));
      for (let index = 1; index < 20; index++) {
        const sample = read(playbackFrame(segment, index / 20));
        assert.ok(sample >= lower && sample <= upper);
      }
    }
  }

  step.frames[2] = frame('end', .025, [-.02, 12, 0], .39, -20.01);
  const [approach, turnAway] = playbackPlan(project, step.id);
  assert.ok(Math.abs(x(playbackFrame(approach, 1 - seconds / approach.duration))) < 1e-8);
  assert.ok(Math.abs(x(playbackFrame(turnAway, seconds / turnAway.duration))) < 1e-8);
  for (let index = 0; index <= 20; index++) {
    const sample = playbackFrame(turnAway, index / 20), angle = turn(sample);
    assert.ok(x(sample) >= -.02 && x(sample) <= 0);
    assert.ok(angle >= .39 - 1e-10 && angle <= .4 + 1e-10);
    assert.ok(sample.notes[0].offset[0] >= -20.01 && sample.notes[0].offset[0] <= -20);
  }
});
