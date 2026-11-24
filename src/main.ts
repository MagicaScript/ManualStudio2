import './style.css';
import './layout.css';
import './bambu.css';
import './playback.css';
import './step-reorder.css';
import './assembly-editors.css';
import { editFrameSettings, editLabelPositions, editNotePlacement, editSurfaceRegion, moveAlongAxis } from './assembly-editors.ts';
import './assembly-hover.css';
import './panel-disclosure.css';
import './note-colors.css';
import { isShapeNote, NOTE_COLOR_PRESETS, noteColorPalette } from './note-colors.ts';
import { PanelDisclosure } from './panel-disclosure.ts';
import { StepReorder } from './step-reorder.ts';
import { createPickerDraft, pickerCommands, stagePickerAssembly, type PickerDraft } from '../shared/picker-draft.ts';
import { Quaternion, Vector3 } from 'three';
import { Viewport, type NameTarget, type ViewTool } from './viewport.ts';
import { editInlineName } from './inline-name.ts';
import { applyCommand, assembledPartIds, assemblySnapshot, copy, teardownPoses, findFrame, findPart, findStep, frameLabels, frameQueue, homePose, MAX_ORDINARY_STEPS, mergeCoversWholeModel, uid } from '../shared/document.ts';
import { DEFAULT_DISPLAY_MODE, isDisplayMode, type Anchor, type AssemblyStep, type Command, type DisplayMode, type FrameLabels, type Keyframe, type LabelLayoutRequest, type ModelTreeNode, type Note, type NoteKind, type Part, type Pose, type Project, type SessionState, type Settings, type SyncPlan, type Vec3 } from '../shared/types.ts';
import { escape as esc, element, icon, menu, modal, pickFile, toast, busy } from './ui.ts';
import { download, exportProject, inspectLabelLayout, type ExportKind } from './export.ts';
import { nextListPart, rangeSelection } from '../shared/selection.ts';
import { browserRoots, findBrowserNode, modelVisibility, nodeOwnVisibility, nodePartIds } from '../shared/model-tree.ts';
import { DEFAULT_GLUE_COLOR, DEFAULT_NOTE_COLOR } from '../shared/render-style.ts';
import { continuousBoundary, playbackCard, playbackDuration, playbackPlan, resumeAfterTitle, stepPlayback, type PlaybackSegment } from '../shared/playback.ts';
import type { RenderScope } from '../shared/render-scope.ts';
import { drawPlaybackCard } from './playback-card.ts';
import type { FusionBridgeState, FusionJobState } from '../server/fusion.ts';
import { installToolbarTooltips } from './toolbar-tooltips.ts';

const app = element('#app');
const displayModeOptions = '<option value="xray">X-Ray Other Parts</option><option value="current">Current Step Parts Only</option><option value="all">Show All Parts</option>';
app.innerHTML = `
<header class="topbar"><button class="icon" id="fileMenu" title="File">☰</button><span>File</span><button class="icon" id="saveButton" disabled title="Save project">${icon('save')}</button><span class="divider"></span><button class="icon" id="undoButton" title="Undo (Ctrl+Z)">${icon('undo')}</button><button class="icon" id="redoButton" title="Redo (Ctrl+Shift+Z)">${icon('redo')}</button><div class="project-title" id="projectTitle">ManualStudio</div><span class="save-status" id="saveStatus">Ready</span><button class="icon" id="settingsButton" disabled title="Workspace options">${icon('settings')}</button></header>
<nav class="workspace-tabs"><span class="home-icon">⌂</span><div class="active-tab">${icon('cube')} Assembly</div><select class="project-select" id="projectSelect" aria-label="Project"><option value="">Open a model…</option></select><button id="importButton">Open model</button><button id="importFusion">Fusion cloud</button><button id="syncButton" disabled>Sync model</button><span class="model-caption">ManualStudio · Assembly Workspace</span></nav>
<main class="workspace"><div class="viewport" id="viewport"></div><canvas class="playback-overlay" id="playbackOverlay" hidden aria-hidden="true"></canvas><div class="material-bar" id="materialBar"></div>
<button class="return-button" id="returnButton" hidden title="Return to overall preview">${icon('back')} Overall preview</button>
<aside class="panel left-panel" id="structurePanel" data-panel-name="Assembly Structure"><header class="panel-header"><span class="row"><button class="icon panel-toggle" id="collapseStructure" data-panel-toggle="structurePanel" title="Collapse Assembly Structure" aria-expanded="true">${icon('collapsePanel')}</button><span>Assembly Structure</span><button class="icon panel-help" id="structureHelp" title="Assembly Structure help">${icon('help')}</button></span><span class="row"><button class="icon" id="structureSearchButton" title="Search steps" aria-label="Search steps" aria-expanded="false">${icon('search')}</button><button class="icon" id="clearAllSteps" title="Delete all assembly steps">${icon('clearSteps')}</button></span></header><div class="panel-body" id="structureBody"><div class="list-controls structure-search" id="structureSearchRow" hidden><input id="structureSearch" type="search" placeholder="Search steps or parts…" aria-label="Search steps or parts"><output id="structureSearchCount" aria-live="polite"></output></div><div class="structure-scroll" id="structure"></div><footer class="add-step-row"><button class="primary" id="addStep">Add Step</button><button class="icon" id="mergeSteps" title="Merge and add steps" hidden>${icon('merge')}</button><button id="selectionStep" title="Create a new step from selected 3D parts" hidden>New step from selection</button><button class="icon" id="footerReturn" title="Return to overall preview" hidden>${icon('exit')}</button><div id="mergeControls" hidden><div class="row"><label class="row"><input type="checkbox" id="mergeAll">Select All</label><button id="cancelMerge">Cancel</button><button class="primary" id="confirmMerge" disabled>Confirm</button></div><p class="small muted" id="mergeResult"></p></div></footer></div></aside>
<div class="viewport-tools" id="viewTools"><button data-tool="select" title="Select (Esc)" class="active">↖</button><button data-tool="move" title="Move (M)">${icon('move')}</button><button data-tool="rotate" title="Rotate (R)">${icon('rotate')}</button><button id="explodeButton" title="Automatically explode new parts">${icon('explosion')}</button><button id="homePoseButton" title="Apply final assembly pose">${icon('finalPose')}</button><button data-tool="measure" title="Measure between surface points">${icon('measure')}</button></div>
<button class="export-button" id="exportButton" disabled><span>${icon('export')}</span>Export</button>
<div class="right-stack overall" id="rightStack"><aside class="panel right-tools" id="guide" data-panel-name="Assembly Guide" hidden></aside><aside class="panel assembly-list" id="listPanel" data-panel-name="Assembly list"><header class="panel-header"><span class="row"><button class="icon panel-toggle" id="collapseList" data-panel-toggle="listPanel" title="Collapse Assembly list" aria-expanded="true">${icon('collapsePanel')}</button>Assembly list</span><span class="row"><button class="icon" id="filterButton" title="Show unassembled only">${icon('filter')}</button><button class="icon" id="searchButton" title="Search">${icon('search')}</button></span></header><div class="panel-body" id="listBody"><div class="list-controls" id="searchRow" hidden><input id="partSearch" type="search" placeholder="Search parts or materials…" aria-label="Search parts"><button id="expandAll" title="Expand all">⌄</button></div><div class="list-columns"><span>Object name</span><span>Assemble</span></div><div class="part-tree" id="partTree" role="listbox" aria-label="Assembly list" aria-multiselectable="true" tabindex="0"></div></div></aside></div>
<div class="navigation"><div class="view-cube"></div><button class="round-button" id="fitAll" title="Fit all (Home)">${icon('fitAll')}</button><button class="round-button" id="fitSelected" title="Fit selection (F)">${icon('fitSelected')}</button></div>
<div class="playbar" id="playbar" hidden><button id="playButton" title="Play all steps">${icon('play')}</button><select id="playSpeed" aria-label="Playback speed"><option value=".5">0.5×</option><option value="1" selected>1.0×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select><input type="range" id="playSlider" min="0" max="1" value="0" step=".01" aria-label="Assembly playback"><span id="frameNumber" class="small">1</span><button id="previousFrame" title="Previous frame">${icon('previous')}</button><button id="nextFrame" title="Next frame">${icon('next')}</button><select id="displayMode" aria-label="Display mode">${displayModeOptions}</select></div>
<div class="bottom-controls">
  <span class="shortcut-help"><button id="assemblyShortcutHelp" aria-label="Assembly shortcuts" aria-describedby="assemblyShortcuts">${icon('keyboard')}</button>
  <dl id="assemblyShortcuts" class="assembly-shortcuts" role="tooltip"><dt>Left click</dt><dd>Select object or part</dd><dt>Middle drag</dt><dd>Pan view</dd><dt>Right click on a part</dt><dd>Open assembly menu</dd><dt>Alt + Left click</dt><dd>Select individual part</dd><dt>Shift + List click</dt><dd>Select a range</dd><dt>Tab / Shift+Tab</dt><dd>Next / previous part</dd><dt>View cube</dt><dd>26 standard directions</dd><dt>Ctrl + 1–9 / S</dt><dd>Reserved for Chrome</dd><dt>M / R</dt><dd>Move / Rotate</dd></dl></span>
  <div class="view-control-group"><span id="sectionLabel">Section View</span><button id="resetSectionDirection" hidden>Reset direction</button><input type="range" id="sectionRange" min="0" max="1" step=".01" value="0" aria-label="Section view"><input class="section-value" id="sectionValue" type="number" min="0" max="1" step=".05" value="0.00" aria-label="Section view value"></div>
  <div class="view-control-group"><span>Explosion Ratio</span><input type="range" id="explosionRange" min="1" max="3" step=".01" value="1" aria-label="Explosion ratio"><input class="explosion-value" id="explosionValue" type="number" min="1" max="3" step=".1" value="1.00" aria-label="Explosion ratio value"></div>
  <label class="view-control-group">Selection Mode: <select id="selectionMode" aria-label="Selection mode"><option value="part">Part</option><option value="object">Object</option></select></label>
  <label class="view-control-group"><input type="checkbox" id="overviewUnassembled" disabled>Unassembled only</label>
</div>
<div class="status-text" id="status"></div><div id="emptyState" class="empty-state"><div class="cube-mark">◇</div><h1>Assembly workspace</h1><p>Open a 3MF or native F3D model to create an assembly guide.<br>Fusion cloud imports retain material names and construction axes.</p><button class="primary" id="emptyImport">Open model</button></div></main>`;

installToolbarTooltips([
  { button: element<HTMLButtonElement>('#saveButton'), text: 'Save Project' },
  { button: element<HTMLButtonElement>('#undoButton'), text: 'Undo (Ctrl+Z)' },
  { button: element<HTMLButtonElement>('#redoButton'), text: 'Redo (Ctrl+Y)' },
]);

