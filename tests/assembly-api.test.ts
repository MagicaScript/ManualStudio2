import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Quaternion, Vector3 } from 'three';
import { strToU8, zipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { playbackFrame } from '../shared/playback.ts';
import { renderImageSample, renderVideoSlices } from '../shared/render-scope.ts';
import type { Anchor, Command, Pose, Project, Vec3 } from '../shared/types.ts';
import { findBrowser, mediaCommand } from '../tools/dependencies.ts';

function sleeveGeometry(): BufferGeometry {
  const segments = 24;
  const vertices = [4, 3].flatMap(radius => [-10, 10].flatMap(z => Array.from({ length: segments }, (_, index) => {
    const angle = index * 2 * Math.PI / segments;
    return [radius * Math.cos(angle), radius * Math.sin(angle), z];
  }))).flat();
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments, a = i + segments, b = j + segments, c = i + 2 * segments, d = j + 2 * segments, e = i + 3 * segments, f = j + 3 * segments;
    indices.push(i, j, b, i, b, a, c, f, d, c, e, f, i, d, j, i, c, d, a, b, f, a, f, e);
  }
  return new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3)).setIndex(indices);
}

function assemblyFixture(): Uint8Array<ArrayBuffer> {
  const parts = [
    { name: 'Sleeve', mesh: sleeveGeometry() },
    { name: 'Pin', mesh: new CylinderGeometry(2, 2, 4, 24).rotateX(Math.PI / 2).translate(0, 0, -14) },
    { name: 'Stop Block', mesh: new BoxGeometry(8, 8, 8).translate(0, 0, 18) },
    { name: 'Handle', mesh: new BoxGeometry(2, 2, 2).translate(6, 0, -14) },
  ];
  const resources = parts.map(({ name, mesh }, index) => {
    const p = mesh.getAttribute('position'), indices = mesh.getIndex()!;
    const vertices = Array.from({ length: p.count }, (_, i) => `<vertex x="${p.getX(i)}" y="${p.getY(i)}" z="${p.getZ(i)}"/>`).join('');
    const triangles = Array.from({ length: indices.count / 3 }, (_, i) => `<triangle v1="${indices.getX(3 * i)}" v2="${indices.getX(3 * i + 1)}" v3="${indices.getX(3 * i + 2)}"/>`).join('');
    return `<object id="${index + 1}" name="${name}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`;
  });
  resources.push(`<object id="5" name="Bench Fixture"><components>${parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('')}</components></object>`);
  return new Uint8Array(zipSync({ '3D/3dmodel.model': strToU8(`<model unit="millimeter"><resources>${resources.join('')}</resources><build><item objectid="5"/></build></model>`) }));
}

