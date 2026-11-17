import { Vector3 } from 'three';
import { copy, findPart, frameLabels, homePose } from '../shared/document.ts';
import type { AssemblyStep, Camera, Command, Keyframe, Note, Project, SurfaceRegion, Vec3 } from '../shared/types.ts';
import { escape as esc, modal } from './ui.ts';

type Commit = (commands: Command[]) => Promise<void>;
type UpdateNote = (note: Note) => Promise<void>;
type ClipPlane = NonNullable<SurfaceRegion['clipPlanes']>[number];
let lastMotionAxis: string | undefined;

function numberField(key: string, label: string, value: number, unit = ''): string {
  return `<label><span>${esc(label)}${unit ? ` (${esc(unit)})` : ''}</span><input type="number" step="any" data-edit-field="${key}" aria-label="${esc(label)}" value="${value}"></label>`;
}
function vectorFields(key: string, label: string, value: Vec3, unit = ''): string {
  return `<fieldset class="assembly-editor-vector"><legend>${esc(label)}${unit ? ` (${esc(unit)})` : ''}</legend>${(['X', 'Y', 'Z'] as const).map((axis, index) => `<label><span>${axis}</span><input type="number" step="any" data-edit-field="${key}-${index}" aria-label="${esc(label)} ${axis}" value="${value[index]}"></label>`).join('')}</fieldset>`;
}
function numberValue(root: HTMLElement, key: string): number {
  const input = root.querySelector(`[data-edit-field="${CSS.escape(key)}"]`);
  if (!(input instanceof HTMLInputElement) || !input.value.trim() || !Number.isFinite(Number(input.value))) throw new Error('Enter a finite number in every coordinate field.');
  return Number(input.value);
}
function vectorValue(root: HTMLElement, key: string): Vec3 { return [numberValue(root, `${key}-0`), numberValue(root, `${key}-1`), numberValue(root, `${key}-2`)]; }
function selectValue(root: HTMLElement, key: string): string {
  const input = root.querySelector(`[data-edit-field="${CSS.escape(key)}"]`);
  if (!(input instanceof HTMLSelectElement)) throw new Error('The editor selection is unavailable.');
  return input.value;
}
function nonzero(vector: Vec3, name: string): void { if (vector.every(value => value === 0)) throw new Error(`${name} cannot be a zero vector.`); }

export function editFrameSettings(step: AssemblyStep, frame: Keyframe, currentCamera: Camera, commit: Commit, applyCamera: (camera: Camera) => void): void {
  const camera = frame.camera ?? currentCamera;
  modal('Frame settings', `<div class="assembly-editor"><label>Frame name<input data-frame-name aria-label="Frame name" value="${esc(frame.name)}"></label>${numberField('duration', frame.kind === 'start' ? 'Completed-step hold' : 'Transition duration', frame.duration, 's')}${vectorFields('eye', 'Camera eye', camera.eye, 'mm')}${vectorFields('target', 'Camera target', camera.target, 'mm')}${vectorFields('up', 'Camera up', camera.up)}${numberField('margin', 'Camera margin', camera.margin)}</div>`, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply', primary: true, action: async root => {
      const input = root.querySelector('[data-frame-name]'); if (!(input instanceof HTMLInputElement)) return;
      const name = input.value.trim(); if (!name) throw new Error('Enter a frame name.');
      const duration = numberValue(root, 'duration'), margin = numberValue(root, 'margin');
      if (duration <= 0 || margin <= 0) throw new Error('Duration and camera margin must be positive.');
      const nextCamera: Camera = { eye: vectorValue(root, 'eye'), target: vectorValue(root, 'target'), up: vectorValue(root, 'up'), margin };
      nonzero(nextCamera.up, 'Camera up');
      if (nextCamera.eye.every((value, index) => value === nextCamera.target[index])) throw new Error('Camera eye and target must be different.');
      await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { name, duration, camera: nextCamera, image: null } }]);
      applyCamera(nextCamera); root.remove();
    } },
  ]);
}