let project: Project | undefined;
let stepId: string | null = null, frameId: string | null = null;
let selected: string[] = [], display: DisplayMode = DEFAULT_DISPLAY_MODE, explosion = 1;
let selectedAxis: string | undefined;
let query = '', unassembledOnly = false, activeNoteId: string | undefined;
let glueOperation: { projectId: string; stepId: string; frameId: string; noteId: string } | undefined;
let picking: PickerDraft | undefined;
let undo: Project[] = [], redo: Project[] = [];
let saving = false, pendingReload = false, suppressSession = false;
let playing = false, playRaf = 0, timelinePosition: number | undefined;
let pausedPlayback: { local: boolean; index: number; progress: number; stepId: string | null } | undefined;
let activePlaybackPlan: PlaybackSegment[] = [];
let thumbnailObserver: IntersectionObserver | undefined;
let editedPoses: Record<string, Pose> | undefined;
let noteColor = DEFAULT_NOTE_COLOR, glueColor = DEFAULT_GLUE_COLOR, noteBackground = '#30343c', noteText = '', removeWholePart = true;
let shapeNoteColor = NOTE_COLOR_PRESETS[2].value;
let apiQueue = Promise.resolve();
let sessionQueue = Promise.resolve();
let projectLoadSequence = 0, exporting = false;
const sessionOrigin = crypto.randomUUID();
let noteDraft: { stepId: string; frameId: string; noteId: string; text: string } | undefined;
let noteDraftTimer: ReturnType<typeof setTimeout> | undefined;
let rangeAnchorId: string | undefined, focusedListId: string | undefined;
const treeExpansion = new Map<string, boolean>();
let pickerQuery = '';
let pickerSearchOpen = false, pickerUnassembledOnly = false;
const panels = new PanelDisclosure();
let structureQuery = '';
let merging: Set<string> | undefined;
for (const id of ['structurePanel', 'listPanel']) panels.sync(element(`#${id}`));
const stepReorder = new StepReorder(element('#structure'), () => project?.steps.map(step => step.id) ?? []);
async function flushNoteDraft(): Promise<void> {
  clearTimeout(noteDraftTimer); const draft = noteDraft; noteDraft = undefined; if (!draft) return;
  await commit([{ type: 'note.update', stepId: draft.stepId, frameId: draft.frameId, noteId: draft.noteId, patch: { text: draft.text } }]);
}
const getStep = (): AssemblyStep | undefined => project?.steps.find(s => s.id === stepId);
const getFrame = (): Keyframe | undefined => getStep()?.frames.find(f => f.id === frameId) ?? getStep()?.frames[0];
const overviewUnassembled = element<HTMLInputElement>('#overviewUnassembled');
function labelCommand(patch: Partial<FrameLabels>): Command {
  const step = getStep(), frame = getFrame();
  return step && frame?.labels ? { type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { labels: { ...frame.labels, ...patch } } } : { type: 'settings.update', patch };
}
const view = new Viewport(element('#viewport'), {
  select: (id, multiple, individual) => selectPart(id, multiple, individual, true),
  contextMenu: viewportPartMenu,
  dragHover: target => highlightStepDrop(stepDropCard(target)),
  axis: id => selectAxis(id),
  drop: (ids, x, y) => void dropParts(ids, x, y).catch(showError),
  pose: poses => { const step = getStep(), frame = getFrame(); editedPoses = undefined; if (step && frame) void commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses: { ...frame.poses, ...poses }, image: null } }]).catch(showError); else void commit([{ type: 'model.pose', poses }]).catch(showError); },
  anchors: (anchors, kind) => void addNote(anchors, kind).catch(showError),
  note: id => { activeNoteId = id; renderGuide(); renderNoteEditor(); },
  noteMove: (id, offset) => { const step = getStep(), frame = getFrame(); if (step && frame) void commit([{ type: 'note.update', stepId: step.id, frameId: frame.id, noteId: id, patch: { offset } }]).catch(showError); },
  labelMove: (id, offset) => { if (project) void commit([labelCommand({ labelOffsets: { ...frameLabels(project, getFrame()).labelOffsets, [id]: offset } })]).catch(showError); },
  renameName: (target, anchor) => editName(target, anchor),
  focusName: target => focusName(target),
  copyName: name => { void navigator.clipboard.writeText(name).then(() => toast('Name copied to clipboard.', 'copy')).catch(showError); },
  status: text => toast(text),
  align: (source, target, faces) => void alignParts(source, target, faces).catch(showError),
  clearSelection: () => { selected = []; selectedAxis = undefined; rangeAnchorId = undefined; focusedListId = undefined; view.select([]); updateTreeSelection(); updateSelectionInfo(); sendSession(); },
});
const alignButton = document.createElement('button'); alignButton.dataset.tool = 'align'; alignButton.title = 'Align two points or faces'; alignButton.textContent = '⊥'; element('#viewTools').append(alignButton);
async function alignParts(source: Anchor, target: Anchor, faces: boolean): Promise<void> {
  const step = getStep(), frame = getFrame(); if (!step || !frame || !step.partIds.includes(source.partId)) throw new Error('Add the moving part to the current step first.');
  if (selected.includes(target.partId)) throw new Error('Choose a target outside the moving part or assembly.');
  const sourceMesh = view.meshes.get(source.partId)!, targetMesh = view.meshes.get(target.partId)!;
  const sourcePoint = sourceMesh.localToWorld(new Vector3(...source.point)); const targetPoint = targetMesh.localToWorld(new Vector3(...target.point));
  const rotation = faces ? new Quaternion().setFromUnitVectors(new Vector3(...source.normal).applyQuaternion(sourceMesh.quaternion).normalize(), new Vector3(...target.normal).applyQuaternion(targetMesh.quaternion).normalize().negate()) : new Quaternion();
  const poses = copy(frame.poses);
  for (const id of selected) { const pose = poses[id]; if (!pose) continue; pose.position = new Vector3(...pose.position).sub(sourcePoint).applyQuaternion(rotation).add(targetPoint).toArray(); pose.quaternion = new Quaternion(...pose.quaternion).premultiply(rotation).toArray(); }
  await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses } }]); setTool('select');
}
function showError(error: unknown): void { busy(); toast(error instanceof Error ? error.message : String(error), 9000); element('#saveStatus').textContent = 'Check message'; }
async function request<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); const data: unknown = await response.json(); if (!response.ok) { const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : response.statusText; throw new Error(message); } return data as T; }
const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function refreshProjects(): Promise<void> { const projects = await request<{ id: string; name: string }[]>('/api/projects'); element<HTMLSelectElement>('#projectSelect').innerHTML = `<option value="">Open a model…</option>${projects.map(p => `<option value="${esc(p.id)}" ${p.id === project?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`; }
async function openProject(id: string): Promise<void> {
  selectedAxis = undefined; treeExpansion.clear();
  const sequence = ++projectLoadSequence;
  await flushNoteDraft(); await apiQueue; if (sequence !== projectLoadSequence) return;
  stopPlayback(); busy('Loading model…'); const next = await request<Project>(`/api/projects/${id}`); if (sequence !== projectLoadSequence) return; await view.load(next, () => sequence === projectLoadSequence); if (sequence !== projectLoadSequence) return; project = next; stepId = null; frameId = null; selected = []; undo = []; redo = []; activeNoteId = undefined; picking = undefined; explosion = 1;
  element<HTMLInputElement>('#sectionRange').value = '0'; element<HTMLInputElement>('#sectionValue').value = '0.00'; element('#sectionLabel').hidden = false; element('#resetSectionDirection').hidden = true;
  overviewUnassembled.checked = false;
  display = next.settings.defaultDisplayMode ?? DEFAULT_DISPLAY_MODE;
  resetModelInteraction(); localStorage.setItem('manualstudio-assembly-project', id); render(); view.view('iso'); view.fit(undefined, .95); busy(); await refreshProjects();
}
function resetModelInteraction(): void {
  merging = undefined;
  selected = []; selectedAxis = undefined; rangeAnchorId = undefined; focusedListId = undefined; activeNoteId = undefined; glueOperation = undefined; editedPoses = undefined; picking = undefined;
  view.select([]); setTool('select');
}
async function commit(commands: Command[] | ((current: Project) => Command[]), selectResult?: 'step' | 'frame'): Promise<void> {
  const operation = apiQueue.then(async () => {
    if (!project) return;
    const batch = typeof commands === 'function' ? commands(project) : commands; if (!batch.length) return;
    stopPlayback(); const before = copy(project); saving = true; element('#saveStatus').textContent = 'Saving…';
    try {
      const response = await request<{ project: Project; results: (string | null)[] }>(`/api/projects/${project.id}/commands`, post({ expectedRevision: project.revision, commands: batch }));
      if (response.project.revision !== before.revision) { undo.push(before); if (undo.length > 40) undo.shift(); redo = []; } project = response.project;
      if (selectResult === 'step' && response.results[0]) { stepId = response.results[0]; frameId = getStep()?.frames[0].id ?? null; picking = undefined; }
      if (selectResult === 'frame' && response.results[0]) frameId = response.results[0];
      if (!getStep()) { stepId = null; frameId = null; } else if (!getStep()?.frames.some(f => f.id === frameId)) frameId = getStep()!.frames[0].id;
      element('#saveStatus').textContent = 'Saved'; render();
    } finally { saving = false; if (pendingReload) { pendingReload = false; void reloadExternal(); } }
  }); apiQueue = operation.catch(() => {}); return operation;
}
async function replaceProject(next: Project, recordHistory = true): Promise<void> {
  if (!project) return; const previous = copy(project); saving = true;
  try { project = await request<Project>(`/api/projects/${project.id}`, { ...post({ project: next, expectedRevision: project.revision }), method: 'PUT' }); if (recordHistory) { undo.push(previous); redo = []; } render(); } finally { saving = false; }
}
async function reloadExternal(): Promise<void> {
  if (!project || saving) return;
  const current = project, sequence = projectLoadSequence;
  const next = await request<Project>(`/api/projects/${current.id}`);
  if (sequence !== projectLoadSequence || project?.id !== current.id || next.revision <= project.revision) return;
  if (saving) { pendingReload = true; return; }
  if (project.revision !== current.revision) { void reloadExternal().catch(showError); return; }
  const geometryChanged = next.model.id !== project.model.id;
  if (geometryChanged) {
    await view.load(next, () => sequence === projectLoadSequence && project?.id === current.id && !saving && project.revision === current.revision);
    if (sequence !== projectLoadSequence || project?.id !== current.id) return;
    if (saving) { pendingReload = true; return; }
    if (project.revision !== current.revision) { void reloadExternal().catch(showError); return; }
  }
  undo = []; redo = []; project = next; if (geometryChanged) resetModelInteraction(); render();
}
function session(): SessionState {
  const position = timelinePosition ?? Number(element<HTMLInputElement>('#playSlider').value);
  const source = project && (playing || pausedPlayback) ? frameQueue(project)[Math.floor(position)] : undefined;
  return { stepId, frameId: source?.frame.id ?? frameId, selected, display, explosion, section: Number(element<HTMLInputElement>('#sectionRange').value), sectionNormal: view.sectionState().normal, frameProgress: getStep() ? position % 1 : undefined, playing };
}
function sendSession(): void {
  if (!project || suppressSession) return;
  const id = project.id, snapshot = session();
  sessionQueue = sessionQueue.then(() => request(`/api/projects/${id}/session`, { ...post(snapshot), method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-ManualStudio-Session-Origin': sessionOrigin } })).then(() => {}, () => {});
}
function setSectionValue(amount: number, resetDirection = false, normal?: Vec3): void {
  const value = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
  element<HTMLInputElement>('#sectionRange').value = String(value); element<HTMLInputElement>('#sectionValue').value = value.toFixed(2);
  element('#sectionLabel').hidden = value > 0; element('#resetSectionDirection').hidden = value === 0;
  if (normal && normal.length === 3 && normal.every(Number.isFinite) && normal.some(value => value !== 0)) view.restoreSection({ amount: value, normal: new Vector3(...normal).normalize().toArray() });
  else view.setSection(value, resetDirection);
}
function scrubTo(value: number, notify = true): void {
  if (!project || !Number.isFinite(value)) return;
  const queue = frameQueue(project); if (!queue.length) return;
  stopPlayback(); const position = Math.max(0, Math.min(queue.length - 1, value)), index = Math.floor(position);
  const first = queue[index], second = queue[Math.ceil(position)];
  if (stepId !== first.step.id) setSectionValue(0);
  stepId = first.step.id; frameId = first.frame.id; editedPoses = undefined; activeNoteId = undefined;
  selected = selected.filter(id => first.step.partIds.includes(id));
  const segment: PlaybackSegment = first !== second && first.step.id === second.step.id ? stepPlayback(project, first.step, first.frame)
    : { kind: 'hold', duration: first.frame.duration, step: first.step, from: first.frame, to: first.frame };
  render(); view.showPlayback(project, segment, position % 1, display, explosion); view.select(selected);
  timelinePosition = position; element<HTMLInputElement>('#playSlider').value = String(position); element('#frameNumber').textContent = `${index + 1}/${queue.length}`;
  if (notify) sendSession();
}
function applySessionState(state: Partial<SessionState>): void {
  const navigates = 'stepId' in state || 'frameId' in state || 'frameProgress' in state;
  if (navigates) stopPlayback();
  if (state.stepId !== undefined && state.stepId !== stepId) { stepId = state.stepId; frameId = getStep()?.frames[0].id ?? null; selected = []; setSectionValue(0); }
  if (state.frameId !== undefined) frameId = state.frameId ?? getStep()?.frames[0].id ?? null;
  if (state.display) display = state.display; if (state.selected) selected = state.selected; if (state.explosion !== undefined) explosion = state.explosion;
  const frameIndex = project ? frameQueue(project).findIndex(item => item.frame.id === getFrame()?.id) : -1;
  if (state.frameProgress !== undefined && frameIndex >= 0) scrubTo(frameIndex + state.frameProgress, false);
  else { render(); if (navigates) { const camera = getFrame()?.camera; if (camera) view.setCamera(camera); else if (getStep()?.partIds.length) view.fit(getStep()?.partIds, 1.1); } }
  if (state.section !== undefined || state.sectionNormal) setSectionValue(state.section ?? session().section, false, state.sectionNormal);
  if (selected[0]) revealPart(selected[0]);
}
function canAutoExplode(current: Project, step?: AssemblyStep): boolean {
  return !!step?.partIds.some(id => !findPart(current, id).initiallyAssembled && !step.groups.find(group => group.partIds.includes(id))?.sourceStepId);
}
function render(): void {
  timelinePosition = undefined;
  element('#returnButton').hidden = !getStep(); element('#footerReturn').hidden = !getStep(); element<HTMLButtonElement>('#clearAllSteps').disabled = !project?.steps.length;
  element('#emptyState').hidden = !!project; element<HTMLButtonElement>('#syncButton').disabled = !project; element<HTMLButtonElement>('#addStep').disabled = !project;
  overviewUnassembled.disabled = !project;
  updateStructureActions();
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === view.tool));
  element('#projectTitle').textContent = project?.name ?? 'ManualStudio'; element<HTMLButtonElement>('#undoButton').disabled = !undo.length; element<HTMLButtonElement>('#redoButton').disabled = !redo.length;
  const step = getStep(), canEditPose = !!project;
  for (const id of ['saveButton', 'exportButton', 'settingsButton']) element<HTMLButtonElement>('#' + id).disabled = !project;
  element<HTMLButtonElement>('#explodeButton').disabled = !project || !canAutoExplode(project, step);
  element<HTMLButtonElement>('#homePoseButton').disabled = !canEditPose || !!step?.final && getFrame()?.kind === 'end';
  for (const tool of ['move', 'rotate']) element<HTMLButtonElement>(`[data-tool="${tool}"]`).disabled = !canEditPose;
  if (!project) return;
  element('#rightStack').classList.toggle('overall', !step); element('#playbar').hidden = !step; element('.bottom-controls').hidden = !!step; element('#guide').hidden = !step; element('#materialBar').innerHTML = project.model.materials.map((color, i) => `<button class="material-swatch" style="background:${esc(color)};color:${parseInt(color.slice(1, 7), 16) < 0x666666 ? '#ddd' : '#222'}" data-material="${i}" title="${esc(project!.model.materialNames?.[i] ?? `Select material ${i + 1}`)}">${i + 1}</button>`).join('');
  renderStructure(); renderParts(); renderGuide(); renderScene(); renderNoteEditor();
  const localPlay = document.querySelector<HTMLButtonElement>('#playStep'); if (localPlay) localPlay.disabled = !step?.partIds.length;
  const queue = frameQueue(project); element<HTMLInputElement>('#playSlider').max = String(Math.max(queue.length - 1, 1)); const index = queue.findIndex(item => item.frame.id === getFrame()?.id); element<HTMLInputElement>('#playSlider').value = String(Math.max(index, 0)); element('#frameNumber').textContent = `${Math.max(index + 1, 1)}/${queue.length}`;
  element<HTMLInputElement>('#explosionRange').value = String(explosion); element<HTMLInputElement>('#explosionValue').value = explosion.toFixed(2); element<HTMLSelectElement>('#displayMode').value = display;
}
function renderScene(frameOverride?: Keyframe): void {
  if (!project) return; const step = getStep(); let frame = frameOverride ?? getFrame();
  if (frame && editedPoses) frame = { ...frame, poses: editedPoses };
  if (picking && step?.id === picking.stepId) {
    const preview = copy(project); pickerCommands(project, picking).forEach(command => applyCommand(preview, command)); const previewStep = findStep(preview, step.id); view.show(preview, previewStep, previewStep.frames.find(f => f.id === frame?.id) ?? previewStep.frames[0], 'xray');
  } else view.show(project, step, frame, step ? display : 'all', explosion, overviewUnassembled.checked);
  if (!step && overviewUnassembled.checked) {
    const visible = selected.filter(id => view.meshes.get(id)?.visible);
    if (visible.length !== selected.length) {
      selected = visible;
      updateTreeSelection(); updateSelectionInfo(); sendSession();
    }
  }
  view.select(selected); if (selectedAxis) view.selectAxis(selectedAxis); const state = session(); view.setSection(state.section);
}
function toggleSearch(kind: 'structure' | 'list'): void {
  const isStructure = kind === 'structure';
  const row = element(isStructure ? '#structureSearchRow' : '#searchRow');
  const input = element<HTMLInputElement>(isStructure ? '#structureSearch' : '#partSearch');
  const button = element(isStructure ? '#structureSearchButton' : '#searchButton');
  row.hidden = !row.hidden; button.classList.toggle('active', !row.hidden); button.setAttribute('aria-expanded', String(!row.hidden));
  if (!row.hidden) { panels.setExpanded(element(isStructure ? '#structurePanel' : '#listPanel'), true); input.focus({ preventScroll: true }); }
  else { input.value = ''; if (isStructure) { structureQuery = ''; renderStructure(); } else { query = ''; renderParts(); } }
}

function renderStructure(): void {
  stepReorder.cancel();
  if (!project) return; const scroll = element('#structure').scrollTop;
  const filter = structureQuery.trim().toLocaleLowerCase();
  const matches = project.steps.map((step, index) => ({ step, index })).filter(({ step, index }) => {
    const parts = step.partIds.map(id => findPart(project!, id));
    const searchable = [`Step ${index + 1}`, step.name, step.description, ...step.groups.map(group => group.name), ...parts.flatMap(part => [part.name, part.path, part.materialName ?? '', part.appearanceName ?? ''])].join(' ').toLocaleLowerCase();
    return !!merging || !filter || searchable.includes(filter);
  });
  const cards = matches.map(({ step, index }) => {
    const inherited = new Set(step.groups.flatMap(group => group.partIds));
    const labels = [...step.groups.map(group => ({ name: group.name, source: group.sourceStepId })), ...step.partIds.filter(id => !inherited.has(id)).map(id => ({ name: findPart(project!, id).name, source: undefined }))];
    const chips = labels.slice(0, 2).map(item => `<span class="chip ${item.source ? 'assembly' : ''}" ${item.source ? `data-assembly="${esc(item.source)}" draggable="true"` : ''} title="${esc(item.name)}">${esc(item.name)}</span>`).join('') + (labels.length > 2 ? `<span class="chip chip-overflow" title="${esc(labels.slice(2).map(item => item.name).join('\n'))}">…</span>` : '');
    const title = /^Step\s*\d+$/.test(step.name) ? 'Install parts' : step.name;
    if (step.final) return `<div class="insert-step-gap" data-reorder-before="${esc(step.id)}" aria-label="Insert before Final assembly"><button data-insert-before="${esc(step.id)}" title="Insert an ordinary step before Final assembly">＋ Insert Step</button></div><article class="step-card ${step.id === stepId ? 'active' : ''}" data-step="${esc(step.id)}"><div class="step-card-top"><span class="step-tag" draggable="false" title="Whole-model summary; always last">Final assembly</span><span class="card-actions"><button data-refresh-final="${esc(step.id)}" title="Refresh final assembly">${icon('finalPose')}</button><button data-delete-step="${esc(step.id)}" title="Remove final assembly summary">${icon('trash')}</button></span></div><h3 data-rename-step="${esc(step.id)}" title="Double-click to rename">${esc(title)}<span class="step-count">(${step.partIds.length})</span></h3><div class="step-chip-row" title="All active source parts with their latest completed poses"><span class="chip">Whole model</span><span class="chip">Updated automatically</span></div></article>`;
    return `<div class="insert-step-gap" data-reorder-before="${esc(step.id)}" aria-label="Insert before Step ${index + 1}"><button data-insert-before="${esc(step.id)}" title="Insert a new step before this step">＋ Insert Step</button></div><article class="step-card ${step.id === stepId ? 'active' : ''}" data-step="${esc(step.id)}"><div class="step-card-top"><span class="step-tag" draggable="${filter ? 'false' : 'true'}" title="${filter ? 'Clear search to reorder steps' : 'Drag into a gap to reorder'}" data-reorder="${esc(step.id)}">${step.final ? 'Final assembly' : `Step ${index + 1}`}</span><span class="card-actions"><button data-copy="${esc(step.id)}" title="Copy and inherit this step" ${step.partIds.length ? '' : 'disabled'}>${icon('copy')}</button><button data-delete-step="${esc(step.id)}" title="Delete current step">${icon('trash')}</button><button data-drop-step="${esc(step.id)}" title="Add objects to this step">${icon('objects')}</button></span></div><h3 data-rename-step="${esc(step.id)}" title="Double-click to rename">${esc(title)}<span class="step-count">(${step.partIds.length})</span></h3>${labels.length ? `<div class="step-chip-row" data-drop-step="${esc(step.id)}" data-assembly="${esc(step.id)}" draggable="true" title="Drag this completed assembly into a later step; click to edit its objects">${chips}</div>` : `<div class="step-drop" data-drop-step="${esc(step.id)}">Click to add objects to the current step</div>`}</article>`;
  }).join('');
  element('#structure').innerHTML = `<div class="step-card overview ${stepId ? '' : 'active'}" data-overview><div class="step-card-top"><span class="step-tag">Default</span></div><h3>Overall preview<span class="step-count">(1)</span></h3><div class="step-chip-row overview-contents"><span class="chip-prefix">Contain</span><span class="chip" title="${esc(project.model.name)}">${esc(project.model.name)}</span></div></div>${cards}${filter && !matches.length ? '<p class="structure-empty" role="status">No matching steps</p>' : ''}${project.steps.some(step => step.final) ? '' : '<div class="insert-step-gap step-reorder-end" data-reorder-before="" aria-label="Move step to end"></div>'}`;
  element('#structure').scrollTop = scroll;
  element('#structureSearchCount').textContent = `${matches.length} / ${project.steps.length}`;
  if (merging) for (const card of element('#structure').querySelectorAll<HTMLElement>('[data-step]')) {
    const id = card.dataset.step!;
    card.querySelector('.card-actions')!.innerHTML = `<input type="checkbox" data-merge-step="${esc(id)}" aria-label="Merge ${esc(findStep(project, id).name)}" ${merging.has(id) ? 'checked' : ''}>`;
    card.querySelectorAll<HTMLElement>('[draggable]').forEach(handle => { handle.draggable = false; });
  }
  element('#structure').classList.toggle('merging-steps', !!merging); updateStructureActions();
}
function updateStructureActions(): void {
  const canMerge = !!getStep() && (project?.steps.length ?? 0) >= 2;
  const merge = element<HTMLButtonElement>('#mergeSteps'); merge.hidden = !!merging || !canMerge; merge.disabled = !canMerge;
  const selection = element<HTMLButtonElement>('#selectionStep'); selection.hidden = !!merging || selected.length < 2; selection.disabled = selected.length < 2;
  element('#addStep').hidden = !!merging; element('#footerReturn').hidden = !!merging || !getStep(); element('#mergeControls').hidden = !merging;
  element<HTMLInputElement>('#structureSearch').disabled = !!merging; element<HTMLButtonElement>('#structureSearchButton').disabled = !!merging;
  if (!merging || !project) return;
  const sources = project.steps.filter(step => merging!.has(step.id)), complete = mergeCoversWholeModel(project, sources);
  const all = element<HTMLInputElement>('#mergeAll'); all.checked = sources.length === project.steps.length; all.indeterminate = sources.length > 0 && sources.length < project.steps.length;
  const full = project.steps.filter(step => !step.final).length >= MAX_ORDINARY_STEPS, previousFinal = project.steps.some(step => step.final), needsSlot = !complete || previousFinal;
  const confirm = element<HTMLButtonElement>('#confirmMerge'); confirm.disabled = sources.length < 2 || needsSlot && full;
  confirm.title = needsSlot && full ? `Preserving all source steps requires an available ordinary-step slot (maximum ${MAX_ORDINARY_STEPS}).` : 'Merge selected cards and keep all source steps';
  element('#mergeResult').textContent = complete ? previousFinal ? 'Keep previous Final as a step; add Final assembly' : 'Add Final assembly; original steps remain' : 'Add Merged Step; original steps remain';
}
function beginMerge(): void {
  if (!project || !getStep() || project.steps.length < 2) return;
  stopPlayback(); picking = undefined; document.querySelector('.object-picker')?.remove(); merging = new Set(); renderStructure(); renderScene();
}
function cancelMerge(): void { merging = undefined; renderStructure(); }
async function confirmMerge(): Promise<void> {
  if (!project || !merging || merging.size < 2) return;
  await commit([{ type: 'step.merge', stepIds: [...merging], camera: view.cameraState() }], 'step');
  merging = undefined; selected = []; render(); if (getFrame()?.camera) view.setCamera(getFrame()!.camera); sendSession();
  if (stepId) element('#structure').querySelector(`[data-step="${CSS.escape(stepId)}"]`)?.scrollIntoView({ block: 'nearest' });
}
function assemblyState(ids: string[], assembled: ReadonlySet<string>): { label: string; warning: boolean } {
  if (!project || !ids.length) return { label: '', warning: false };
  const steps = project.steps.flatMap((step, i) => !step.final && step.partIds.some(id => ids.includes(id)) ? [i + 1] : []);
  const used = ids.filter(id => assembled.has(id)).length;
  if (!used) return { label: 'Unassembled', warning: true };
  const label = steps.length === 1 ? `Step${steps[0]}` : steps.join('/');
  return { label: used < ids.length ? `${label || 'Initial'}/Not` : label || 'Assembled', warning: used < ids.length };
}
function visibilityButton(node: ModelTreeNode, effective: boolean, label = node.name): string {
  return `<button class="visibility-toggle ${effective ? '' : 'is-hidden'}" data-eye="${esc(node.id)}" aria-label="${effective ? 'Hide' : 'Show'} ${esc(label)}" aria-pressed="${effective}" title="${effective ? 'Hide' : 'Show'} ${esc(label)}">${icon(effective ? 'eye' : 'eyeOff')}</button>`;
}
function partRow(part: Part, state: string, checkbox: boolean, node: ModelTreeNode, visible: boolean): string {
  const pose = getFrame()?.poses[part.id]; const exploded = pose && new Vector3(...pose.position).distanceTo(new Vector3(...part.home.position)) > .001;
  return `<div class="part-row ${selected.includes(part.id) ? 'selected' : ''} ${visible ? '' : 'object-hidden'}" data-part="${esc(part.id)}" role="option" aria-selected="${selected.includes(part.id)}" tabindex="-1" draggable="${!checkbox}" title="${esc([part.path, part.materialName && `Material: ${part.materialName}`, part.appearanceName && `Appearance: ${part.appearanceName}`].filter(Boolean).join('\n'))}">${checkbox ? `<input type="checkbox" data-check-part="${esc(part.id)}" ${picking?.ids.has(part.id) ? 'checked' : ''} aria-label="Add ${esc(part.name)}">` : ''}<canvas class="part-thumb" data-thumb="${esc(part.id)}"></canvas><span class="part-name"><span class="part-name-text" ${checkbox ? '' : `data-rename-part="${esc(part.id)}"`}>${esc(part.name)}</span>${part.materialName ? `<small class="part-material">${esc(part.materialName)}</small>` : ''}</span>${project?.settings.showExplosionColumn && !checkbox ? `<button class="explosion-toggle ${exploded ? 'active' : ''}" data-explode-part="${part.id}" title="Toggle explosion state" ${pose ? '' : 'disabled'}>${icon('explosion')}</button>` : ''}${checkbox ? '' : visibilityButton(node, visible, part.name)}${part.sourceStatus === 'removed' ? '<span class="part-state removed">Source removed</span>' : state}</div>`;
}
function treeMarkup(checkbox = false): string {
  if (!project) return ''; const current = project, visibility = modelVisibility(current), text = (checkbox ? pickerQuery : query).toLowerCase();
  const parts = new Map(current.model.parts.map(part => [part.id, part]));
  const axes = new Map((current.model.constructionAxes ?? []).map(axis => [axis.id, axis]));
  const assembled = assembledPartIds(current);
  const stateMarkup = (ids: string[]): string => {
    const state = assemblyState(ids, assembled);
    return `<span class="part-state ${state.warning ? 'unassembled' : 'assembled'}">${state.label}</span>`;
  };
  const matches = (value: string): boolean => !text || value.toLowerCase().includes(text);
  const renderNode = (node: ModelTreeNode, ancestorMatch = false): string => {
    if (node.partId) {
      const part = parts.get(node.partId); if (!part || checkbox && part.sourceStatus !== 'active') return '';
      if (!ancestorMatch && !matches(`${part.name} ${part.path} ${part.materialName ?? ''} ${part.appearanceName ?? ''}`) || (checkbox ? pickerUnassembledOnly : unassembledOnly) && assembled.has(part.id)) return '';
      return partRow(part, stateMarkup([part.id]), checkbox, node, visibility.parts.get(part.id) ?? true);
    }
    if (node.axisId) {
      const axis = axes.get(node.axisId); if (!axis || checkbox || unassembledOnly || !ancestorMatch && !matches(`${axis.name} ${axis.componentPath}`)) return '';
      const visible = visibility.axes.get(axis.id) ?? false;
      return `<div class="axis-row ${selectedAxis === axis.id ? 'selected' : ''} ${visible ? '' : 'object-hidden'}" data-axis="${esc(axis.id)}" role="option" aria-selected="${selectedAxis === axis.id}" tabindex="-1" title="${esc(axis.componentPath)}"><span class="axis-glyph">${icon('axis')}</span><span class="part-name" data-rename-axis="${esc(axis.id)}">${esc(axis.name)}</span>${visibilityButton(node, visible)}<span class="part-state axis-type">Axis</span></div>`;
    }
    const childMatch = ancestorMatch || !!text && matches(node.name), children = (node.children ?? []).map(child => renderNode(child, childMatch)).join('');
    if (!children && (text || unassembledOnly || checkbox)) return '';
    const ids = nodePartIds(node).filter(id => parts.get(id)?.sourceStatus === 'active'), checked = !!ids.length && ids.every(id => picking?.ids.has(id));
    const open = !!text || (checkbox ? treeExpansion.get(`picker:${node.id}`) : treeExpansion.get(node.id)) === true;
    return `<details class="tree-group object-node" data-tree-node="${esc(node.id)}" ${open ? 'open' : ''}><summary class="object-row ${ids.length && ids.every(id => selected.includes(id)) ? 'selected' : ''} ${visibility.objects.get(node.id) === false ? 'object-hidden' : ''}"><span class="tree-caret" aria-hidden="true"></span>${checkbox ? `<input type="checkbox" data-check-object="${esc(node.id)}" ${checked ? 'checked' : ''} aria-label="Add ${esc(node.name)}">` : ''}<button class="object-name" data-select-object="${esc(node.id)}" ${checkbox ? '' : `data-rename-object="${esc(node.id)}"`} title="${esc(node.componentPath ?? node.name)}">${esc(node.name)}</button>${checkbox ? '' : visibilityButton(node, visibility.objects.get(node.id) ?? true)}${stateMarkup(ids)}</summary><div class="tree-children">${children}</div></details>`;
  };
  const open = checkbox || !!text || treeExpansion.get('model-root') !== false;
  return `<details class="tree-group model-root" data-tree-node="model-root" ${open ? 'open' : ''}><summary class="model-row"><span class="tree-caret" aria-hidden="true"></span>${checkbox ? `<input type="checkbox" data-picker-all aria-label="Add Model" ${current.model.parts.filter(part => part.sourceStatus === 'active').every(part => picking?.ids.has(part.id)) ? 'checked' : ''}>` : ''}<span>Model</span></summary><div class="tree-children">${browserRoots(current.model).map(node => renderNode(node)).join('')}</div></details>`;
}
function rememberTreeExpansion(tree: HTMLElement, prefix = ''): void { tree.querySelectorAll<HTMLDetailsElement>('details[data-tree-node]').forEach(node => treeExpansion.set(prefix + node.dataset.treeNode!, node.open)); }
function renderParts(): void {
  if (!project) return; const tree = element('#partTree'), scroll = tree.scrollTop; if (tree.dataset.searching !== 'true') rememberTreeExpansion(tree);
  tree.innerHTML = treeMarkup(); tree.scrollTop = scroll; tree.dataset.searching = String(!!query.trim()); updateTreeToggle();
  element('#filterButton').classList.toggle('active', unassembledOnly); element('#filterButton').innerHTML = icon(unassembledOnly ? 'filterActive' : 'filter'); queueThumbnails();
}
function updateTreeToggle(): void {
  const nodes = [...document.querySelectorAll<HTMLDetailsElement>('#partTree details[data-tree-node]')], expanded = nodes.length > 0 && nodes.every(node => node.open);
  const button = element<HTMLButtonElement>('#expandAll'); button.textContent = expanded ? 'Collapse tree' : 'Expand tree';
  button.title = expanded ? 'Collapse all objects' : 'Expand all objects'; button.setAttribute('aria-label', button.title); button.setAttribute('aria-expanded', String(expanded)); button.disabled = !nodes.length;
}
function selectAxis(id: string, focus = false): void {
  if (!project?.model.constructionAxes?.some(axis => axis.id === id)) return;
  panels.setExpanded(element('#listPanel'), true);
  selected = []; selectedAxis = id; view.select([]); view.selectAxis(id, focus); updateTreeSelection(); updateSelectionInfo();
  let row = document.querySelector<HTMLElement>(`#partTree [data-axis="${CSS.escape(id)}"]`); if (!row) { query = ''; unassembledOnly = false; element<HTMLInputElement>('#partSearch').value = ''; renderParts(); row = document.querySelector<HTMLElement>(`#partTree [data-axis="${CSS.escape(id)}"]`); } let parent = row?.parentElement;
  while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; } row?.scrollIntoView({ block: 'nearest' });
}
function updateTreeSelection(): void {
  document.querySelectorAll<HTMLElement>('#partTree [data-part]').forEach(row => { const active = selected.includes(row.dataset.part!); row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll<HTMLElement>('#partTree [data-axis]').forEach(row => { const active = row.dataset.axis === selectedAxis; row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll<HTMLElement>('#partTree [data-select-object]').forEach(button => {
    const node = project && findBrowserNode(project.model, button.dataset.selectObject!); const ids = node ? nodePartIds(node) : [];
    button.closest('.object-row')?.classList.toggle('selected', !!ids.length && ids.every(id => selected.includes(id)));
  });
}
function browserNodePath(id: string): ModelTreeNode[] {
  if (!project) return [];
  const find = (nodes: ModelTreeNode[], parents: ModelTreeNode[]): ModelTreeNode[] => { for (const node of nodes) { const path = [...parents, node]; if (node.id === id) return path; const result = find(node.children ?? [], path); if (result.length) return result; } return []; };
  return find(browserRoots(project.model), []);
}
async function toggleNodeVisibility(id: string): Promise<void> {
  if (!project) return; const node = findBrowserNode(project.model, id); if (!node) return;
  const effective = modelVisibility(project), visible = node.partId ? effective.parts.get(node.partId) : node.axisId ? effective.axes.get(node.axisId) : effective.objects.get(node.id);
  const show = !(visible ?? nodeOwnVisibility(project, node)), patch: Partial<Settings> = {};
  const objects = { ...project.settings.objectVisibility };
  if (show) view.setVisibility(nodePartIds(node), true);
  if (show) browserNodePath(id).filter(parent => parent.kind === 'object').forEach(parent => { objects[parent.id] = true; });
  if (node.kind === 'object') objects[node.id] = show;
  patch.objectVisibility = objects;
  if (node.partId) patch.partVisibility = { ...project.settings.partVisibility, [node.partId]: show };
  if (node.axisId) { patch.constructionAxisVisibility = { ...project.settings.constructionAxisVisibility, [node.axisId]: show }; if (show) patch.showConstructionAxes = true; }
  await commit([{ type: 'settings.update', patch }]);
}

function queueThumbnails(): void {
  thumbnailObserver?.disconnect(); thumbnailObserver = new IntersectionObserver(entries => { entries.filter(entry => entry.isIntersecting).forEach(entry => { const canvas = entry.target; if (!(canvas instanceof HTMLCanvasElement) || !project) return; const part = project.model.parts.find(p => p.id === canvas.dataset.thumb); if (part) view.thumbnail(part, canvas); thumbnailObserver?.unobserve(canvas); }); }, { rootMargin: '100px' });
  document.querySelectorAll<HTMLCanvasElement>('[data-thumb]').forEach(canvas => thumbnailObserver?.observe(canvas));
}
function selectPart(id: string, multiple = false, individual = false, fromViewport = false): void {
  selectedAxis = undefined;
  document.querySelectorAll('#partTree .axis-row.selected').forEach(row => row.classList.remove('selected'));
  if (!project) return; const part = findPart(project, id); let ids = [id];
  if (!individual) {
    const group = getStep()?.groups.find(g => g.partIds.includes(id));
    if (group) ids = group.partIds;
    else if (view.selectionMode === 'object') ids = project.model.parts.filter(p => p.objectId === part.objectId).map(p => p.id);
  }
  if (fromViewport && !getStep() && overviewUnassembled.checked) {
    ids = ids.filter(value => view.meshes.get(value)?.visible);
    selected = selected.filter(value => view.meshes.get(value)?.visible);
  }
  if (multiple) { const set = new Set(selected); ids.forEach(value => set.has(value) ? set.delete(value) : set.add(value)); selected = [...set]; } else selected = [...ids];
  rangeAnchorId = id; view.select(selected); revealPart(id); updateTreeSelection(); updateSelectionInfo(); sendSession();
}
function visibleListOrder(): string[] { return [...document.querySelectorAll<HTMLElement>('#partTree [data-part]')].filter(row => row.getClientRects().length > 0 && !row.hidden).map(row => row.dataset.part!); }
function focusListRow(id: string): void { focusedListId = id; document.querySelector<HTMLElement>(`#partTree [data-part="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
function selectListRange(id: string, additive = false): void { selectedAxis = undefined; selected = rangeSelection(visibleListOrder(), rangeAnchorId ?? selected.at(-1), id, selected, additive); view.select(selected); revealPart(id); focusListRow(id); updateSelectionInfo(); sendSession(); }
function revealPart(id: string): void {
  panels.setExpanded(element('#listPanel'), true);
  let row = document.querySelector<HTMLElement>(`#partTree [data-part="${CSS.escape(id)}"]`);
  if (!row) { query = ''; unassembledOnly = false; element<HTMLInputElement>('#partSearch').value = ''; renderParts(); row = document.querySelector<HTMLElement>(`#partTree [data-part="${CSS.escape(id)}"]`); }
  let parent = row?.parentElement; while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
  document.querySelectorAll<HTMLElement>('#partTree [data-part]').forEach(item => { const active = selected.includes(item.dataset.part!); item.classList.toggle('selected', active); item.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll<HTMLDetailsElement>('#partTree details[data-tree-node]').forEach(details => { const node = project && findBrowserNode(project.model, details.dataset.treeNode!); const ids = node ? nodePartIds(node) : []; details.querySelector(':scope > summary')?.classList.toggle('selected', !!ids.length && ids.every(partId => selected.includes(partId))); });
  row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function updateSelectionInfo(): void {
  updateStructureActions(); document.querySelector('.selection-info')?.remove(); if (!project || !selected.length || getStep()) return;
  const part = findPart(project, selected[0]); const size = part.bounds[1].map((v, i) => (v - part.bounds[0][i]).toFixed(2));
  const geometry = view.geometries.get(part.id)!; let volume = geometry.userData.volume as number | undefined;
  if (volume === undefined) { const position = geometry.getAttribute('position'), index = geometry.getIndex()!; const a = new Vector3(), b = new Vector3(), c = new Vector3(); volume = 0; for (let i = 0; i < index.count; i += 3) { a.fromBufferAttribute(position, index.getX(i)); b.fromBufferAttribute(position, index.getX(i + 1)); c.fromBufferAttribute(position, index.getX(i + 2)); volume += a.dot(b.cross(c)) / 6; } volume = Math.abs(volume); geometry.userData.volume = volume; }
  const info = document.createElement('div'); info.className = 'selection-info'; info.innerHTML = `Assembly Info<br>${esc(part.name)}${selected.length > 1 ? ` + ${selected.length - 1}` : ''}${part.materialName ? `<br>Material: ${esc(part.materialName)}` : ''}${part.appearanceName ? `<br>Appearance: ${esc(part.appearanceName)}` : ''}<br>Volume: ${volume.toFixed(2)} mm³<br>Size: ${size.join(' × ')} mm`; element('.workspace').append(info);
}
function openStep(id: string | null): void {
  stopPlayback(); picking = undefined; element<HTMLInputElement>('#sectionRange').value = '0'; element<HTMLInputElement>('#sectionValue').value = '0.00'; element('#sectionLabel').hidden = false; element('#resetSectionDirection').hidden = true; document.querySelector('.object-picker')?.remove(); activeNoteId = undefined; editedPoses = undefined; explosion = 1; stepId = id; frameId = getStep()?.frames[0].id ?? null; selected = []; view.setTool('select'); render(); if (getFrame()?.camera) view.setCamera(getFrame()?.camera); else if (getStep()?.partIds.length) view.fit(getStep()?.partIds, 1.1); sendSession();
}
function openFrame(id: string): void { stopPlayback(); frameId = id; editedPoses = undefined; activeNoteId = undefined; render(); view.setCamera(getFrame()?.camera); sendSession(); }
function renderGuide(): void {
  const step = getStep(), frame = getFrame(); if (!project || !step || !frame) return;
  const labels = frameLabels(project, frame);
  const activeNote = frame.notes.find(note => note.id === activeNoteId);
  const noteKind = activeNote?.kind ?? view.tool;
  const colorControl = isShapeNote(noteKind)
    ? noteColorPalette('noteColor', 'color', activeNote?.color ?? shapeNoteColor, activeNote?.id)
    : '<div class="guide-field"><input type="color" id="noteColor" value="' + (noteKind === 'glue' ? glueColor : noteColor) + '" title="Annotation color"><span>3D surface attachment</span></div>';
  const backgroundControl = activeNote || isShapeNote(noteKind) || noteKind === 'text'
    ? noteColorPalette('noteBackground', 'background', activeNote?.background ?? noteBackground, activeNote?.id)
    : '';
  const guide = element('#guide'), scroll = guide.querySelector('.guide-content')?.scrollTop ?? 0, timelineScroll = guide.querySelector('.timeline')?.scrollLeft ?? 0;
  guide.innerHTML = `<header class="panel-header"><span class="row"><button class="icon panel-toggle" id="collapseGuide" data-panel-toggle="guide" title="Collapse Assembly Guide">${icon('collapsePanel')}</button><span>Assembly Guide</span></span></header><div class="panel-body" id="guideBody"><div class="guide-content">
  <section class="guide-section"><h4>Connection Type</h4><div class="connection-buttons">${(['clip', 'glue', 'screw', 'remove'] as const).map(kind => `<button class="connection-button ${view.tool === kind ? 'active' : ''}" data-tool="${kind}" title="Add ${kind}"><span>${icon(kind)}</span>${kind === 'remove' ? 'Remove · 拆除' : kind[0].toUpperCase() + kind.slice(1)}</button>`).join('')}</div></section>
  <section class="guide-section"><h4>Add Notes</h4><div class="note-buttons">${['rectangle', 'circle', 'arrow', 'text', 'pencil'].map(kind => `<button data-tool="${kind}" title="Add ${kind}" class="${view.tool === kind ? 'active' : ''}">${icon(kind)}</button>`).join('')}</div><div class="guide-field"><span>Snap to</span><select id="anchorTarget"><option value="point">Surface point</option><option value="part">Part / entity</option><option value="face">Connected face</option><option value="band">Cylinder segment</option></select></div>
  ${view.tool === 'glue' ? `<div class="guide-field"><span>Paint</span><select id="glueMode"><option value="face">Whole face</option><option value="circle">Circle patch</option><option value="band">Cylinder band</option><option value="brush">Surface brush</option></select></div><div class="guide-field"><span>Radius (mm)</span><input id="brushRadius" type="number" min=".1" step=".5" value="${view.pickSettings.radius}"><span>Band (mm)</span><input id="bandWidth" type="number" min=".1" step=".5" value="${view.pickSettings.width}"></div><div class="guide-field"><span>Band axis</span><select id="bandAxis"><option value="auto">From surface</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select><button id="newGlueNote" title="Start a separate glue annotation">New region set</button></div><div class="small muted" style="margin-top:8px">Click multiple areas to add them to one glue operation.</div>` : ''}
  ${view.tool === 'remove' ? `<label class="guide-field"><input type="checkbox" id="removeWhole" ${removeWholePart ? 'checked' : ''}>Remove the whole part at the end frame</label>` : ''}
  ${colorControl}${backgroundControl}</section>
  <section class="guide-section"><h4 class="row spread">Label <button id="labelSettings" class="icon" title="Label settings">${icon('settings')}</button></h4><label class="guide-field"><input id="showLabels" type="checkbox" ${labels.showLabels ? 'checked' : ''}>Show Object / Part labels</label>${frame.labels ? '<div class="small muted">Current frame labels</div>' : ''}<div class="row" style="margin-top:7px"><button id="autoLabels" class="small">Auto layout</button><button id="labelReset" class="small">Reset closed labels</button><button id="labelPositions" class="small">Label positions…</button></div></section>
  <section class="guide-section"><h4 class="row spread">Timeline <button id="playStep" title="Play this step">${icon('play')}</button></h4><div class="timeline">${step.frames.map(f => `<div class="frame-card ${f.id === frame.id ? 'active' : ''}" data-frame="${f.id}" title="${esc(f.name)}">${f.image ? `<img src="${f.image}" alt="${esc(f.name)}">` : `<div class="frame-placeholder">${icon(f.kind === 'start' ? 'explosion' : f.kind === 'end' ? 'finalPose' : 'cameraAll')}</div>`}${esc(f.name)}${f.kind === 'transition' ? `<button class="delete-frame" data-delete-frame="${f.id}" title="Delete keyframe">${icon('close')}</button>` : ''}</div>`).join('')}</div><div class="timeline-actions"><button id="addFrame">＋ Keyframe</button><button id="frameSettings">Frame settings…</button><button id="saveFrame">${icon('save')} Save update</button><button id="cameraAll" title="Apply current camera to all frames">${icon('cameraAll')} Camera → all</button></div><label class="guide-field"><span>${frame.kind === 'start' ? 'Completed-step hold (s)' : 'Transition duration (s)'}</span><input type="number" id="frameDuration" min=".1" step=".1" value="${frame.duration}"></label></section>
  <section class="guide-section"><h4>Step details</h4><textarea id="stepDescription" rows="2" style="width:100%" placeholder="Assembly instructions…">${esc(step.description)}</textarea><div class="row" style="margin-top:8px"><button id="initialAssembly" class="small">Mark selected initially assembled</button><button id="selectedProperties" class="small">Part…</button><button id="moveAlongAxis" class="small">Move along axis…</button></div></section></div></div>`;
  element('.guide-content').scrollTop = scroll; element<HTMLSelectElement>('#anchorTarget').value = view.pickSettings.target;
  const timeline = guide.querySelector('.timeline')?.closest('section'); if (timeline) { element('#guideBody').append(timeline); const strip = timeline.querySelector('.timeline'); if (strip) strip.scrollLeft = timelineScroll; }
  panels.sync(guide);
  element<HTMLButtonElement>('#playStep').disabled = !step.partIds.length;
  element<HTMLButtonElement>('#playStep').disabled = !step.partIds.length;
  const glueMode = document.querySelector<HTMLSelectElement>('#glueMode'); if (glueMode) glueMode.value = view.pickSettings.region;
  const axis = document.querySelector<HTMLSelectElement>('#bandAxis'); if (axis) axis.value = view.pickSettings.axis;
}
function setTool(tool: ViewTool): void {
  if (!getStep() && !['select', 'move', 'rotate', 'measure'].includes(tool)) { toast('Create or select an assembly step first.'); return; }
  const note = getFrame()?.notes.find(item => item.id === activeNoteId);
  view.setTool(tool); if (tool !== 'glue' || note && note.kind !== 'glue') activeNoteId = undefined; renderGuide(); document.querySelectorAll<HTMLElement>('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === tool)); renderNoteEditor();
  if (tool === 'align') toast('Choose the moving part’s point or face, then the target. Use “Snap to” to choose point or face alignment.');
}
async function addNote(anchors: Anchor[], kind: NoteKind): Promise<void> {
  const step = getStep(), frame = getFrame(); if (!project || !step || !frame) return;
  if (anchors.some(anchor => !step.partIds.includes(anchor.partId))) { toast('Add the target part to this step first. Drag it into the step card or use the object list.'); return; }
  const existing = kind === 'glue' ? frame.notes.find(note => note.id === activeNoteId && note.kind === 'glue') : undefined;
  const pending = kind === 'glue' && glueOperation?.projectId === project.id && glueOperation.stepId === step.id && glueOperation.frameId === frame.id && glueOperation.noteId === activeNoteId ? glueOperation.noteId : undefined;
  const context = { projectId: project.id, stepId: step.id, frameId: frame.id, noteId: existing?.id ?? pending ?? uid('note') };
  const captured = copy(anchors), removeParts = kind === 'remove' && removeWholePart;
  const color = isShapeNote(kind) ? shapeNoteColor : kind === 'glue' ? glueColor : kind === 'remove' ? '#ef7665' : noteColor;
  const initial: Note = { id: context.noteId, kind, text: noteText, color, background: noteBackground, size: view.pickSettings.radius, anchors: [], offset: [30, -40] };
  activeNoteId = context.noteId; if (kind === 'glue') glueOperation = context;
  await commit(current => {
    if (current.id !== context.projectId) return [];
    const latestStep = current.steps.find(candidate => candidate.id === context.stepId), latestFrame = latestStep?.frames.find(candidate => candidate.id === context.frameId);
    if (!latestStep || !latestFrame) throw new Error('The annotation target frame no longer exists.');
    if (captured.some(anchor => !latestStep.partIds.includes(anchor.partId))) throw new Error('The annotation target part is no longer in this step.');
    const previous = kind === 'glue' ? latestFrame.notes.find(note => note.id === context.noteId && note.kind === 'glue') : undefined;
    const note: Note = { ...copy(previous ?? initial), anchors: [...(previous?.anchors ?? []), ...captured] };
    const commands: Command[] = [{ type: 'note.put', stepId: context.stepId, frameId: context.frameId, note }];
    if (removeParts) commands.push({ type: 'part.remove', stepId: context.stepId, partIds: [...new Set(captured.map(anchor => anchor.partId))], value: true });
    return commands;
  });
  if (project?.id === context.projectId && stepId === context.stepId && getFrame()?.id === context.frameId && activeNoteId === context.noteId) renderNoteEditor();
}
async function updateNoteAnchors(noteId: string, update: (anchors: Anchor[]) => void): Promise<void> {
  const step = getStep(), frame = getFrame(); if (!project || !step || !frame) return;
  const context = { projectId: project.id, stepId: step.id, frameId: frame.id };
  await commit(current => {
    if (current.id !== context.projectId) return [];
    const note = copy(findFrame(findStep(current, context.stepId), context.frameId).notes.find(candidate => candidate.id === noteId));
    if (!note) throw new Error('The annotation is no longer present.');
    update(note.anchors);
    return note.anchors.length ? [{ type: 'note.put', stepId: context.stepId, frameId: context.frameId, note }] : [{ type: 'note.delete', stepId: context.stepId, frameId: context.frameId, noteId }];
  });
}
function renderNoteEditor(): void {
  const focused = document.activeElement; if (focused instanceof HTMLTextAreaElement && focused.id === 'noteText') return;
  document.querySelector('.note-editor')?.remove(); const note = getFrame()?.notes.find(n => n.id === activeNoteId); if (!note) return;
  const sizeField = note.kind === 'rectangle' || note.kind === 'circle' ? `<label>Size (mm)<input id="noteSize" type="number" min=".2" step=".5" value="${note.size}"></label>` : '';
  const colorControl = isShapeNote(note.kind)
    ? noteColorPalette('editNoteColor', 'color', note.color, note.id)
    : `<label>Color <input id="editNoteColor" type="color" value="${note.color}"></label>`;
  const editor = document.createElement('aside'); editor.className = 'panel note-editor'; editor.innerHTML = `<div class="row spread"><span>${esc(note.kind)} · 3D attachment</span><button data-close-note class="icon">×</button></div><textarea id="noteText" placeholder="Add a note…">${esc(note.text)}</textarea>${colorControl}${noteColorPalette('editNoteBackground', 'background', note.background, note.id)}${sizeField}<div class="small muted">${note.anchors.length} attachment${note.anchors.length === 1 ? '' : 's'}${note.anchors.some(a => a.needsReview) ? ' · Review updated surface' : ''}</div><div style="max-height:160px;overflow:auto;margin:9px 0">${note.anchors.map((anchor, index) => `<div class="row small" style="margin:5px 0"><span class="grow">${esc(project?.model.parts.find(p => p.id === anchor.partId)?.name)} · ${anchor.region?.kind ?? anchor.target}</span>${anchor.region ? `<button data-edit-region="${index}">Edit…</button>` : ''}<button data-delete-region="${index}" title="Remove this region">×</button></div>`).join('')}</div><div class="row" style="margin:8px 0"><button id="notePlacement">Placement…</button></div><div class="row"><button id="deleteNote" class="danger">Delete</button>${note.kind === 'glue' ? '<button id="continueGlue">Add more regions</button>' : ''}<button id="finishNote">Done</button></div>`; element('.workspace').append(editor);
}
function showPicker(id: string): void { if (!project) return; const draft = createPickerDraft(project, id); pickerQuery = ''; pickerSearchOpen = false; pickerUnassembledOnly = false; openStep(id); picking = draft; renderPicker(); renderScene(); }
function renderPicker(): void {
  const previous = document.querySelector<HTMLElement>('#pickerTree'); if (previous) rememberTreeExpansion(previous, 'picker:');
  const searchFocused = document.activeElement?.id === 'pickerSearch';
  document.querySelector('.object-picker')?.remove(); if (!project || !picking) return; const step = findStep(project, picking.stepId); const earlier = project.steps.slice(0, project.steps.indexOf(step));
  const picker = document.createElement('aside'); picker.className = 'panel object-picker'; picker.innerHTML = `<header class="panel-header"><span class="row">${icon('list')} List</span><span class="row"><button id="pickerFilter" class="icon ${pickerUnassembledOnly ? 'active' : ''}" title="Show unassembled only">${icon(pickerUnassembledOnly ? 'filterActive' : 'filter')}</button><button id="pickerSearchToggle" class="icon" title="Search">${icon('search')}</button></span></header><div class="list-controls" ${pickerSearchOpen ? '' : 'hidden'}><input id="pickerSearch" value="${esc(pickerQuery)}" placeholder="Search objects…" aria-label="Search add-object list">${icon('search')}</div><div class="list-columns"><span>Object name</span><span>Assemble</span></div>${earlier.some(s => s.partIds.length) ? `<div class="picker-assemblies"><div class="small muted">Completed assemblies</div>${earlier.filter(s => s.partIds.length).map(s => `<button data-use-assembly="${s.id}" draggable="true" data-assembly="${s.id}">${icon('merge')} ${esc(s.name)} · ${assemblySnapshot(s).partIds.length} parts</button>`).join('')}</div>` : ''}<div class="part-tree" id="pickerTree">${treeMarkup(true)}</div><div class="picker-hint">Select objects here or drag parts from the 3D view into the step.</div><footer class="picker-footer"><span class="small" id="pickerCount">${picking.ids.size} / ${project.model.parts.filter(part => part.sourceStatus === 'active').length}</span><button id="cancelPicker">Cancel</button><button id="pickerConfirm" class="primary">OK</button></footer>`;
  element('.workspace').append(picker); queueThumbnails();
  picker.querySelectorAll<HTMLInputElement>('[data-check-object]').forEach(input => { const node = findBrowserNode(project!.model, input.dataset.checkObject!); const ids = node ? nodePartIds(node).filter(id => project!.model.parts.some(part => part.id === id && part.sourceStatus === 'active')) : []; const count = ids.filter(id => picking!.ids.has(id)).length; input.indeterminate = count > 0 && count < ids.length; });
  const all = picker.querySelector<HTMLInputElement>('[data-picker-all]'); if (all) { const count = project.model.parts.filter(part => part.sourceStatus === 'active' && picking!.ids.has(part.id)).length; all.indeterminate = count > 0 && count < project.model.parts.filter(part => part.sourceStatus === 'active').length; }
  if (searchFocused) { const search = element<HTMLInputElement>('#pickerSearch'); search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}
async function confirmPicker(): Promise<void> {
  if (!project || !picking) return; const commands = pickerCommands(project, picking);
  if (commands.length) await commit(commands);
  picking = undefined; document.querySelector('.object-picker')?.remove(); renderScene();
}
async function addPartsToStep(targetId: string, ids: string[], sourceStepId?: string): Promise<void> {
  if (!project) return;
  if (picking?.stepId === targetId) {
    if (sourceStepId) stagePickerAssembly(project, picking, sourceStepId); else ids.forEach(id => picking!.ids.add(id));
    renderPicker(); renderScene(); return;
  }
  const projectId = project.id;
  await commit(current => {
    if (current.id !== projectId) return [];
    const step = findStep(current, targetId);
    if (sourceStepId) return [{ type: 'step.group', stepId: targetId, sourceStepId }];
    const partIds = [...new Set([...step.partIds, ...ids])];
    return partIds.length === step.partIds.length ? [] : [{ type: 'step.members', stepId: targetId, partIds }];
  });
}
function stepDropCard(target: EventTarget | null): HTMLElement | undefined {
  if (merging || !(target instanceof Element)) return;
  const card = target.closest<HTMLElement>('#structure .step-card[data-step]');
  if (card && project?.steps.some(step => step.id === card.dataset.step && !step.final)) return card;
}
function highlightStepDrop(card?: HTMLElement): void {
  const previous = document.querySelector('#structure .drop-active');
  if (previous === card) return;
  previous?.classList.remove('drop-active');
  card?.classList.add('drop-active');
}
async function dropParts(ids: string[], x: number, y: number): Promise<void> {
  if (!project || merging || !ids.length) return;
  const targetId = stepDropCard(document.elementFromPoint(x, y))?.dataset.step;
  if (!targetId) { toast('Drop the parts onto an assembly step card.'); return; }
  const origin = getStep(), projectId = project.id;
  const targetIndex = project.steps.findIndex(step => step.id === targetId);
  const group = origin?.groups.find(item => ids.length === item.partIds.length && ids.every(id => item.partIds.includes(id)));
  const source = project.steps.slice(0, targetIndex).find(step => !step.final && step.id === group?.sourceStepId);
  await addPartsToStep(targetId, ids, source?.id);
  if (origin && stepId === origin.id && targetId !== origin.id && project?.id === projectId && !picking) openStep(targetId);
}

function stopPlayback(reset = true): void {
  playing = false; cancelAnimationFrame(playRaf); const button = element<HTMLButtonElement>('#playButton'); button.innerHTML = icon('play'); button.title = 'Play all steps'; button.setAttribute('aria-label', button.title); element('#playbackOverlay').hidden = true;
  if (reset) { timelinePosition = undefined; pausedPlayback = undefined; activePlaybackPlan = []; return; }
  if (!pausedPlayback) return;
  const next = resumeAfterTitle(activePlaybackPlan, pausedPlayback.index);
  if (next === pausedPlayback.index) return;
  if (next >= activePlaybackPlan.length) { pausedPlayback = undefined; activePlaybackPlan = []; return; }
  pausedPlayback = { ...pausedPlayback, index: next, progress: 0, stepId: activePlaybackPlan[next].step.id }; showPlaybackSegment(activePlaybackPlan[next], 0);
}
function showPlaybackSegment(segment: PlaybackSegment, progress: number): void {
  if (!project) return;
  const changed = stepId !== segment.step.id || frameId !== segment.to.id; stepId = segment.step.id; frameId = segment.to.id;
  view.showPlayback(project, segment, progress, display);
  const overlay = element<HTMLCanvasElement>('#playbackOverlay'), card = playbackCard(project, segment); overlay.hidden = !card;
  if (card) {
    const scale = devicePixelRatio || 1, width = overlay.clientWidth, height = overlay.clientHeight;
    overlay.width = Math.round(width * scale); overlay.height = Math.round(height * scale);
    const context = overlay.getContext('2d')!; context.scale(scale, scale); drawPlaybackCard(context, width, height, card);
  }
  const queue = frameQueue(project), target = queue.findIndex(item => item.frame.id === segment.to.id), from = queue.findIndex(item => item.frame.id === segment.from.id);
  timelinePosition = segment.kind === 'motion' ? from + (target - from) * progress : Math.max(target, 0);
  element<HTMLInputElement>('#playSlider').value = String(timelinePosition);
  element('#frameNumber').textContent = `${Math.max(target + 1, 1)}/${queue.length}`;
  if (changed) { renderStructure(); renderGuide(); }
}
function startPlayback(local = false): void {
  if (!project) return; if (playing) { stopPlayback(false); sendSession(); return; }
  const resume = pausedPlayback?.local === local && (!local || pausedPlayback.stepId === stepId) ? pausedPlayback : undefined;
  activePlaybackPlan = resume ? activePlaybackPlan : playbackPlan(project, local ? stepId ?? undefined : undefined); if (!activePlaybackPlan.length) return;
  let index = resume?.index ?? 0;
  if (!resume && !local) {
    const queue = frameQueue(project), current = queue.findIndex(item => item.frame.id === frameId);
    if (current > 0 && current < queue.length - 1) { const next = activePlaybackPlan.findIndex(segment => segment.kind === 'motion' && segment.from.id === frameId || segment.kind === 'hold' && segment.to.id === frameId); if (next >= 0) index = next; }
  }
  let elapsed = (resume?.progress ?? 0) * activePlaybackPlan[index].duration * 1000, previousTime = performance.now();
  selected = []; view.select([]); playing = true; const button = element<HTMLButtonElement>('#playButton'); button.innerHTML = icon('pause'); button.title = 'Pause playback'; button.setAttribute('aria-label', button.title); showPlaybackSegment(activePlaybackPlan[index], resume?.progress ?? 0); sendSession();
  const tick = (): void => {
    if (!project || !playing) return; let current = activePlaybackPlan[index];
    const speed = Number(element<HTMLSelectElement>('#playSpeed').value), now = performance.now(); elapsed += (now - previousTime) * current.duration / playbackDuration(current, speed); previousTime = now;
    while (elapsed >= current.duration * 1000 && continuousBoundary(current, activePlaybackPlan[index + 1])) {
      elapsed -= current.duration * 1000;
      current = activePlaybackPlan[++index];
    }
    const t = Math.min(1, elapsed / (current.duration * 1000)); pausedPlayback = { local, index, progress: t, stepId: current.step.id }; showPlaybackSegment(current, t);
    if (t >= 1) { index++; elapsed = 0; if (index >= activePlaybackPlan.length) { stopPlayback(); render(); sendSession(); return; } }
    playRaf = requestAnimationFrame(tick);
  }; tick();
}
function goFrame(delta: number): void { if (!project) return; const queue = frameQueue(project); const current = queue.findIndex(item => item.frame.id === frameId); const next = queue[Math.max(0, Math.min(queue.length - 1, current + delta))]; if (next) { stepId = next.step.id; openFrame(next.frame.id); } }
async function saveFrame(): Promise<void> { const step = getStep(), frame = getFrame(); if (!step || !frame) return; const image = view.capture().toDataURL('image/jpeg', .65); await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { camera: view.cameraState(), poses: view.poses(), image } }]); editedPoses = undefined; }
async function autoExplode(): Promise<void> { const step = getStep(), frame = getFrame(); if (!project || !step || !frame || !canAutoExplode(project, step)) return; const poses = teardownPoses(project, step); await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses, image: null } }]); view.fit(step.partIds, 1.1); }
async function applyHomePose(): Promise<void> { const step = getStep(), frame = getFrame(); if (!project) return; if (!step || !frame) { const ids = selected.length ? selected : project.model.parts.map(part => part.id); await commit([{ type: 'model.pose', poses: Object.fromEntries(ids.map(id => [id, copy(findPart(project!, id).home)])) }]); return; } const poses = copy(frame.poses); (selected.length ? selected.filter(id => step.partIds.includes(id)) : step.partIds).forEach(id => { poses[id] = copy(step.final ? step.frames.at(-1)!.poses[id] : homePose(findPart(project!, id))); }); await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses } }]); }
async function importFile(sync = false): Promise<void> {
  const file = await pickFile('.3mf,.f3d'); if (!file) return; stopPlayback(); busy(sync ? 'Reading updated model and matching parts…' : 'Importing assembly…');
  try {
    if (file.name.toLowerCase().endsWith('.f3d')) { const job = await request<FusionJobState>(`/api/fusion/import?name=${encodeURIComponent(file.name)}${sync && project ? `&project=${project.id}` : ''}`, { method: 'POST', body: file }); await finishFusionImport(job); return; }
    if (sync && project) { const plan = await request<SyncPlan>(`/api/projects/${project.id}/sync?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }); busy(); showSync(plan); }
    else { const next = await request<Project>(`/api/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }); await openProject(next.id); }
  } finally { busy(); }
}
async function finishFusionImport(initial: FusionJobState): Promise<void> {
  let job = initial;
  while (job.state === 'queued' || job.state === 'running') {
    busy(`${job.phase ?? 'Reading Fusion design'}${job.total ? ` · ${job.completed ?? 0}/${job.total}` : ''}…`);
    await new Promise(resolve => setTimeout(resolve, 800)); job = await request<FusionJobState>(`/api/fusion/jobs/${initial.id}`);
  }
  if (job.state === 'failed') throw new Error(job.error ?? 'Fusion import failed.');
  if (job.unchanged) { busy(); toast(job.phase ?? 'The latest saved Fusion version is already imported.'); return; }
  if (job.projectId) await openProject(job.projectId);
  else if (job.syncPlanId) { busy(); showSync(await request<SyncPlan>(`/api/sync/${job.syncPlanId}`)); }
}
async function importFusion(sync = false): Promise<void> {
  const state = await request<FusionBridgeState>('/api/fusion/status');
  if (!state.connected) { modal('Connect Fusion', '<p>Open Fusion and enable <b>ManualStudioBridge</b> under <b>Utilities → Scripts and Add-Ins</b>. Keep <b>Run on Startup</b> checked.</p><p>Then use Fusion cloud or open an F3D file. Native import retains body material names, appearances, surface normals and construction axes.</p>', [{ label: 'Close', primary: true, action: root => root.remove() }]); return; }
  const source = sync ? project?.model.source : undefined;
  modal(sync ? 'Sync from Fusion cloud' : 'Import from Fusion cloud', `<p><b>${esc(source?.documentName ?? state.documentName ?? 'No saved design is open')}</b></p><p>Read the latest saved cloud version${state.latestVersion ? ` · v${state.latestVersion}` : ''}, including native materials and construction axes.</p>${state.modified && !source ? '<p>Save the current Fusion document first so the cloud version includes your latest changes.</p>' : ''}`, [
    { label: 'Cancel', action: root => root.remove() }, { label: sync ? 'Read model update' : 'Import cloud model', primary: true, action: async root => {
      root.remove(); stopPlayback(); busy('Opening Fusion cloud model…');
      try { const job = await request<FusionJobState>('/api/fusion/import', post({ fileId: source?.fileId ?? state.fileId, projectId: sync ? project?.id : undefined })); await finishFusionImport(job); } finally { busy(); }
    } },
  ]);
}
function showSync(plan: SyncPlan): void {
  if (!project) return; const original = project;
  const nameOf = (id: string): string => original.model.parts.find(part => part.id === id)?.name ?? id;
  const baselineText = plan.replacesBaseline
    ? 'The incoming Fusion version becomes the new model baseline. Parts deleted from that version and their affected step references are removed. Other assembly steps and keyframes are preserved.'
    : original.model.source && plan.model.source
      ? 'The saved Fusion version is unchanged. This update completes its imported contents while retaining existing parts and assembly steps.'
      : 'Step and frame identities remain stable. Removed source parts retain their last geometry wherever an existing step uses them.';
  const affected = plan.removedFromSteps?.length ? `<p>Steps affected by deleted source parts:</p><ul>${plan.removedFromSteps.map(item => `<li>${esc(original.steps.find(step => step.id === item.stepId)?.name ?? item.stepId)}: ${item.partIds.map(id => esc(nameOf(id))).join(', ')}${item.noteIds.length ? ` · ${item.noteIds.length} affected annotations removed` : ''}</li>`).join('')}</ul>` : '';
  const content = `<p>${plan.matches.length} matched · ${plan.added.length} added · ${plan.removed.length} absent from incoming source</p><p class="muted">${baselineText} Geometry changes preserve each frame’s authored offset; surface attachments are rebound and flagged for review when needed.</p>${affected}<table><thead><tr><th>Updated part</th><th>Match to existing part</th></tr></thead><tbody>${plan.model.parts.map(part => { const match = plan.matches.find(m => m.newId === part.id); const unresolved = plan.unresolved.find(u => u.newId === part.id); return `<tr><td>${esc(part.name)}${match?.geometryChanged ? '<br><span class="muted">Geometry updated</span>' : ''}</td><td><select class="mapping-select" data-sync-new="${part.id}"><option value="">${match ? `${esc(nameOf(match.oldId))} · ${match.reason}` : unresolved ? 'Choose a match…' : 'Add as a new part'}</option><option value="new">Add as a new part</option>${original.model.parts.map(old => `<option value="${old.id}">${esc(old.name)} · ${esc(old.id.slice(-6))}</option>`).join('')}</select></td></tr>`; }).join('')}</tbody></table>`;
  modal('Sync model', content, [
    { label: 'Cancel', action: root => root.remove() },
    { label: 'Apply model update', primary: true, action: async root => {
      const mapping: Record<string, string> = {}; root.querySelectorAll<HTMLSelectElement>('[data-sync-new]').forEach(select => { if (select.value) mapping[select.dataset.syncNew!] = select.value; });
      let resolved = plan; if (Object.keys(mapping).length) resolved = await request<SyncPlan>(`/api/sync/${plan.id}/resolve`, post({ mapping }));
      if (resolved.unresolved.length) { root.remove(); showSync(resolved); toast('Resolve the ambiguous parts before applying this update.'); return; }
      busy('Applying model update…'); try { project = await request<Project>(`/api/sync/${resolved.id}/apply`, post({})); await view.load(project); resetModelInteraction(); undo = []; redo = []; root.remove(); render(); const affectedSteps = resolved.removedFromSteps?.length ?? 0; toast(affectedSteps ? `Model baseline updated. Removed deleted source parts from ${affectedSteps} assembly steps.` : 'Model updated. Existing assembly steps retained.'); } finally { busy(); }
    } },
  ]);
}
interface ExportJob { id: string; projectId: string; kind: ExportKind | 'label-layout'; display: DisplayMode; labelLayout?: LabelLayoutRequest; scope?: RenderScope; revision?: number }
async function doExport(kind: ExportJob['kind'], job?: ExportJob): Promise<void> {
  if (!project) return; stopPlayback(); exporting = true; const snapshot = copy(project); const savedSession = session(), savedCamera = view.cameraState(); const controller = new AbortController();
  const jobId = job?.id;
  busy('Preparing export…', () => controller.abort());
  try {
    if (job?.revision !== undefined && snapshot.revision !== job.revision) throw new Error('The project changed before the renderer loaded it. Request a new render.');
    if (kind === 'label-layout') {
      if (!job?.labelLayout) throw new Error('A keyframe and progress values are required for a label layout query.');
      const layout = await inspectLabelLayout(snapshot, view, job.labelLayout, job.display, controller.signal);
      await request(`/api/render/${job.id}`, post({ layout })); return;
    }
    const result = await exportProject(snapshot, view, kind, text => busy(text, () => controller.abort()), {
      display: job?.display ?? savedSession.display,
      signal: controller.signal,
      playbackSpeed: Number(element<HTMLSelectElement>('#playSpeed').value),
      scope: job?.scope,
    });
    if (jobId && kind === 'mp4') {
      const query = new URLSearchParams({ filename: result.filename });
      await request(`/api/render/${jobId}?${query}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: result.blob, signal: controller.signal });
    } else if (jobId) { const buffer = new Uint8Array(await result.blob.arrayBuffer()); let binary = ''; for (let i = 0; i < buffer.length; i += 32768) binary += String.fromCharCode(...buffer.subarray(i, i + 32768)); await request(`/api/render/${jobId}`, post({ filename: result.filename, mime: result.blob.type, data: btoa(binary) })); }
    else download(result);
    toast(`Exported ${result.filename}`);
  } catch (error) { if (jobId) await request(`/api/render/${jobId}`, post({ error: String(error) })); throw error; }
  finally { stepId = savedSession.stepId; frameId = savedSession.frameId; render(); view.setCamera(savedCamera); busy(); exporting = false; if (pendingReload) { pendingReload = false; void reloadExternal(); } }
}
function exportMenu(anchor: HTMLElement): void { menu(anchor, [
  { label: 'Export PDF', action: () => doExport('pdf') }, { label: 'Export Markdown', action: () => doExport('markdown') }, { label: 'Export MP4', action: () => doExport('mp4') }, { label: 'Export current image', action: () => doExport('png') }, { label: 'Export project JSON', action: () => doExport('json') }, { label: 'Set export file parameters', action: exportSettings },
]); }
function exportSettings(): void {
  if (!project) return; modal('Export file parameters', `<label>Title<input id="exportTitle" value="${esc(project.settings.title)}"></label><label>Cover image<input id="exportCover" type="file" accept="image/*"></label><label>Second page image<input id="exportSecond" type="file" accept="image/*"></label><p class="muted">PDF includes a title page and every saved keyframe. Markdown includes the frame images. MP4 follows the playback strategy and per-frame duration.</p>`, [
    { label: 'Cancel', action: root => root.remove() }, { label: 'Save', primary: true, action: async root => {
      const readImage = async (selector: string): Promise<string | undefined> => { const file = root.querySelector<HTMLInputElement>(selector)?.files?.[0]; if (!file) return; return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); };
      const cover = await readImage('#exportCover'), second = await readImage('#exportSecond'); await commit([{ type: 'settings.update', patch: { title: root.querySelector<HTMLInputElement>('#exportTitle')!.value, ...(cover ? { coverImage: cover } : {}), ...(second ? { secondPageImage: second } : {}) } }]); root.remove();
    } },
  ]);
}
function workspaceOptions(): void {
  if (!project) return;
  const defaultDisplay = project.settings.defaultDisplayMode ?? DEFAULT_DISPLAY_MODE;
  modal('Assembly options', `<label><input id="optionAxes" type="checkbox" ${project.settings.showAxes ? 'checked' : ''}>Show world axes</label><label><input id="optionExplode" type="checkbox" ${project.settings.explodeObjects ? 'checked' : ''}>Explode model objects as a whole</label><label><input id="optionExplosionColumn" type="checkbox" ${project.settings.showExplosionColumn ? 'checked' : ''}>Show explosion state column</label><label>Default assembly display<select id="optionDefaultDisplay">${displayModeOptions}</select></label><label>Playback strategy<select id="optionStrategy"><option value="sequential">Sequential</option><option value="subassembly">Subassemblies first</option></select></label><label>Surface selection angle<input id="optionAngle" type="number" min="1" max="80" value="${view.pickSettings.angle}">°</label><label><input id="optionSnap" type="checkbox" ${view.snapEnabled ? 'checked' : ''}>Snap move to 1 mm and rotation to 15°</label>`, [
    { label: 'Cancel', action: root => root.remove() }, { label: 'Apply', primary: true, action: async root => {
      const value = root.querySelector<HTMLSelectElement>('#optionDefaultDisplay')!.value;
      if (!isDisplayMode(value)) throw new Error('Choose a default assembly display.');
      view.pickSettings.angle = Number(root.querySelector<HTMLInputElement>('#optionAngle')!.value);
      view.setSnap(root.querySelector<HTMLInputElement>('#optionSnap')!.checked);
      await commit([{ type: 'settings.update', patch: {
        showAxes: root.querySelector<HTMLInputElement>('#optionAxes')!.checked,
        explodeObjects: root.querySelector<HTMLInputElement>('#optionExplode')!.checked,
        showExplosionColumn: root.querySelector<HTMLInputElement>('#optionExplosionColumn')!.checked,
        playStrategy: root.querySelector<HTMLSelectElement>('#optionStrategy')!.value as 'sequential' | 'subassembly',
        ...(value !== defaultDisplay ? { defaultDisplayMode: value } : {}),
      } }]);
      if (value !== defaultDisplay) { display = value; render(); sendSession(); }
      root.remove();
    } },
  ]);
  element<HTMLSelectElement>('#optionStrategy').value = project.settings.playStrategy;
  element<HTMLSelectElement>('#optionDefaultDisplay').value = defaultDisplay;
}
function labelSettings(): void {
  const step = getStep(), frame = getFrame(); if (!project || !step || !frame) return; const labels = frameLabels(project, frame); modal('Label settings', `<label>Display mode<select id="labelMode"><option value="auto">Auto recommend</option><option value="object">Model objects only</option><option value="part">Model parts only</option></select></label><label>Font size<input id="labelFont" type="number" min="8" max="40" value="${labels.labelFontSize}"></label><label>Camera margin<input id="cameraMargin" type="number" min=".5" max="3" step=".05" value="${view.cameraState().margin}"></label><button id="hideSelectedLabels">Hide selected part labels</button>`, [
    { label: 'Cancel', action: root => root.remove() }, { label: 'Apply', primary: true, action: async root => {
      const margin = Number(root.querySelector<HTMLInputElement>('#cameraMargin')!.value);
      if (!Number.isFinite(margin) || margin <= 0) throw new Error('Enter a positive camera margin.');
      const commands: Command[] = [labelCommand({ labelMode: root.querySelector<HTMLSelectElement>('#labelMode')!.value as 'auto' | 'object' | 'part', labelFontSize: Number(root.querySelector<HTMLInputElement>('#labelFont')!.value) })];
      const previousCamera = view.cameraState(), cameraChanged = previousCamera.margin !== margin;
      if (cameraChanged) {
        view.fit(step.partIds, margin);
        commands.push({ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { camera: view.cameraState(), image: null } });
      }
      try {
        await commit(commands);
        root.remove();
      } catch (error) {
        if (cameraChanged) view.setCamera(previousCamera);
        throw error;
      }
    } },
  ]); element<HTMLSelectElement>('#labelMode').value = labels.labelMode;
  element('#hideSelectedLabels').onclick = () => { if (project) void commit([labelCommand({ hiddenLabels: [...new Set([...frameLabels(project, getFrame()).hiddenLabels, ...selected])] })]).catch(showError); };
}
function nameValue(target: NameTarget): string | undefined {
  if (!project) return;
  if (target.kind === 'part') return project.model.parts.find(part => part.id === target.id)?.name;
  if (target.kind === 'axis') return project.model.constructionAxes?.find(axis => axis.id === target.id)?.name;
  if (target.kind === 'object') return findBrowserNode(project.model, target.id)?.name;
  return project.steps.find(step => step.id === target.stepId)?.groups.find(group => group.id === target.id)?.name;
}
function editName(target: NameTarget, anchor: HTMLElement): void {
  const name = nameValue(target); if (name === undefined) return;
  editInlineName(anchor, name, value => {
    const command: Command = target.kind === 'part' ? { type: 'part.rename', partId: target.id, name: value }
      : target.kind === 'object' ? { type: 'object.rename', nodeId: target.id, name: value }
        : target.kind === 'axis' ? { type: 'axis.rename', axisId: target.id, name: value }
          : { type: 'group.rename', stepId: target.stepId, groupId: target.id, name: value };
    void commit([command]).catch(showError);
  });
}
function focusName(target: NameTarget): void {
  if (!project) return;
  if (target.kind === 'axis') { selectAxis(target.id, true); return; }
  const ids = target.kind === 'part' ? [target.id] : target.kind === 'object' ? (() => { const node = findBrowserNode(project.model, target.id); return node ? nodePartIds(node) : []; })()
    : project.steps.find(step => step.id === target.stepId)?.groups.find(group => group.id === target.id)?.partIds ?? [];
  if (!ids.length) return;
  if (target.kind === 'part') selectPart(target.id, false, true);
  else { selectedAxis = undefined; selected = [...ids]; view.select(selected); updateTreeSelection(); updateSelectionInfo(); sendSession(); }
  view.fit(ids, 1.3);
}
function partProperties(): void {
  if (!project || !selected.length) { toast('Select a part first.'); return; }
  const projectId = project.id, part = findPart(project, selected[0]), ids = [...selected];
  const step = getStep(), frame = getFrame(), pose = step?.partIds.includes(part.id) ? frame?.poses[part.id] : undefined;
  const removed = step?.removePartIds.includes(part.id) ?? false;
  const positionFields = pose ? `<label><input id="partRemovalEdit" type="checkbox" ${removed ? 'checked' : ''}>Remove in this step</label><label>Position X / Y / Z (mm)${pose.position.map((value, index) => `<input type="number" data-position="${index}" value="${value}" step="any" style="width:90px">`).join('')}</label>` : '';
  modal('Part properties', `<label>Name<input id="partNameEdit" value="${esc(part.name)}"></label><p class="small muted">${esc(part.path)}</p><dl class="part-metadata"><dt>Material</dt><dd>${esc(part.materialName ?? 'Not included in source')}</dd><dt>Appearance</dt><dd>${esc(part.appearanceName ?? 'Not included in source')}</dd></dl><label><input id="partInitialEdit" type="checkbox" ${part.initiallyAssembled ? 'checked' : ''}>Initially assembled (including printed supports)</label>${positionFields}<p class="small muted">${esc(part.id)}</p>`, [
    { label: 'Cancel', action: root => root.remove() }, { label: 'Apply', primary: true, action: async root => {
      const name = root.querySelector<HTMLInputElement>('#partNameEdit')!.value;
      const initial = root.querySelector<HTMLInputElement>('#partInitialEdit')!.checked;
      const remove = root.querySelector<HTMLInputElement>('#partRemovalEdit')?.checked;
      const coordinates = [...root.querySelectorAll<HTMLInputElement>('[data-position]')].map(input => input.valueAsNumber);
      if (pose && (coordinates.length !== 3 || coordinates.some(value => !Number.isFinite(value)))) throw new Error('Enter a finite position for each axis.');
      const position: Vec3 | undefined = pose ? [coordinates[0], coordinates[1], coordinates[2]] : undefined;
      const positionChanged = position && pose && position.some((value, index) => value !== pose.position[index]);
      const removalChanged = remove !== undefined && remove !== removed;
      await commit(current => {
        if (current.id !== projectId) throw new Error('The part belongs to another project.');
        const commands: Command[] = [];
        if (name !== part.name) commands.push({ type: 'part.rename', partId: part.id, name });
        if (initial !== part.initiallyAssembled) commands.push({ type: 'part.initial', partIds: ids, value: initial });
        if (step && frame && (positionChanged || removalChanged)) {
          const latest = findFrame(findStep(current, step.id), frame.id);
          if (!latest.poses[part.id]) throw new Error('The selected part is no longer in this frame.');
          if (position && positionChanged) {
            commands.push({ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses: { ...latest.poses, [part.id]: { ...latest.poses[part.id], position } }, image: null } });
          }
          if (removalChanged) commands.push({ type: 'part.remove', stepId: step.id, partIds: [part.id], value: remove });
        }
        return commands;
      });
      root.remove();
    } },
  ]);
}
function renameStep(id: string): void { if (!project) return; const step = findStep(project, id); modal('Edit step name', `<label>Name<input id="stepNameEdit" value="${esc(step.name)}"></label>`, [{ label: 'Cancel', action: root => root.remove() }, { label: 'Save', primary: true, action: async root => { await commit([{ type: 'step.rename', stepId: id, name: root.querySelector<HTMLInputElement>('#stepNameEdit')!.value }]); root.remove(); } }]); element<HTMLInputElement>('#stepNameEdit').select(); }
function deleteStep(id: string): void { if (!project) return; const step = findStep(project, id); modal('Delete step', `<p>Delete “${esc(step.name)}” and its keyframes?</p>`, [{ label: 'Cancel', action: root => root.remove() }, { label: 'Delete', primary: true, action: async root => { await commit([{ type: 'step.delete', stepId: id }]); root.remove(); } }]); }
function stepMenu(anchor: HTMLElement, id: string): void {
  if (!project) return; const step = findStep(project, id); const index = project.steps.indexOf(step);
  if (step.final) { menu(anchor, [
    { label: 'Edit step name', action: () => renameStep(id) },
    { label: 'Refresh final assembly', action: () => commit([{ type: 'step.final', stepId: id, value: true }]) },
    { label: 'Insert ordinary step before', action: () => commit([{ type: 'step.add', name: 'New Step', before: id }], 'step') },
    { label: 'Remove final assembly summary', danger: true, action: () => commit([{ type: 'step.final', stepId: id, value: false }]) },
  ]); return; }
  menu(anchor, [
    { label: 'Edit step name', action: () => renameStep(id) }, { label: 'Copy step', action: () => commit([{ type: 'step.copy', stepId: id }], 'step') },
    { label: 'Copy and inherit this step', action: () => commit([{ type: 'step.copy', stepId: id, inherit: true }], 'step'), disabled: !step.partIds.length },
    { label: 'Insert step before', action: async () => { await commit([{ type: 'step.add', name: 'New Step', after: index > 0 ? project!.steps[index - 1].id : undefined }], 'step'); if (index === 0 && stepId) await commit([{ type: 'step.reorder', stepId, before: id }]); } },
    { label: 'Insert step after', action: () => commit([{ type: 'step.add', name: 'New Step', after: id }], 'step') },
    { label: project.steps.some(item => item.final) ? 'Refresh final assembly' : 'Create final assembly', action: () => commit([{ type: 'step.final', stepId: id, value: true }]) },
    { label: 'Delete step', danger: true, action: () => deleteStep(id) },
  ]);
}
function frameXrayActions(partIds: string[]) {
  const projectId = project?.id, step = getStep(), frame = getFrame();
  if (!projectId || !step || !frame || picking || playing) return [];
  const members = partIds.filter(id => step.partIds.includes(id));
  if (!members.length) return [];
  const xray = new Set(frame.xrayPartIds);
  const setXray = (enabled: boolean) => commit(current => {
    if (current.id !== projectId) return [];
    const latestStep = findStep(current, step.id), latestFrame = findFrame(latestStep, frame.id);
    const next = new Set(latestFrame.xrayPartIds);
    const previousCount = next.size;
    for (const id of members) {
      if (!latestStep.partIds.includes(id)) continue;
      if (enabled) next.add(id); else next.delete(id);
    }
    if (next.size === previousCount) return [];
    return [{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { xrayPartIds: [...next] } }];
  });
  return [
    { label: 'X-Ray in this keyframe', disabled: members.every(id => xray.has(id)), action: () => setXray(true) },
    { label: 'Restore opacity in this keyframe', disabled: members.every(id => !xray.has(id)), action: () => setXray(false) },
  ];
}
function viewportPartMenu(id: string, event: PointerEvent): void {
  if (!project || merging || playing) return;
  if (!selected.includes(id)) selectPart(id, false, event.altKey, true);
  const current = getStep(), ordinarySteps = project.steps.filter(step => !step.final);
  const ids = selected.filter(partId => current || !overviewUnassembled.checked || view.meshes.get(partId)?.visible);
  const canChooseStep = !current && ids.length > 0;
  menu({ x: event.clientX, y: event.clientY }, [
    { label: 'Add to New Step', disabled: !canChooseStep || ordinarySteps.length >= MAX_ORDINARY_STEPS, action: async () => {
      await commit([{ type: 'step.add', parts: ids }], 'step');
      sendSession();
    } },
    { label: 'Add to Current Step', disabled: !current || current.final, action: () => current && addPartsToStep(current.id, ids) },
    { label: 'Add to Existing Step', disabled: !canChooseStep || !ordinarySteps.length,
      submenu: ordinarySteps.map((step, index) => ({ label: `Step ${index + 1} · ${step.name}`, action: () => addPartsToStep(step.id, ids) })) },
    ...frameXrayActions(ids),
    { label: 'Part properties / rename', action: partProperties },
  ]);
}
function clearAllSteps(): void {
  if (!project?.steps.length) return;
  modal('Delete all assembly steps', '<p>Delete all steps and keyframes in this project?</p>', [{ label: 'Cancel', action: root => root.remove() }, { label: 'Delete all', primary: true, action: async root => { if (project) await commit(project.steps.map(step => ({ type: 'step.delete' as const, stepId: step.id }))); root.remove(); } }]);
}
async function undoAction(forward = false): Promise<void> { if (!project || saving) return; const source = forward ? redo : undo, destination = forward ? undo : redo; const previous = source.pop(); if (!previous) return; destination.push(copy(project)); await replaceProject(previous, false); if (!getStep()) openStep(null); }

app.addEventListener('click', event => { const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,[data-step],[data-overview],[data-drop-step],[data-frame],[data-part],[data-axis],[data-use-assembly]') : null; if (!target) return;
  const run = async (): Promise<void> => {
    if (target.dataset.presetColor) {
      const palette = target.closest<HTMLElement>('.annotation-palette');
      if (!palette) return;
      const property = palette.dataset.colorProperty;
      if (property !== 'color' && property !== 'background') return;
      const value = target.dataset.presetColor;
      if (property === 'color') shapeNoteColor = value;
      else noteBackground = value;
      if (!palette.dataset.noteId) { renderGuide(); return; }
      const step = getStep(), frame = getFrame();
      const note = frame?.notes.find(item => item.id === palette.dataset.noteId);
      if (!step || !frame || !note || note[property].toLowerCase() === value) return;
      await commit([{ type: 'note.update', stepId: step.id, frameId: frame.id, noteId: note.id, patch: { [property]: value } }]);
      return;
    }
    if (merging && target.closest('#structure')) {
      if (event.target instanceof HTMLInputElement && event.target.dataset.mergeStep) return;
      const card = target.closest<HTMLElement>('[data-step]'); if (card?.dataset.step) { merging.has(card.dataset.step) ? merging.delete(card.dataset.step) : merging.add(card.dataset.step); renderStructure(); }
      return;
    }
    if (target.dataset.eye) { event.preventDefault(); await toggleNodeVisibility(target.dataset.eye); return; }
    if (target.dataset.selectObject && project) {
      event.preventDefault(); const node = findBrowserNode(project.model, target.dataset.selectObject); if (!node) return;
      const ids = nodePartIds(node).filter(id => project!.model.parts.some(part => part.id === id && part.sourceStatus === 'active'));
      if (target.closest('.object-picker') && picking) { const remove = ids.every(id => picking!.ids.has(id)); ids.forEach(id => remove ? picking!.ids.delete(id) : picking!.ids.add(id)); renderPicker(); renderScene(); return; }
      selectedAxis = undefined; if (event.ctrlKey || event.metaKey) { const next = new Set(selected), remove = ids.every(id => next.has(id)); ids.forEach(id => remove ? next.delete(id) : next.add(id)); selected = [...next]; } else selected = ids; rangeAnchorId = ids[0]; focusedListId = ids[0]; view.select(selected); updateTreeSelection(); updateSelectionInfo(); sendSession(); return;
    }
    if (target.dataset.insertBefore) { await commit([{ type: 'step.add', before: target.dataset.insertBefore }], 'step'); if (stepId) showPicker(stepId); return; }
    if (target.dataset.axis) { selectAxis(target.dataset.axis); return; }
    if (target.dataset.axisFocus) { selectAxis(target.dataset.axisFocus, true); return; }
    if (target.dataset.explodePart && project && getStep() && getFrame()) { const part = findPart(project, target.dataset.explodePart), frame = getFrame()!, step = getStep()!; const current = frame.poses[part.id]; const isExploded = current && new Vector3(...current.position).distanceTo(new Vector3(...part.home.position)) > .001; const poses = { ...frame.poses, [part.id]: isExploded ? copy(part.home) : teardownPoses(project, step)[part.id] }; await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { poses } }]); return; }
    if (target.dataset.tool) { setTool(target.dataset.tool as ViewTool); return; }
    if (target.dataset.view) { view.view(target.dataset.view); return; }
    if (target.dataset.material && project) { selected = project.model.parts.filter(p => p.material === Number(target.dataset.material)).map(p => p.id); view.select(selected); if (selected[0]) revealPart(selected[0]); return; }
    if (target.dataset.copy) { await commit([{ type: 'step.copy', stepId: target.dataset.copy, inherit: true }], 'step'); return; }
    if (target.dataset.deleteStep) { deleteStep(target.dataset.deleteStep); return; }
    if (target.dataset.stepMenu) { stepMenu(target, target.dataset.stepMenu); return; }
    if (target.dataset.dropStep) { showPicker(target.dataset.dropStep); return; }
    if (target.dataset.deleteFrame && getStep()) { await commit([{ type: 'frame.delete', stepId: getStep()!.id, frameId: target.dataset.deleteFrame }]); return; }
    if (target.dataset.frame) { openFrame(target.dataset.frame); return; }
    if (target.dataset.refreshFinal) { await commit([{ type: 'step.final', stepId: target.dataset.refreshFinal, value: true }]); return; }
    if (target.dataset.useAssembly && picking) { await addPartsToStep(picking.stepId, [], target.dataset.useAssembly); return; }
    if (target.dataset.part) { if (target.closest('.object-picker')) { if (!(event.target instanceof HTMLInputElement)) { const checked = target.querySelector<HTMLInputElement>('input'); checked?.click(); } } else { if (event.shiftKey) selectListRange(target.dataset.part, event.ctrlKey || event.metaKey); else { selectPart(target.dataset.part, event.ctrlKey || event.metaKey, event.altKey); focusListRow(target.dataset.part); } } return; }
    if (target.hasAttribute('data-overview')) { openStep(null); return; }
    if (target.dataset.step) { if (target.dataset.step === stepId && event.target instanceof Element && event.target.closest('[data-rename-step]')) return; openStep(target.dataset.step); return; }
    if (target.hasAttribute('data-close-note') || target.id === 'finishNote') { await flushNoteDraft(); activeNoteId = undefined; view.setTool('select'); renderGuide(); renderNoteEditor(); return; }
    if (target.dataset.editRegion !== undefined && project) {
      const note = getFrame()?.notes.find(item => item.id === activeNoteId), index = Number(target.dataset.editRegion);
      if (note) editSurfaceRegion(project, note, index, async edited => {
        await flushNoteDraft(); await apiQueue;
        const current = getFrame()?.notes.find(item => item.id === edited.id); if (!current) throw new Error('The annotation is no longer present.');
        await updateNoteAnchors(current.id, anchors => { anchors[index] = copy(edited.anchors[index]); });
      });
      return;
    }
    if (target.dataset.deleteRegion !== undefined) { const note = getFrame()?.notes.find(n => n.id === activeNoteId); if (note) await updateNoteAnchors(note.id, anchors => { anchors.splice(Number(target.dataset.deleteRegion), 1); }); return; }
    switch (target.id) {
      case 'importButton': case 'emptyImport': await importFile(); break;
      case 'importFusion': await importFusion(); break;
      case 'syncButton': menu(target, [{ label: 'Read latest Fusion cloud version', action: () => importFusion(true) }, { label: 'Update from 3MF or F3D file…', action: () => importFile(true) }]); break;
      case 'addStep': await commit([{ type: 'step.add' }], 'step'); if (stepId) showPicker(stepId); break;
      case 'mergeSteps': beginMerge(); break;
      case 'cancelMerge': cancelMerge(); break;
      case 'confirmMerge': await confirmMerge(); break;
      case 'selectionStep': if (selected.length >= 2) await commit([{ type: 'step.add', parts: selected }], 'step'); break;
      case 'returnButton': case 'footerReturn': openStep(null); break;
      case 'collapseStructure': case 'collapseList': case 'collapseGuide': panels.toggle(element(`#${target.dataset.panelToggle}`)); break;
      case 'structureHelp': showHelp(); break;
      case 'clearAllSteps': clearAllSteps(); break;
      case 'resetSectionDirection': setSectionValue(session().section, true); sendSession(); break;
      case 'saveButton': if (!project) break; if (getFrame()) await saveFrame(); else { await apiQueue; toast('Project saved locally.'); } break;
      case 'undoButton': await undoAction(); break; case 'redoButton': await undoAction(true); break;
      case 'filterButton': unassembledOnly = !unassembledOnly; renderParts(); break;
      case 'searchButton': toggleSearch('list'); break;
      case 'structureSearchButton': toggleSearch('structure'); break;
      case 'expandAll': { const nodes = [...document.querySelectorAll<HTMLDetailsElement>('#partTree details[data-tree-node]')]; const open = nodes.some(node => !node.open); nodes.forEach(node => { node.open = open; }); rememberTreeExpansion(element('#partTree')); updateTreeToggle(); break; }
      case 'fitAll': view.fit(undefined, 1); break; case 'fitSelected': view.fit(selected.length ? selected : undefined, 1.2); break;
      case 'explodeButton': await autoExplode(); break; case 'homePoseButton': await applyHomePose(); break;
      case 'addFrame': if (getStep() && getFrame()) await commit([{ type: 'frame.add', stepId: stepId!, afterId: getFrame()!.id }], 'frame'); break;
      case 'saveFrame': await saveFrame(); break;
      case 'frameSettings': { const step = getStep(), frame = getFrame(); if (step && frame) editFrameSettings(step, frame, view.cameraState(), commit, camera => view.setCamera(camera)); break; }
      case 'moveAlongAxis': { const step = getStep(), frame = getFrame(); if (project && step && frame) moveAlongAxis(project, step, frame, selected, commit, selectedAxis); break; }
      case 'labelPositions': { const step = getStep(); if (project && step) editLabelPositions(project, step, commit, getFrame()); break; }
      case 'notePlacement': { const step = getStep(), frame = getFrame(), note = frame?.notes.find(item => item.id === activeNoteId); if (step && frame && note) editNotePlacement(note, edited => commit([{ type: 'note.update', stepId: step.id, frameId: frame.id, noteId: note.id, patch: { offset: edited.offset } }])); break; }
      case 'cameraAll': if (stepId) await commit([{ type: 'frame.cameraAll', stepId, camera: view.cameraState() }]); break;
      case 'playButton': startPlayback(); break; case 'playStep': startPlayback(true); break;
      case 'previousFrame': goFrame(-1); break; case 'nextFrame': goFrame(1); break;
      case 'pickerConfirm': await confirmPicker(); break;
      case 'cancelPicker': picking = undefined; document.querySelector('.object-picker')?.remove(); renderScene(); break;
      case 'pickerFilter': pickerUnassembledOnly = !pickerUnassembledOnly; renderPicker(); break;
      case 'pickerSearchToggle': pickerSearchOpen = !pickerSearchOpen; renderPicker(); if (pickerSearchOpen) element<HTMLInputElement>('#pickerSearch').focus(); break;
      case 'exportButton': exportMenu(target); break;
      case 'settingsButton': workspaceOptions(); break;
      case 'labelSettings': labelSettings(); break;
      case 'autoLabels': await commit([labelCommand({ labelOffsets: view.autoLabels(), showLabels: true })]); break;
      case 'labelReset': await commit([labelCommand({ hiddenLabels: [] })]); break;
      case 'initialAssembly': if (selected.length) await commit([{ type: 'part.initial', partIds: selected, value: true }]); else toast('Select the printed part and its supports first.'); break;
      case 'selectedProperties': partProperties(); break;
      case 'deleteNote': if (activeNoteId && stepId && getFrame()) { await commit([{ type: 'note.delete', stepId, frameId: getFrame()!.id, noteId: activeNoteId }]); activeNoteId = undefined; renderNoteEditor(); } break;
      case 'continueGlue': setTool('glue'); break;
      case 'newGlueNote': activeNoteId = undefined; renderGuide(); renderNoteEditor(); break;
      case 'fileMenu': menu(target, [{ label: 'Open 3MF or F3D…', action: () => importFile() }, { label: 'Import from Fusion cloud…', action: () => importFusion() }, { label: 'Sync latest Fusion cloud version…', disabled: !project, action: () => importFusion(true) }, { label: 'Sync from model file…', disabled: !project, action: () => importFile(true) }, { label: 'Save project archive…', disabled: !project, action: saveArchive }, { label: 'Open project archive…', action: openArchive }, { label: 'Export…', disabled: !project, action: () => exportMenu(target) }, { label: 'Agent API / keyboard shortcuts', action: showHelp }]); break;
      case 'structureOptions': menu(target, [{ label: 'Assembly options', action: workspaceOptions }, { label: 'Expand all steps', action: () => { element('#structure').querySelectorAll<HTMLElement>('.step-chips,.step-drop').forEach(node => { node.hidden = false; }); } }, { label: 'Collapse all steps', action: () => { element('#structure').querySelectorAll<HTMLElement>('.step-chips,.step-drop').forEach(node => { node.hidden = true; }); } }, { label: 'Delete all assembly steps', danger: true, action: () => { modal('Delete all assembly steps', '<p>Delete all steps and keyframes in this project?</p>', [{ label: 'Cancel', action: root => root.remove() }, { label: 'Delete all', primary: true, action: async root => { if (project) await commit(project.steps.map(s => ({ type: 'step.delete' as const, stepId: s.id }))); root.remove(); } }]); } }]); break;
    }
  }; void run().catch(showError);
});

