import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { applyCommand, emptyProject, makeStep, validateProject } from '../shared/document.ts';
import { prepareFourBar } from '../shared/four-bar.ts';
import { easeMotion, framePlayback, playbackFrame, playbackPlan } from '../shared/playback.ts';
import type { Command, FourBarMotion, MotionTrack, Part, Pose, Vec3 } from '../shared/types.ts';

const pose = (position: Vec3, rotation = new Quaternion()): Pose => ({ position, quaternion: rotation.toArray() });
const vector = (point: Vec3) => new Vector3(...point);
const world = (placement: Pose, point: Vector3) => point.clone().applyQuaternion(new Quaternion(...placement.quaternion)).add(vector(placement.position));
const zAxis = new Vector3(0, 0, 1);
const zRotation = (angle: number) => new Quaternion().setFromAxisAngle(zAxis, angle);
const pivot = { origin: [0, 0, 0], direction: [0, 0, 1] } satisfies { origin: Vec3; direction: Vec3 };
function close(actual: Vector3, expected: Vector3, tolerance = 1e-8): void {
  assert.ok(actual.distanceTo(expected) <= tolerance, `${actual.toArray()} differs from ${expected.toArray()}`);
}

function fixture(poses: Record<string, Pose>) {
  const parts = Object.keys(poses).map((id): Part => ({ id, name: id, sourceName: id, objectName: id, objectId: id, path: id, sourceObject: id,
    geometry: { file: '/models/fixture.bin', offset: 0, vertices: 0, triangles: 0 }, home: pose([0, 0, 0]), bounds: [[-1, -1, -1], [1, 1, 1]],
    color: '#c0c0c0', material: 0, sourceStatus: 'active', initiallyAssembled: false }));
  const project = emptyProject({ id: 'fixture', name: 'Bench linkage', sourceFile: 'fixture.3mf', revision: 1, importedAt: '', parts, materials: ['#c0c0c0'] });
  const step = makeStep(project, 'Cycle the linkage', Object.keys(poses)), [start, end] = step.frames;
  start.poses = structuredClone(poses);
  end.poses = structuredClone(poses);
  project.steps.push(step);
  return { project, step, start, end };
}

test('simultaneous axis rotations and a parallel-link translation follow exact rigid paths', () => {
  const followerOrientation = zRotation(Math.PI / 5);
  const bracketOrientation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const bushingOrientation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .3).multiply(bracketOrientation);
  const { project, step, start, end } = fixture({ cam: pose([10, 0, 0]), stud: pose([10, 2, 0]), lever: pose([34, 6, 0]),
    bracket: pose([30, 6, 0], bracketOrientation), bushing: pose([30, 6, 0], bushingOrientation),
    tie: pose([9, 4, 2], followerOrientation), socket: pose([13, 4, 2], followerOrientation), cover: pose([0, 0, 0]) });
  project.model.constructionAxes = [{ id: 'bracket-pivot', name: 'Bracket pivot', componentPath: 'Bracket', nativeToken: 'bracket-pivot',
    origin: [0, 0, 0], direction: [0, 0, 1], extent: [-5, 5], visible: true, partIds: ['bracket', 'bushing'] }];
  const group = { id: 'drive', name: 'Drive cam', partIds: ['cam', 'stud'], poses: { cam: start.poses.cam, stud: start.poses.stud } };
  step.groups.push(group);
  end.poses.cover = pose([0, 0, 10]);
  const motions: MotionTrack[] = [
    { kind: 'rotate', groupIds: [group.id], axis: pivot, angleDegrees: 90 },
    { kind: 'rotate', partIds: ['lever'], axis: { axisId: 'bracket-pivot' }, angleDegrees: -60 },
    { kind: 'follow-rotation', partIds: ['tie', 'socket'], axis: pivot, angleDegrees: 90, point: [10, 0, 0] },
  ];
  const command = { type: 'frame.motion', stepId: step.id, frameId: end.id, motions } as const;
  applyCommand(project, command);
  assert.deepEqual(validateProject(project), []);
  const segment = framePlayback(project, start.id);
  for (let index = 0; index <= 60; index++) {
    const progress = index / 60, t = easeMotion(progress), frame = playbackFrame(segment, progress);
    const rotation = zRotation(t * Math.PI / 2), position = new Vector3(10, 0, 0).applyQuaternion(rotation);
    const lever = new Vector3(4, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), -t * Math.PI / 3).add(new Vector3(30, 6, 0));
    const shift = position.clone().sub(new Vector3(10, 0, 0));
    close(vector(frame.poses.cam.position), position);
    close(vector(frame.poses.stud.position).sub(position), new Vector3(0, 2, 0).applyQuaternion(rotation));
    close(vector(frame.poses.lever.position), lever);
    close(vector(frame.poses.tie.position), vector(start.poses.tie.position).add(shift));
    close(vector(frame.poses.socket.position), vector(start.poses.socket.position).add(shift));
    assert.ok(Math.abs(new Quaternion(...frame.poses.tie.quaternion).dot(followerOrientation)) > 1 - 1e-12);
    close(vector(frame.poses.cover.position), new Vector3(0, 0, 10 * t));
  }
  assert.throws(() => applyCommand(project, { ...command, motions: [...motions, { kind: 'rotate', partIds: ['stud'], axis: pivot, angleDegrees: 3 }] }), /overlapping motion tracks/);
  const clonedId = applyCommand(project, { type: 'step.copy', stepId: step.id });
  const cloned = project.steps.find(step => step.id === clonedId)!;
  assert.notEqual(cloned.groups[0].id, group.id);
  const clonedTrack = cloned.frames.at(-1)?.incomingMotion?.[0];
  assert.ok(clonedTrack?.kind === 'rotate');
  assert.deepEqual(clonedTrack.groupIds, [cloned.groups[0].id]);
  assert.deepEqual(validateProject(project), []);
  start.poses.bushing.position[0] += 1;
  assert.throws(() => applyCommand(project, command), /multiple placements/);
});