const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const closeTo = (actual: number, expected: number, tolerance = 1e-5): void => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('assembly API resolves surfaces, clips paint, checks insertion and previews atomic keyframe edits', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'manualstudio-assembly-api-'));
  const api = spawn(process.execPath, ['--experimental-strip-types', 'server/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, MANUALSTUDIO_PORT: '0', MANUALSTUDIO_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let frontend: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      api.stdout.on('data', chunk => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk)); if (match) resolve(match[0]); });
      api.once('error', reject); api.stderr.on('data', chunk => reject(new Error(String(chunk))));
    });
    const request = async <T,>(url: string, options?: RequestInit, status = 200): Promise<T> => {
      const response = await fetch(base + url, options);
      const body = await response.text();
      assert.equal(response.status, status, body);
      return JSON.parse(body) as T;
    };
    let project = await request<Project>('/api/import?name=Bench-Fixture.3mf', { method: 'POST', body: assemblyFixture() });
    const [sleeve, pin, block, handle] = project.model.parts;
    const url = `/api/projects/${project.id}`;
    const axisId = 'fixture-spindle';
    project.model.constructionAxes = [{ id: axisId, name: 'Spindle Axis', componentPath: 'Bench Fixture', nativeToken: 'spindle-axis', origin: [0, 0, 0], direction: [0, 0, 1], extent: [-10, 10], visible: true, partIds: [sleeve.id] }];
    project = await request<Project>(url, { ...post({ expectedRevision: project.revision, project }), method: 'PUT' });
    const geometry = <T,>(query: unknown) => request<T>(`${url}/geometry`, post(query));
    const found = await geometry<{ parts: { id: string; path: string[] }[] }>({ operation: 'find', query: 'fixture / pin' });
    assert.deepEqual(found.parts.map(part => [part.id, part.path]), [[pin.id, ['Bench Fixture', 'Pin']]]);
    const axes = await geometry<{ axes: { localToReference: { origin: number[] } }[] }>({ operation: 'find', query: 'spindle', referencePartId: pin.id });
    assert.deepEqual(axes.axes[0].localToReference.origin, [0, 0, 14]);
    const surface = await geometry<{ anchor: Anchor; cylinder: { diameter: number; axialRange: number[] }; mesh: { triangles: { id: number }[] } }>({
      operation: 'surface', partId: sleeve.id, point: [3.9, .2, 4], space: 'world', includeMesh: true,
    });
    closeTo(surface.cylinder.diameter, 8); assert.deepEqual(surface.cylinder.axialRange, [-10, 10]);
    assert.equal(surface.mesh.triangles.length, 48); assert.ok(surface.mesh.triangles.some(triangle => triangle.id === surface.anchor.triangle));
    const bore = await geometry<{ cylinder: { diameter: number; axialRange: number[] } }>({ operation: 'surface', partId: sleeve.id, triangle: 2 });
    closeTo(bore.cylinder.diameter, 6); assert.deepEqual(bore.cylinder.axialRange, [-10, 10]);
    const painted = await geometry<{ anchor: Anchor; coverage: { area: number; axialRange: number[] } }>({
      operation: 'paint', partId: sleeve.id, triangle: 0, band: { axis: { axisId }, range: [-3, 5] },
      clipPlanes: [{ normal: [1, 0, 0], constant: 0 }],
    });
    assert.deepEqual(painted.coverage.axialRange, [-3, 5]);
    closeTo(painted.coverage.area, 24 * 8 * Math.sin(Math.PI / 24) * 4);
    assert.ok(painted.anchor.point[0] < 1e-6 && painted.anchor.region?.triangles.includes(painted.anchor.triangle));
    const outside = await geometry<{ anchor: Anchor | null }>({ operation: 'paint', partId: sleeve.id, triangle: 0, band: { range: [100, 102] } });
    assert.equal(outside.anchor, null);

    const check = { moving: { partIds: [pin.id] }, obstaclePartIds: [sleeve.id], path: { kind: 'insertion', axis: { axisId }, distance: 21 }, minimumClearance: .9 };
    const clearance = await request<{ pass: boolean; minimumClearance: number }>(`${url}/motion-check`, post(check));
    assert.ok(clearance.pass && clearance.minimumClearance > .9 && clearance.minimumClearance <= 1);
    const nested = { ...check, sampleRate: 1, obstaclePartIds: [block.id], path: { ...check.path, distance: 32 } };
    const contact = await request<{ pass: boolean; firstViolation: { kind: string; seconds: number } }>(`${url}/motion-check`, post(nested));
    assert.equal(contact.pass, false); assert.equal(contact.firstViolation.kind, 'containment'); assert.equal(contact.firstViolation.seconds, 1);
    const waypoints = await request<{ firstViolation: { kind: string; seconds: number } }>(`${url}/motion-check`, post({
      ...nested, sampleRate: 4, path: { kind: 'waypoints', waypoints: [{ duration: 1, poses: { [pin.id]: { position: [0, 0, 18], quaternion: [0, 0, 0, 1] } } }] },
    }));
    assert.equal(waypoints.firstViolation.kind, 'surface-contact'); assert.equal(waypoints.firstViolation.seconds, .75);
    const allowed = await request<{ pass: boolean; pairs: { firstContact: { kind: string }; allowed: boolean }[] }>(
      `${url}/motion-check`, post({ ...nested, allowedContacts: [[pin.id, block.id]] }));
    assert.equal(allowed.pass, true); assert.equal(allowed.pairs[0].firstContact.kind, 'containment'); assert.equal(allowed.pairs[0].allowed, true);
    await request(`${url}/geometry`, post({ operation: 'find', expectedRevision: project.revision - 1 }), 409);

    const batch = (commands: Command[], preview = false) => request<{
      project: Project; changes: { steps: { stepId: string }[]; handoffWarnings: { parts: { partId: string }[] }[] };
    }>(`${url}/commands`, post({ expectedRevision: project.revision, commands, preview }));
    project = (await batch([
      { type: 'step.add', name: 'Join pin and handle', parts: [pin.id, handle.id] },
      { type: 'step.add', name: 'Install the insert', parts: [sleeve.id] },
    ])).project;
    const [first, second] = project.steps;
    project = (await batch([{ type: 'step.group', stepId: second.id, sourceStepId: first.id }])).project;
    const start = project.steps[1].frames[0], end = first.frames.at(-1)!, groupId = project.steps[1].groups[0].id;
    const frameId = 'aligned-insert';
    const commands: Command[] = [
      { type: 'frame.add', stepId: second.id, afterId: start.id, frameId },
      { type: 'frame.transform', stepId: second.id, frameId, motions: [{ groupIds: [groupId], axis: { axisId }, angleDegrees: 90, distance: 3 }] },
      { type: 'frame.update', stepId: second.id, frameId, patch: { camera: { eye: [40, -50, 45], target: [0, 0, 0], up: [0, 0, 1], margin: 1.1 }, xrayPartIds: [sleeve.id], hidden: [], duration: .3, passThrough: true } },
      { type: 'note.put', stepId: second.id, frameId, note: { id: 'painted-band', kind: 'glue', text: 'Coat the sleeve band.', color: '#8593bb', background: '#283334', size: 12, anchors: [painted.anchor], offset: [0, 0] } },
      { type: 'frame.transform', stepId: first.id, frameId: end.id, motions: [{ partIds: [pin.id], translation: [0, 0, 32] }] },
    ];
    const preview = await batch(commands, true);
    assert.deepEqual(await request<Project>(url), project);
    assert.deepEqual(preview.changes.steps.map(change => change.stepId), [first.id, second.id]);
    assert.ok(preview.changes.handoffWarnings[0].parts.some(part => part.partId === pin.id));
    const frame = preview.project.steps[1].frames[1];
    assert.equal(frame.id, frameId); assert.equal(frame.passThrough, true);
    closeTo(Math.hypot(...frame.poses[pin.id].position.map((value, i) => value - frame.poses[handle.id].position[i])),
      Math.hypot(...start.poses[pin.id].position.map((value, i) => value - start.poses[handle.id].position[i])));
    closeTo(frame.poses[handle.id].quaternion[2], Math.SQRT1_2);
    assert.deepEqual(frame.xrayPartIds, [sleeve.id]); assert.equal(frame.notes[0].anchors[0].region?.kind, 'band');
    await request(`${url}/commands`, post({ expectedRevision: project.revision, commands: [...commands, commands[0]] }), 400);
    assert.deepEqual(await request<Project>(url), project);
    project = (await batch(commands)).project;
    assert.deepEqual(project.steps, preview.project.steps);
    const audit = await batch([], true);
    assert.equal(audit.changes.steps.length, 0); assert.ok(audit.changes.handoffWarnings.length > 0);
    const saved = await request<{ pass: boolean }>(`${url}/motion-check`, post({
      stepId: first.id, moving: { partIds: [pin.id] }, obstaclePartIds: [block.id], path: { kind: 'saved' },
    }));
    assert.equal(saved.pass, false);

    project = (await batch([{ type: 'step.add', name: 'Approach the stop block', parts: [pin.id, block.id] }])).project;
    const movingStep = project.steps.at(-1)!, [movingStart, movingEnd] = movingStep.frames, passId = 'approach-waypoint';
    const movingPose = (z: number) => ({ position: [0, 0, z] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] });
    const poses = (z: number) => ({ [pin.id]: movingPose(z), [block.id]: movingPose(5.5) });
    project = (await batch([
      { type: 'frame.add', stepId: movingStep.id, afterId: movingStart.id, frameId: passId },
      { type: 'frame.update', stepId: movingStep.id, frameId: movingStart.id, patch: { poses: poses(-4) } },
      { type: 'frame.update', stepId: movingStep.id, frameId: passId, patch: { poses: poses(4), duration: 1 } },
      { type: 'frame.update', stepId: movingStep.id, frameId: movingEnd.id, patch: { poses: poses(12), duration: .45 } },
    ])).project;
    const checkToWaypoint = post({ stepId: movingStep.id, moving: { partIds: [pin.id] }, obstaclePartIds: [block.id], sampleRate: 2,
      path: { kind: 'saved', toFrameId: passId } });
    const collisionTime = async () => (await request<{ firstViolation: { seconds: number } }>(`${url}/motion-check`, checkToWaypoint)).firstViolation.seconds;
    assert.equal(await collisionTime(), .5);
    const mark = { type: 'frame.update', stepId: movingStep.id, frameId: passId, patch: { passThrough: true } } as const;
    for (const invalid of [{ ...mark, frameId: movingStart.id }, { ...mark, patch: { passThrough: 'true' } }]) {
      await request(`${url}/commands`, post({ expectedRevision: project.revision, commands: [invalid] }), 400);
    }
    project = (await batch([mark])).project;
    assert.equal(await collisionTime(), 1, 'A scoped motion check still uses the frame after its marked end point.');
    const inserted = await batch([{ type: 'frame.add', stepId: movingStep.id, afterId: passId, frameId: 'extra-frame' }], true);
    assert.equal(inserted.project.steps.at(-1)!.frames[2].passThrough, undefined);

    project = (await batch([{ type: 'step.add', name: 'Sweep the four-bar output pin', parts: [pin.id, handle.id, sleeve.id, block.id] }])).project;
    const sweep = project.steps.at(-1)!, [sweepStart, sweepEnd] = sweep.frames;
    const at = (position: Vec3): Pose => ({ position, quaternion: [0, 0, 0, 1] });
    const obstacle = at([9, 9, 0]);
    const sweepPoses = (position: Vec3) => ({ [pin.id]: at(position), [handle.id]: obstacle, [sleeve.id]: at([18, 0, 0]), [block.id]: at([18, 9, 2]) });
    project = (await batch([
      { type: 'frame.update', stepId: sweep.id, frameId: sweepStart.id, patch: { poses: sweepPoses([10, 0, 0]) } },
      { type: 'frame.update', stepId: sweep.id, frameId: sweepEnd.id, patch: { duration: 1, poses: sweepPoses([0, 10, 0]) } },
    ])).project;
    const sweepCheck = post({ stepId: sweep.id, moving: { partIds: [pin.id] }, obstaclePartIds: [handle.id], sampleRate: 2, path: { kind: 'saved' } });
    assert.equal((await request<{ pass: boolean }>(`${url}/motion-check`, sweepCheck)).pass, true);
    const linkage = { kind: 'four-bar', angleDegrees: 90,
      input: { partIds: [sleeve.id], axis: { origin: [18, 0, 0], direction: [0, 0, 1] }, joint: { point: [0, 9, 2], partId: sleeve.id } },
      output: { partIds: [pin.id], axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, joint: { point: [0, 0, 0], partId: pin.id } },
      coupler: { partIds: [block.id] },
    } satisfies Extract<Command, { type: 'frame.motion' }>['motions'][number];
    const track: Command = { type: 'frame.motion', stepId: sweep.id, frameId: sweepEnd.id, motions: [linkage] };
    const unreachable = await request<{ error: string }>(`${url}/commands`, post({ expectedRevision: project.revision, preview: true,
      commands: [{ ...track, motions: [{ ...linkage, angleDegrees: 180 }] }] }), 400);
    assert.match(unreachable.error, /sweep is unreachable/);
    const motionPreview = await batch([track], true);
    assert.equal(motionPreview.project.steps.at(-1)!.frames[1].incomingMotion?.[0].kind, 'four-bar');
    assert.deepEqual(await request<Project>(url), project);
    project = (await batch([track])).project;
    const midpoint = await geometry<{ parts: { pose: Pose }[] }>({ operation: 'find', query: pin.id, frameId: sweepStart.id, progress: .5 });
    closeTo(midpoint.parts[0].pose.position[0], Math.sqrt(50)); closeTo(midpoint.parts[0].pose.position[1], Math.sqrt(50));
    const rodAtMidpoint = (await geometry<{ parts: { pose: Pose }[] }>({ operation: 'find', query: block.id, frameId: sweepStart.id, progress: .5 })).parts[0].pose;
    const rodEnd = new Vector3(-8, -9, -2).applyQuaternion(new Quaternion(...rodAtMidpoint.quaternion)).add(new Vector3(...rodAtMidpoint.position));
    closeTo(rodEnd.distanceTo(new Vector3(...midpoint.parts[0].pose.position)), 0);
    const sweepHit = await request<{ firstViolation: { seconds: number } }>(`${url}/motion-check`, sweepCheck);
    assert.equal(sweepHit.firstViolation.seconds, .5, 'Saved collision checks follow the arc through the obstacle.');
    await request(`${url}/commands`, post({ expectedRevision: project.revision, commands: [{ type: 'frame.update', stepId: sweep.id,
      frameId: sweepEnd.id, patch: { poses: sweepPoses([0, 10, 0]) } }] }), 400);
    assert.deepEqual(await request<Project>(url), project);

    const scope = { stepId: second.id, range: [.05, .25] as [number, number] };
    const [slice] = renderVideoSlices(project, scope), still = renderImageSample(project, { stepId: second.id, time: .05 });
    assert.deepEqual(playbackFrame(slice.segment, slice.start), playbackFrame(still.segment, still.progress));
    closeTo(slice.duration, .2); closeTo(slice.end, .25 / .3);
    const render = <T,>(kind: string, scope: unknown, status = 200) => request<T>('/api/render', post({ projectId: project.id, expectedRevision: project.revision, renderer: 'external', kind, scope, display: 'current' }), status);
    await render('mp4', { stepId: second.id, range: [0, 100] }, 400);
    await render('png', { frameId: 'missing-frame' }, 400);
    const executablePath = await findBrowser();
    assert.ok(executablePath);
    frontend = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': base, '/models': base, '/exports': base } } });
    await frontend.listen();
    const address = frontend.httpServer?.address(); assert.ok(address && typeof address === 'object');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    const videoUploads: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/render/')) {
        const type = request.headers()['content-type'];
        if (type === 'video/mp4') videoUploads.push(type);
      }
    });
    for (const [kind, renderScope] of [['png', { frameId, progress: .4 }], ['mp4', scope]] as const) {
      const job = await render<{ id: string; revision: number }>(kind, renderScope);
      assert.equal(job.revision, project.revision);
      await page.goto(`http://127.0.0.1:${address.port}/?project=${project.id}&render=${job.id}`);
      await page.waitForFunction(() => document.documentElement.dataset.renderComplete === 'true');
      const { result } = await request<{ result: { error?: string; url: string; path: string } }>(`/api/render/${job.id}`);
      assert.equal(result.error, undefined);
      if (kind === 'png') {
        const png = Buffer.from(await (await fetch(base + result.url)).arrayBuffer());
        assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.ok(png.length > 10000);
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1920, 1080]);
      } else {
        const { stdout } = await promisify(execFile)(await mediaCommand('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames,r_frame_rate', '-of', 'json', result.path], { windowsHide: true });
        assert.deepEqual(JSON.parse(stdout).streams, [{ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '60/1', nb_frames: '12' }]);
        assert.deepEqual(videoUploads, ['video/mp4']);
      }
    }
    assert.equal(await request(`${url}/session`), null);
    assert.deepEqual(await request<Project>(url), project);
  } finally {
    await browser?.close(); await frontend?.close();
    const stopped = new Promise<void>(resolve => api.once('close', () => resolve())); api.kill(); if (api.exitCode === null) await stopped;
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('manualstudio-assembly-api-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