export function moveAlongAxis(project: Project, step: AssemblyStep, frame: Keyframe, selected: string[], commit: Commit, preferredAxis?: string): void {
  const ids = selected.filter(id => step.partIds.includes(id));
  if (!ids.length) throw new Error('Select one or more parts in the current step first.');
  const axes = project.model.constructionAxes ?? []; if (!axes.length) throw new Error('This model has no construction axes.');
  const reference = findPart(project, ids[0]), referencePose = frame.poses[reference.id];
  if (!referencePose) throw new Error('The selected part has no pose in this frame.');
  const chosen = axes.find(axis => axis.id === (preferredAxis ?? lastMotionAxis));
  const initialOffset = chosen ? new Vector3(...referencePose.position).sub(new Vector3(...homePose(reference).position)).dot(new Vector3(...chosen.direction).normalize()) : 0;
  modal('Move along axis', `<div class="assembly-editor"><p>${ids.length} selected part${ids.length === 1 ? '' : 's'} · Reference: <b>${esc(reference.name)}</b></p><label>Construction axis<select data-edit-field="motion-axis" aria-label="Construction axis"><option value="">Choose a construction axis…</option>${axes.map(axis => `<option value="${esc(axis.id)}" ${axis.id === chosen?.id ? 'selected' : ''}>${esc(axis.name)} — ${esc(axis.componentPath)}</option>`).join('')}</select></label>${numberField('distance', 'Offset from assembly position', initialOffset, 'mm')}<p class="muted small">Positive values follow the source axis direction. Zero restores the reference part's assembly position. All selected parts move together without changing their current relative positions or rotations.</p></div>`, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply', primary: true, action: async root => {
      const axis = axes.find(candidate => candidate.id === selectValue(root, 'motion-axis')); if (!axis) throw new Error('Choose a construction axis.');
      nonzero(axis.direction, 'Construction axis direction'); const distance = numberValue(root, 'distance');
      const target = new Vector3(...homePose(reference).position).addScaledVector(new Vector3(...axis.direction).normalize(), distance);
      const delta = target.sub(new Vector3(...referencePose.position)), poses = copy(frame.poses);
      for (const id of ids) poses[id].position = new Vector3(...poses[id].position).add(delta).toArray();
      await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses, image: null } }]);
      lastMotionAxis = axis.id; root.remove();
    } },
  ]);
}

export function editLabelPositions(project: Project, step: AssemblyStep, commit: Commit, frame?: Keyframe): void {
  const labels = frameLabels(project, frame);
  modal('Label positions', `<div class="assembly-editor"><p class="muted small">Offsets are measured from each part's projected label anchor. ${frame?.labels ? 'These positions apply to the current frame.' : 'These part-label positions are shared by the project\'s frames.'}</p>${step.partIds.map((id, index) => {
    const offset = labels.labelOffsets[id] ?? [20, -30];
    return `<fieldset class="assembly-editor-pair"><legend>${esc(findPart(project, id).name)}</legend>${numberField(`label-${index}-x`, `Label ${index + 1} X`, offset[0], 'px')}${numberField(`label-${index}-y`, `Label ${index + 1} Y`, offset[1], 'px')}</fieldset>`;
  }).join('')}</div>`, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply', primary: true, action: async root => {
      const labelOffsets = copy(labels.labelOffsets);
      step.partIds.forEach((id, index) => { labelOffsets[id] = [numberValue(root, `label-${index}-x`), numberValue(root, `label-${index}-y`)]; });
      await commit([frame?.labels ? { type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { labels: { ...labels, labelOffsets } } } : { type: 'settings.update', patch: { labelOffsets } }]); root.remove();
    } },
  ]);
}

export function editNotePlacement(note: Note, updateNote: UpdateNote): void {
  modal('Note placement', `<div class="assembly-editor">${numberField('note-x', 'Offset X', note.offset[0], 'px')}${numberField('note-y', 'Offset Y', note.offset[1], 'px')}</div>`, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply', primary: true, action: async root => {
      await updateNote({ ...copy(note), offset: [numberValue(root, 'note-x'), numberValue(root, 'note-y')] }); root.remove();
    } },
  ]);
}

function planeMarkup(plane: ClipPlane, index: number): string {
  const coordinate = plane.normal.findIndex((value, axis) => Math.abs(value) === 1 && plane.normal.every((other, otherAxis) => otherAxis === axis || other === 0));
  const axis = coordinate < 0 ? 'custom' : ['x', 'y', 'z'][coordinate];
  const sign = coordinate < 0 ? 1 : plane.normal[coordinate], position = coordinate < 0 ? 0 : -plane.constant / sign;
  const label = `Clipping plane ${index + 1}`;
  return `<fieldset class="region-plane"><legend>${label}</legend><button type="button" class="region-plane-remove" data-remove-plane aria-label="Remove ${label.toLowerCase()}">Remove</button><label>Plane axis<select data-edit-field="plane-axis" aria-label="${label} axis"><option value="x" ${axis === 'x' ? 'selected' : ''}>X</option><option value="y" ${axis === 'y' ? 'selected' : ''}>Y</option><option value="z" ${axis === 'z' ? 'selected' : ''}>Z</option><option value="custom" ${axis === 'custom' ? 'selected' : ''}>Custom plane</option></select></label><div data-plane-simple ${axis === 'custom' ? 'hidden' : ''}><label>Keep painted side<select data-edit-field="plane-side" aria-label="${label} keep side"><option value="below" ${sign > 0 ? 'selected' : ''}>At or below position</option><option value="above" ${sign < 0 ? 'selected' : ''}>At or above position</option></select></label>${numberField('plane-position', `${label} position`, position, 'local mm')}</div><div data-plane-custom ${axis === 'custom' ? '' : 'hidden'}>${vectorFields('plane-normal', `${label} normal`, plane.normal)}${numberField('plane-constant', `${label} constant`, plane.constant, 'local mm')}<p class="muted small">Paint is kept where normal · local point + constant ≤ 0.</p></div></fieldset>`;
}