app.addEventListener('change', event => {
  const target = event.target; if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  const run = async (): Promise<void> => {
    if (target.dataset.mergeStep && merging && target instanceof HTMLInputElement) { target.checked ? merging.add(target.dataset.mergeStep) : merging.delete(target.dataset.mergeStep); updateStructureActions(); return; }
    if (target.id === 'mergeAll' && merging && project && target instanceof HTMLInputElement) { merging = new Set(target.checked ? project.steps.map(step => step.id) : []); renderStructure(); return; }
    if (target.hasAttribute('data-picker-all') && picking && project && target instanceof HTMLInputElement) { picking.ids = new Set(target.checked ? project.model.parts.filter(part => part.sourceStatus === 'active').map(part => part.id) : []); renderPicker(); renderScene(); return; }
    if (target.dataset.checkObject && picking && project && target instanceof HTMLInputElement) { const node = findBrowserNode(project.model, target.dataset.checkObject); if (node) nodePartIds(node).filter(id => project!.model.parts.some(part => part.id === id && part.sourceStatus === 'active')).forEach(id => target.checked ? picking!.ids.add(id) : picking!.ids.delete(id)); renderPicker(); renderScene(); return; }
    if (target.dataset.checkPart && picking && target instanceof HTMLInputElement) { target.checked ? picking.ids.add(target.dataset.checkPart) : picking.ids.delete(target.dataset.checkPart); renderPicker(); renderScene(); return; }
    const step = getStep(), frame = getFrame(), note = frame?.notes.find(n => n.id === activeNoteId);
    switch (target.id) {
      case 'projectSelect': if (target.value) await openProject(target.value); break;
      case 'displayMode': display = target.value as DisplayMode; renderScene(); sendSession(); break;
      case 'selectionMode': view.selectionMode = target.value as 'part' | 'object'; break;
      case 'overviewUnassembled': renderScene(); break;
      case 'anchorTarget': view.pickSettings.target = target.value as 'point' | 'part' | 'face' | 'band'; break;
      case 'glueMode': view.pickSettings.region = target.value as 'face' | 'circle' | 'band' | 'brush'; break;
      case 'brushRadius': view.pickSettings.radius = Math.max(.1, Number(target.value)); break;
      case 'bandWidth': view.pickSettings.width = Math.max(.1, Number(target.value)); break;
      case 'bandAxis': view.pickSettings.axis = target.value as 'auto' | 'x' | 'y' | 'z'; break;
      case 'removeWhole': removeWholePart = (target as HTMLInputElement).checked; break;
      case 'noteColor': if ((note?.kind ?? view.tool) === 'glue') glueColor = target.value; else noteColor = target.value; break;
      case 'showLabels': await commit([labelCommand({ showLabels: (target as HTMLInputElement).checked })]); break;
      case 'frameDuration': if (step && frame) await commit([{ type: 'frame.update', stepId: step.id, frameId: frame.id, patch: { duration: Math.max(.1, Number(target.value)) } }]); break;
      case 'stepDescription': if (step) await commit([{ type: 'step.description', stepId: step.id, text: target.value }]); break;
      case 'noteText': await flushNoteDraft(); break;
      case 'editNoteColor': if (step && frame && note) await commit([{ type: 'note.update', stepId: step.id, frameId: frame.id, noteId: note.id, patch: { color: target.value } }]); break;
      case 'noteSize': if (step && frame && note) await commit([{ type: 'note.update', stepId: step.id, frameId: frame.id, noteId: note.id, patch: { size: Math.max(.2, Number(target.value)) } }]); break;
      case 'sectionValue': setSectionValue(Number(target.value)); sendSession(); break;
      case 'explosionValue': explosion = Math.max(1, Math.min(3, Number(target.value))); render(); sendSession(); break;
    }
  }; void run().catch(showError);
});
app.addEventListener('toggle', event => { if (event.target instanceof HTMLDetailsElement && event.target.closest('#partTree')) updateTreeToggle(); }, true);
app.addEventListener('input', event => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.id === 'noteText' && stepId && getFrame() && activeNoteId) {
    noteDraft = { stepId, frameId: getFrame()!.id, noteId: activeNoteId, text: target.value }; clearTimeout(noteDraftTimer); noteDraftTimer = setTimeout(() => { void flushNoteDraft().catch(showError); }, 300); return;
  }
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'sectionValue' && target.value !== '') { setSectionValue(Number(target.value)); sendSession(); }
  if (target.id === 'explosionValue' && target.value !== '') { explosion = Math.max(1, Math.min(3, Number(target.value))); element<HTMLInputElement>('#explosionRange').value = String(explosion); renderScene(); sendSession(); }
  if (target.id === 'partSearch') { query = target.value; renderParts(); }
  if (target.id === 'structureSearch') { structureQuery = target.value; renderStructure(); }
  if (target.id === 'pickerSearch') { pickerQuery = target.value; renderPicker(); }
  if (target.id === 'sectionRange') { setSectionValue(Number(target.value)); sendSession(); }
  if (target.id === 'explosionRange') { explosion = Number(target.value); element<HTMLInputElement>('#explosionValue').value = explosion.toFixed(2); renderScene(); sendSession(); }
  if (target.id === 'playSlider') scrubTo(Number(target.value));
});
app.addEventListener('dblclick', event => {
  if (merging && event.target instanceof Element && event.target.closest('#structure')) { event.preventDefault(); return; }
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-rename-step],[data-rename-part],[data-rename-object],[data-rename-axis]') : null; if (!target) return;
  event.preventDefault();
  if (target.dataset.renameStep) renameStep(target.dataset.renameStep);
  else if (target.dataset.renamePart) editName({ kind: 'part', id: target.dataset.renamePart }, target);
  else if (target.dataset.renameObject) editName({ kind: 'object', id: target.dataset.renameObject }, target);
  else if (target.dataset.renameAxis) editName({ kind: 'axis', id: target.dataset.renameAxis }, target);
});
app.addEventListener('mousedown', event => { if (event.button === 1 && event.target instanceof Element && event.target.closest('#partTree [data-part],#partTree [data-axis],#partTree [data-select-object]')) event.preventDefault(); });
app.addEventListener('auxclick', event => {
  if (event.button !== 1 || !(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('#partTree [data-part],#partTree [data-axis],#partTree [data-select-object]'); if (!target) return;
  event.preventDefault();
  if (target.dataset.part) focusName({ kind: 'part', id: target.dataset.part });
  else if (target.dataset.axis) focusName({ kind: 'axis', id: target.dataset.axis });
  else if (target.dataset.selectObject) focusName({ kind: 'object', id: target.dataset.selectObject });
});
app.addEventListener('contextmenu', event => {
  if (merging && event.target instanceof Element && event.target.closest('#structure')) { event.preventDefault(); return; }
  const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-step]') : null; if (card?.dataset.step) { event.preventDefault(); stepMenu(card, card.dataset.step); return; }
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-part]') : null; if (!target?.dataset.part) return; event.preventDefault(); if (!selected.includes(target.dataset.part)) selectPart(target.dataset.part, false, event.altKey);
  menu(target, [
    { label: 'Fit selection', action: () => view.fit(selected, 1.2) }, { label: 'Part properties / rename', action: partProperties },
    ...frameXrayActions(selected),
    { label: 'Initially assembled', action: () => commit([{ type: 'part.initial', partIds: selected, value: true }]) },
    { label: 'Initially unassembled', action: () => commit([{ type: 'part.initial', partIds: selected, value: false }]) },
    { label: 'Add to current step', disabled: !stepId || getStep()?.final, action: async () => { if (getStep()) await addPartsToStep(stepId!, selected); } },
    { label: 'Add to new step', action: () => commit([{ type: 'step.add', parts: selected }], 'step') },
    { label: 'Isolate selected parts', action: () => { view.isolate(selected); renderScene(); } }, { label: 'Show all parts', action: async () => { view.isolate([]); view.setVisibility(project!.model.parts.map(p => p.id), true); await commit([{ type: 'settings.update', patch: { partVisibility: Object.fromEntries(project!.model.parts.map(part => [part.id, true])), objectVisibility: Object.fromEntries([...modelVisibility(project!).objects.keys()].map(id => [id, true])) } }]); } },
    { label: 'Hide selected parts', action: () => commit([{ type: 'settings.update', patch: { partVisibility: { ...project!.settings.partVisibility, ...Object.fromEntries(selected.map(id => [id, false])) } } }]) },
    { label: 'Remove from current step', disabled: !stepId || getStep()?.final, action: async () => { if (picking?.stepId === stepId) { selected.forEach(id => picking!.ids.delete(id)); renderPicker(); renderScene(); } else if (getStep()) await commit([{ type: 'step.members', stepId: stepId!, partIds: getStep()!.partIds.filter(id => !selected.includes(id)) }]); } },
  ]);
});
app.addEventListener('dragstart', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-reorder],[data-assembly],[data-part]') : null; if (!target || !event.dataTransfer) return;
  if (merging || target.dataset.reorder && structureQuery.trim()) { event.preventDefault(); return; }
  const payload = target.dataset.reorder ? { type: 'step', id: target.dataset.reorder } : target.dataset.assembly ? { type: 'assembly', id: target.dataset.assembly } : { type: 'parts', ids: selected.includes(target.dataset.part!) ? selected : [target.dataset.part!] };
  event.dataTransfer.setData('application/manualstudio', JSON.stringify(payload)); event.dataTransfer.effectAllowed = payload.type === 'step' ? 'move' : 'copy';
  if (payload.type === 'step' && payload.id) stepReorder.start(payload.id, event);
});
app.addEventListener('dragover', event => {
  if (stepReorder.active) { stepReorder.over(event); return; }
  if (!event.dataTransfer?.types.includes('application/manualstudio')) return;
  const card = stepDropCard(event.target);
  highlightStepDrop(card);
  if (card) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
});
app.addEventListener('dragleave', event => {
  if (stepReorder.active) { stepReorder.leave(event); return; }
  const card = stepDropCard(event.target);
  if (card && card !== stepDropCard(event.relatedTarget)) highlightStepDrop();
});
app.addEventListener('dragend', () => { stepReorder.cancel(); highlightStepDrop(); });
app.addEventListener('drop', event => {
  if (merging) { event.preventDefault(); return; }
  if (stepReorder.active) { const move = stepReorder.drop(event); if (move) void commit([{ type: 'step.reorder', ...move }]).catch(showError); return; }
  highlightStepDrop();
  const targetId = stepDropCard(event.target)?.dataset.step;
  if (!targetId) return;
  const raw = event.dataTransfer?.getData('application/manualstudio'); if (!raw) return; event.preventDefault();
  const data: unknown = JSON.parse(raw); if (!data || typeof data !== 'object' || !('type' in data)) return;
  const run = async (): Promise<void> => {
    if (data.type === 'assembly' && 'id' in data && typeof data.id === 'string') await addPartsToStep(targetId, [], data.id);
    else if (data.type === 'parts' && 'ids' in data && Array.isArray(data.ids) && data.ids.every((id): id is string => typeof id === 'string')) await addPartsToStep(targetId, data.ids);
  }; void run().catch(showError);
});
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  if (event.target instanceof Element && event.target.closest('#partTree')) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const order = event.key === 'Tab' ? [...document.querySelectorAll<HTMLElement>('#partTree [data-part]')].filter(row => !row.hidden).map(row => row.dataset.part!) : visibleListOrder(); if (!order.length) return;
      event.preventDefault(); const direction = event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? -1 : 1; const next = nextListPart(order, focusedListId ?? selected.at(-1), direction);
      if (next) { if (event.shiftKey && event.key !== 'Tab') selectListRange(next, event.ctrlKey); else { selectPart(next, false, true); focusListRow(next); } } return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selected = visibleListOrder(); view.select(selected); if (selected.length) revealPart(focusedListId ?? selected[0]); sendSession(); return; }
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); void undoAction(event.shiftKey).catch(showError); return; }
  if (event.ctrlKey && event.key.toLowerCase() === 'y') { event.preventDefault(); void undoAction(true).catch(showError); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') { stopPlayback(); document.querySelector('.popup-menu')?.remove(); if (merging) cancelMerge(); if (picking) { picking = undefined; document.querySelector('.object-picker')?.remove(); renderScene(); } activeNoteId = undefined; setTool('select'); }
  if (event.key.toLowerCase() === 'm') setTool('move'); if (event.key.toLowerCase() === 'r') setTool('rotate');
  if (event.key.toLowerCase() === 'f') view.fit(selected.length ? selected : undefined, 1.2); if (event.key === 'Home') view.fit(undefined, 1);
  if (event.key === ' ' && getStep()) { event.preventDefault(); startPlayback(); }
  if (event.key === 'ArrowRight') goFrame(1); if (event.key === 'ArrowLeft') goFrame(-1);
  if (event.key === 'Delete' && activeNoteId && getFrame()) void commit([{ type: 'note.delete', stepId: stepId!, frameId: getFrame()!.id, noteId: activeNoteId }]).catch(showError);
});
async function saveArchive(): Promise<void> { if (!project) return; busy('Saving portable project…'); try { const response = await fetch(`/api/projects/${project.id}/archive`); if (!response.ok) throw new Error(await response.text()); download({ blob: await response.blob(), filename: `${project.name.replace(/[<>:"/\\|?*]/g, '-')}.manualstudio` }); } finally { busy(); } }
async function openArchive(): Promise<void> { const file = await pickFile('.manualstudio'); if (!file) return; busy('Opening project archive…'); try { const next = await request<Project>('/api/open-archive', { method: 'POST', body: file }); await openProject(next.id); } finally { busy(); } }
function showHelp(): void {
  modal('ManualStudio controls', `<p><b>3D workspace</b><br>Drag empty space to orbit. Middle-drag to pan. Wheel to zoom. Click a part to select it. Right-click a part to select it and open the assembly menu. Drop parts anywhere on an assembly step card. In Overall preview, you can keep adding parts without changing views. Use Unassembled only to show parts that have not been added to an operation. Ctrl-click toggles selection. Shift-click in Assembly list selects a continuous range; Tab / Shift+Tab selects the next / previous part. Click empty space to clear selection. Alt-click cycles through overlapping parts and selects an individual part inside a subassembly.</p><p><b>Names</b><br>Double-click a name in the Assembly list or a 3D name tag to rename it in place. Enter or clicking away saves; Escape cancels. Middle-click the list row or name tag to focus it. Right-click a 3D name tag to copy its full name.</p><p><b>3D navigator</b><br>Click a face, edge or corner for one of 26 preset directions. Drag the cube to orbit with Z up. Chrome keeps Ctrl+1–9 for tab switching and Ctrl+S for Save page. ManualStudio does not intercept these shortcuts. Use the view cube for standard directions and Save update to record a frame.</p><p><b>Shortcuts</b><br>M Move · R Rotate · F Fit selected · Home Fit all · Esc Select · Space Play / Pause · ← / → Previous / Next frame · Ctrl+Z Undo · Ctrl+Y or Ctrl+Shift+Z Redo</p><p><b>Surface tools</b><br>Connection types and notes attach to 3D points, parts, connected faces or cylindrical bands. Glue supports a whole face, circular patch, multiple bands and brush strokes. Select Remove to animate support removal.</p><p><b>Agent API</b><br>Local endpoint: <code>http://127.0.0.1:4189/api</code><br>Command line: <code>npm run cli -- help</code><br>Commands update the same saved project and refresh this workspace automatically. See <code>Agent Guide.md</code> in the application folder.</p><p><a href="https://github.com/bambulab/BambuStudio/tree/v02.09.01.70/src/slic3r/GUI/Overview" target="_blank" rel="noreferrer">Bambu Studio Assembly source reference</a></p>`, [{ label: 'Close', primary: true, action: root => root.remove() }]);
}
const events = new EventSource('/api/events');
events.addEventListener('project', event => { const data = JSON.parse((event as MessageEvent<string>).data) as { projectId: string; revision: number }; if (data.projectId !== project?.id || data.revision === project.revision) return; if (saving || exporting) pendingReload = true; else void reloadExternal().catch(showError); });
events.addEventListener('session', event => {
  const data = JSON.parse((event as MessageEvent<string>).data) as { projectId: string; state: Partial<SessionState>; changes: Partial<SessionState>; origin?: string }; if (data.projectId !== project?.id || exporting || data.origin === sessionOrigin) return; const state = data.changes;
  suppressSession = true;
  try { applySessionState(state); } finally { suppressSession = false; }
});
events.addEventListener('render', event => { const job = JSON.parse((event as MessageEvent<string>).data) as ExportJob; if (job.projectId === project?.id) void doExport(job.kind, job).catch(showError); });
interface ManualStudioApi { getProject(): Project | undefined; getSession(): SessionState; command(commands: Command[]): Promise<void>; openStep(id: string | null): void; selectParts(ids: string[]): void; capture(): string; view: Viewport; export(kind: ExportKind): Promise<void>; }
declare global { interface Window { manualStudio: ManualStudioApi } }
window.manualStudio = { getProject: () => project && copy(project), getSession: session, command: commands => commit(commands), openStep, selectParts: ids => { selected = ids; selectedAxis = undefined; view.select(ids); if (ids[0]) revealPart(ids[0]); updateTreeSelection(); updateSelectionInfo(); sendSession(); }, capture: () => view.capture().toDataURL(), view, export: kind => doExport(kind) };
void (async () => {
  await refreshProjects(); const params = new URLSearchParams(location.search); const savedId = params.get('project') ?? localStorage.getItem('manualstudio-assembly-project'); const list = await request<{ id: string }[]>('/api/projects'); const initial = list.find(p => p.id === savedId) ?? list.at(-1);
  if (initial) await openProject(initial.id); else render();
  const jobId = params.get('render'); if (jobId && project) {
    try {
      const job = await request<ExportJob>(`/api/render/${jobId}`);
      if (!job.scope) {
        const state = await request<Partial<SessionState> | null>(`/api/projects/${project.id}/session`); if (state) applySessionState(state);
      }
      await doExport(job.kind, job);
    } finally { document.documentElement.dataset.renderComplete = 'true'; }
  }
})().catch(showError);