test('a non-parallelogram four-bar closes both rod joints during a forward-and-return sweep', () => {
  const inputJoint = new Vector3(7, 8, 2), outputJoint = new Vector3(20, 7, 5), outputPivot = new Vector3(16, 0, 5);
  const inputLocal = new Vector3(1, 2, .5), outputLocal = new Vector3(0, 1, -.4);
  const bodyAt = (position: Vector3, local: Vector3, rotation: Quaternion) => pose(position.clone().sub(local.clone().applyQuaternion(rotation)).toArray(), rotation);
  const rodPose = pose([12, 10, 7], new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .45));
  const rodLocal = (point: Vector3) => point.clone().sub(vector(rodPose.position)).applyQuaternion(new Quaternion(...rodPose.quaternion).invert());
  const rodInput = rodLocal(inputJoint), rodOutput = rodLocal(outputJoint), reference = inputJoint.clone().add(new Vector3(0, 0, 1.5));
  const { project, step, start, end } = fixture({ crank: bodyAt(inputJoint, inputLocal, zRotation(.37)), rocker: bodyAt(outputJoint, outputLocal, zRotation(-.8)),
    rod: rodPose, 'input-pin': pose(reference.toArray()), 'output-pin': pose(outputJoint.clone().add(new Vector3(0, 0, -2)).toArray()),
    passive: pose([-8, -3, 0]) });
  step.groups.push({ id: 'crank-unit', name: 'Crank and pin', partIds: ['crank', 'input-pin'], poses: { crank: start.poses.crank, 'input-pin': start.poses['input-pin'] } });
  const inputAxis = { origin: [0, 0, 17], direction: [0, 0, -1] } satisfies typeof pivot;
  const outputAxis = { origin: [16, 0, -11], direction: [0, 0, 1] } satisfies typeof pivot;
  const track: FourBarMotion = { kind: 'four-bar', angleDegrees: 0,
    input: { axis: inputAxis, joint: { point: inputLocal.toArray(), partId: 'crank' }, groupIds: ['crank-unit'] },
    output: { axis: outputAxis, joint: { point: outputLocal.toArray(), partId: 'rocker' }, partIds: ['rocker', 'output-pin'] }, coupler: { partIds: ['rod'] } };
  const middle = applyCommand(project, { type: 'frame.add', stepId: step.id, afterId: start.id })!;
  const apex = applyCommand(project, { type: 'frame.add', stepId: step.id, afterId: middle })!;
  applyCommand(project, { type: 'frame.update', stepId: step.id, frameId: middle, patch: { passThrough: true, duration: .45 } });
  applyCommand(project, { type: 'frame.update', stepId: step.id, frameId: apex, patch: { duration: .55 } });
  for (const [frameId, angleDegrees] of [[middle, 32], [apex, 33], [end.id, -65]] as const) {
    applyCommand(project, { type: 'frame.motion', stepId: step.id, frameId, motions: [
      { ...track, angleDegrees }, { kind: 'rotate', axis: { origin: [-20, -3, 0], direction: [0, 0, 1] }, partIds: ['passive'], angleDegrees: -angleDegrees },
    ] });
  }
  assert.deepEqual(validateProject(project), []);
  const rods = playbackPlan(project, step.id).filter(segment => segment.kind === 'motion');
  const outputAngle = (frame: typeof start): number => {
    const initial = outputJoint.clone().sub(outputPivot), current = world(frame.poses.rocker, outputLocal).sub(outputPivot);
    return Math.atan2(zAxis.dot(initial.clone().cross(current)), initial.dot(current));
  };
  const inputAngle = (frame: typeof start): number => {
    const current = world(frame.poses.crank, inputLocal);
    return Math.atan2(current.y, current.x);
  };
  for (const segment of rods) for (let index = 0; index <= 120; index++) {
    const frame = playbackFrame(segment, index / 120), a = world(frame.poses.crank, inputLocal), b = world(frame.poses.rocker, outputLocal);
    close(a, world(frame.poses.rod, rodInput)); close(b, world(frame.poses.rod, rodOutput));
    close(vector(frame.poses['input-pin'].position).sub(a), new Vector3(0, 0, 1.5));
    close(vector(frame.poses['output-pin'].position).sub(b), new Vector3(0, 0, -2));
    assert.ok(zAxis.dot(b.clone().cross(a)) > 0, 'The linkage stays on the starting branch.');
    assert.ok(Math.abs(Math.hypot(a.x, a.y) - Math.hypot(inputJoint.x, inputJoint.y)) < 1e-8);
    assert.ok(Math.abs(b.distanceTo(a) - inputJoint.distanceTo(outputJoint)) < 1e-8);
    close(vector(frame.poses.passive.position), new Vector3(12, 0, 0).applyAxisAngle(zAxis, -outputAngle(frame)).add(new Vector3(-20, -3, 0)));
  }
  const [approach, departure, reverse] = rods;
  const dt = 1e-6, before = playbackFrame(approach, 1 - dt / approach.duration), after = playbackFrame(departure, dt / departure.duration);
  const boundary = outputAngle(approach.to), velocity = (33 * Math.PI / 180) / departure.duration;
  assert.ok(Math.abs((boundary - outputAngle(before)) / dt - velocity) < .001);
  assert.ok(Math.abs((outputAngle(after) - boundary) / dt - velocity) < .001);
  const midInput = inputAngle(playbackFrame(reverse, .5));
  assert.ok(Math.abs(midInput - (inputAngle(reverse.from) + inputAngle(reverse.to)) / 2) > .01);
  for (const id of step.partIds) {
    close(vector(end.poses[id].position), vector(start.poses[id].position));
    assert.ok(Math.abs(new Quaternion(...end.poses[id].quaternion).dot(new Quaternion(...start.poses[id].quaternion))) > 1 - 1e-12);
  }
  const copyId = applyCommand(project, { type: 'step.copy', stepId: step.id });
  const copied = project.steps.find(item => item.id === copyId);
  assert.ok(copied);
  const copiedTrack = copied.frames[1].incomingMotion?.[0];
  assert.ok(copiedTrack?.kind === 'four-bar');
  assert.deepEqual(copiedTrack.input.groupIds, [copied.groups[0].id]);
  assert.deepEqual(validateProject(project), []);
  assert.throws(() => applyCommand(project, { type: 'frame.motion', stepId: step.id, frameId: middle,
    motions: [{ ...track, coupler: { partIds: ['input-pin'] } }] }), /overlapping motion tracks or roles/);
});