export function editSurfaceRegion(project: Project, note: Note, index: number, updateNote: UpdateNote): void {
  const anchor = note.anchors[index], region = anchor?.region; if (!region) throw new Error('Choose a painted surface region to edit.');
  let nextPlaneIndex = region.clipPlanes?.length ?? 0;
  const root = modal('Edit surface region', `<div class="assembly-editor"><p><b>${esc(findPart(project, anchor.partId).name)}</b></p><label>Region type<select data-edit-field="region-kind" aria-label="Region type">${(['face', 'band', 'circle', 'brush'] as const).map(kind => `<option value="${kind}" ${region.kind === kind ? 'selected' : ''}>${{ face: 'Whole face', band: 'Cylinder band', circle: 'Circle patch', brush: 'Surface brush' }[kind]}</option>`).join('')}</select></label>${vectorFields('center', 'Region center', region.center, 'local mm')}${vectorFields('axis', 'Region axis', region.axis)}${numberField('width', 'Band width', region.width, 'mm')}${numberField('radius', 'Region radius', region.radius, 'mm')}<details class="region-attachment"><summary>Surface attachment</summary>${vectorFields('point', 'Attachment point', anchor.point, 'local mm')}${vectorFields('normal', 'Surface normal', region.normal)}</details><h4>Clipping planes</h4><p class="muted small">Keep only the required side of a boundary on the selected surface.</p><div data-region-planes>${(region.clipPlanes ?? []).map(planeMarkup).join('')}</div><button type="button" data-add-plane>Add clipping plane</button></div>`, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply', primary: true, action: async root => {
      const kind = selectValue(root, 'region-kind'); if (kind !== 'face' && kind !== 'band' && kind !== 'circle' && kind !== 'brush') throw new Error('Choose a region type.');
      const axis = vectorValue(root, 'axis'), normal = vectorValue(root, 'normal'), width = numberValue(root, 'width'), radius = numberValue(root, 'radius');
      nonzero(axis, 'Region axis'); nonzero(normal, 'Surface normal'); if (width <= 0 || radius <= 0) throw new Error('Band width and radius must be positive.');
      const planes = [...root.querySelectorAll<HTMLElement>('.region-plane')].map((row): ClipPlane => {
        const planeAxis = selectValue(row, 'plane-axis');
        if (planeAxis === 'custom') { const normal = vectorValue(row, 'plane-normal'); nonzero(normal, 'Clipping plane normal'); return { normal, constant: numberValue(row, 'plane-constant') }; }
        const axisIndex = ['x', 'y', 'z'].indexOf(planeAxis); if (axisIndex < 0) throw new Error('Choose a clipping plane axis.');
        const sign = selectValue(row, 'plane-side') === 'above' ? -1 : 1, normal: Vec3 = [0, 0, 0]; normal[axisIndex] = sign;
        return { normal, constant: -sign * numberValue(row, 'plane-position') };
      });
      const next = copy(note), nextAnchor = next.anchors[index];
      nextAnchor.point = vectorValue(root, 'point'); nextAnchor.normal = normal;
      if (kind === 'band' || kind === 'face') nextAnchor.target = kind;
      nextAnchor.region = { ...copy(region), kind, center: vectorValue(root, 'center'), normal, axis, width, radius };
      if (planes.length) nextAnchor.region.clipPlanes = planes; else delete nextAnchor.region.clipPlanes;
      await updateNote(next); root.remove();
    } },
  ]);
  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-add-plane],[data-remove-plane]') : null;
    if (target?.hasAttribute('data-add-plane')) root.querySelector('[data-region-planes]')?.insertAdjacentHTML('beforeend', planeMarkup({ normal: [1, 0, 0], constant: 0 }, nextPlaneIndex++));
    else if (target?.hasAttribute('data-remove-plane')) target.closest('.region-plane')?.remove();
  });
  root.addEventListener('change', event => {
    if (!(event.target instanceof HTMLSelectElement) || event.target.dataset.editField !== 'plane-axis') return;
    const row = event.target.closest('.region-plane'), custom = event.target.value === 'custom';
    const simple = row?.querySelector<HTMLElement>('[data-plane-simple]'), advanced = row?.querySelector<HTMLElement>('[data-plane-custom]');
    if (simple) simple.hidden = custom; if (advanced) advanced.hidden = !custom;
  });
}