test('four-bar validation checks interior reachability and requires a branch at dead center', () => {
  const inputAxis = { origin: new Vector3(), direction: zAxis }, outputAxis = { origin: new Vector3(18, 0, 0), direction: zAxis };
  const startOutput = new Vector3(18, -6, 0), d = startOutput.length(), along = (d * d + 100 - 144) / (2 * d);
  const toward = startOutput.clone().normalize();
  const startInput = toward.clone().multiplyScalar(along).addScaledVector(zAxis.clone().cross(toward), Math.sqrt(100 - along * along));
  assert.throws(() => prepareFourBar(inputAxis, outputAxis, startInput, startOutput, Math.PI), /sweep is unreachable/);
  const oppositeSweep = prepareFourBar(inputAxis, outputAxis, startInput, startOutput, -Math.PI);
  close(oppositeSweep.jointsAt(-Math.PI).output, new Vector3(18, 6, 0));
  assert.throws(() => prepareFourBar(inputAxis, outputAxis, startInput, startOutput, -.05, 'negative'), /branch disagrees/);
  assert.throws(() => prepareFourBar({ ...inputAxis, direction: new Vector3(0, 1, 0) }, outputAxis, startInput, startOutput, -.05), /axes must be parallel/);
  const deadInput = new Vector3(10, 0, 2), deadOutput = new Vector3(24, 0, 4);
  assert.throws(() => prepareFourBar(inputAxis, outputAxis, deadInput, deadOutput, 1), /starts at a dead center/);
  for (const branch of ['positive', 'negative'] as const) {
    const linkage = prepareFourBar(inputAxis, outputAxis, deadInput, deadOutput, 1, branch), { input, output } = linkage.jointsAt(.8);
    assert.equal(Math.sign(zAxis.dot(output.clone().cross(input))), branch === 'positive' ? 1 : -1);
    assert.ok(Math.abs(input.distanceTo(output) - deadInput.distanceTo(deadOutput)) < 1e-8);
  }
});

test('compatible rotating tracks carry angular velocity through a marked waypoint at unequal durations', () => {
  const { project, step, start, end } = fixture({ drive: pose([10, 0, 0]) });
  const frameId = applyCommand(project, { type: 'frame.add', stepId: step.id, afterId: start.id })!;
  const waypoint = step.frames[1];
  applyCommand(project, { type: 'frame.update', stepId: step.id, frameId, patch: { duration: .45, passThrough: true } });
  applyCommand(project, { type: 'frame.update', stepId: step.id, frameId: end.id, patch: { duration: .18 } });
  for (const [frame, angleDegrees] of [[waypoint, 30], [end, 70]] as const) {
    applyCommand(project, { type: 'frame.motion', stepId: step.id, frameId: frame.id, motions: [{ kind: 'rotate', partIds: ['drive'], axis: pivot, angleDegrees }] });
  }
  const angle = (placement: Pose) => Math.atan2(placement.position[1], placement.position[0]);
  const [incoming, outgoing] = playbackPlan(project, step.id);
  const dt = 1e-6, left = playbackFrame(incoming, 1 - dt / incoming.duration), right = playbackFrame(outgoing, dt / outgoing.duration);
  const at = angle(waypoint.poses.drive), rate = Math.PI / 6 / .45;
  assert.ok(Math.abs((at - angle(left.poses.drive)) / dt - rate) < .001);
  assert.ok(Math.abs((angle(right.poses.drive) - at) / dt - rate) < .001);
  assert.deepEqual(playbackFrame(incoming, 1), waypoint);
  assert.deepEqual(playbackFrame(outgoing, 1), end);
});

test('a bent wire crosses a fixed hole with exact arc-length contact, chord alignment and stable roll', () => {
  const path = { partId: 'wire', start: [-6, 0, 0], segments: [
    { kind: 'line', to: [0, 0, 0] }, { kind: 'arc', center: [0, 4, 0], normal: [0, 0, 1], angleDegrees: 90 }, { kind: 'line', to: [4, 13, 0] },
  ] } satisfies Extract<MotionTrack, { kind: 'path-through-axis' }>['path'];
  const hole = new Vector3(34, -22, 11), axis = new Vector3(.6, 0, .8), arcEnd = 6 + 2 * Math.PI;
  const pointAt = (s: number) => {
    if (s <= 6) return new Vector3(s - 6, 0, 0);
    if (s >= arcEnd) return new Vector3(4, 4 + s - arcEnd, 0);
    const a = (s - 6) / 4;
    return new Vector3(4 * Math.sin(a), 4 * (1 - Math.cos(a)), 0);
  };
  for (const [startDistance, endDistance] of [[0, arcEnd + 9], [arcEnd + 9, 0]]) {
    const { project, step, start, end } = fixture({ wire: pose([1, 3, 2], zRotation(.3)), grip: pose([2, 8, 3], zRotation(.3)), hole: pose(hole.toArray()) });
    const motion: MotionTrack = { kind: 'path-through-axis', partIds: ['wire', 'grip'], path, startDistance, endDistance, halfSpan: .75,
      axis: { partId: 'hole', origin: [0, 0, 0], direction: axis.toArray() } };
    const command = { type: 'frame.motion', stepId: step.id, frameId: end.id, motions: [motion] } satisfies Command;
    assert.throws(() => applyCommand(project, command), /align the preceding keyframe/);
    applyCommand(project, { ...command, alignStart: true });
    applyCommand(project, command);
    assert.deepEqual(validateProject(project), []);
    const first = new Quaternion(...start.poses.wire.quaternion), fixedNormal = zAxis.clone().applyQuaternion(first);
    const relative = vector(start.poses.grip.position).sub(vector(start.poses.wire.position)).applyQuaternion(first.clone().invert());
    const samples = framePlayback(project, start.id);
    for (let i = 0; i <= 240; i++) {
      const t = i / 240, s = startDistance + (endDistance - startDistance) * easeMotion(t), sample = playbackFrame(samples, t);
      const placement = sample.poses.wire, rotation = new Quaternion(...placement.quaternion);
      const chord = pointAt(s + .75).sub(pointAt(s - .75)).normalize();
      close(world(placement, pointAt(s)), hole);
      close(chord.applyQuaternion(rotation), axis);
      close(zAxis.clone().applyQuaternion(rotation), fixedNormal);
      close(vector(sample.poses.grip.position), world(placement, relative));
    }
    applyCommand(project, { ...command, motions: [] });
    assert.equal(end.incomingMotion, undefined);
    assert.deepEqual(validateProject(project), []);
  }
});
