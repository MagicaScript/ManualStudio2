import { jsPDF } from 'jspdf';
import { zipSync, strToU8 } from 'fflate';
import { frameQueue } from '../shared/document.ts';
import type { DisplayMode, LabelLayoutRequest, Project } from '../shared/types.ts';
import { wrapLabelText } from '../shared/text-layout.ts';
import type { Viewport } from './viewport.ts';
import { captureAvc, captureVideoFrames, videoSegments } from './video.ts';
import { videoHeight, videoWidth } from '../shared/video-format.ts';
import { continuousBoundary, framePlayback, playbackCard, playbackDuration, playbackPlan } from '../shared/playback.ts';
import { renderImageSample, renderVideoSlices, type RenderScope } from '../shared/render-scope.ts';
import { drawPlaybackCard } from './playback-card.ts';

export interface ExportFile { blob: Blob; filename: string }
export type ExportKind = 'png' | 'pdf' | 'markdown' | 'mp4' | 'json';
interface ExportOptions { display: DisplayMode; playbackSpeed: number; signal?: AbortSignal; scope?: RenderScope }
const PDF_CONTENT_WIDTH = 1090;
const PDF_CONTENT_TOP = 180;
const PDF_DESCRIPTION_BOTTOM = 1650;
const PDF_DESCRIPTION_FONT = '22px Segoe UI';
const PDF_DESCRIPTION_GAP = 42;
const PDF_DESCRIPTION_LINE_HEIGHT = 28;
export async function inspectLabelLayout(project: Project, view: Viewport, { frameId, progress }: LabelLayoutRequest, display: DisplayMode, signal?: AbortSignal) {
  const segment = framePlayback(project, frameId), { step, duration } = segment;
  const section = view.sectionState(); view.setSection(0);
  try {
    await view.prepareCapture();
    const samples = await view.withVideoSize(async () => progress.map(value => {
      check(signal);
      view.showPlayback(project, segment, value, display);
      const { width, height, labels } = view.labelLayout();
      return { progress: value, seconds: value * duration, viewport: { width, height }, labels };
    }));
    return { projectId: project.id, revision: project.revision, stepId: step.id, frameId, nextFrameId: segment.kind === 'motion' ? segment.to.id : null, duration, display, coordinateSpace: 'viewport-css-pixels', samples };
  } finally { view.restoreSection(section); }
}
const pause = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
const name = (value: string): string => value.replace(/[<>:"/\\|?*]/g, '-').slice(0, 100);
function bytes(dataUrl: string): Uint8Array { return Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0)); }
function blob(canvas: HTMLCanvasElement): Promise<Blob> { return new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image capture failed.')), 'image/png')); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Export cancelled.'); }
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []; for (const paragraph of text.split('\n')) { let line = ''; for (const character of paragraph) { if (context.measureText(line + character).width > width && line) { lines.push(line); line = ''; } line += character; } lines.push(line); } return lines;
}
function drawPdfDescription(context: CanvasRenderingContext2D, paragraphs: string[][], baseline: number, continuePage: () => CanvasRenderingContext2D): void {
  for (const lines of paragraphs) {
    for (let offset = 0; offset < lines.length;) {
      const remaining = lines.length - offset;
      const available = Math.max(0, Math.floor((PDF_DESCRIPTION_BOTTOM - baseline) / PDF_DESCRIPTION_LINE_HEIGHT) + 1);
      let count = Math.min(remaining, available);
      // Keep at least two lines of a split paragraph on each page.
      if (remaining - count === 1 && count > 1) count--;
      if (count === 0 || (count === 1 && remaining > 1)) {
        context = continuePage();
        baseline = PDF_CONTENT_TOP;
        continue;
      }
      context.fillStyle = '#303438'; context.font = PDF_DESCRIPTION_FONT;
      for (const line of lines.slice(offset, offset + count)) {
        context.fillText(line, 75, baseline);
        baseline += PDF_DESCRIPTION_LINE_HEIGHT;
      }
      offset += count;
    }
  }
}
export async function exportProject(project: Project, view: Viewport, kind: ExportKind, progress: (text: string) => void, options: ExportOptions): Promise<ExportFile> {
  const { display, signal, scope } = options;
  const title = project.settings.title || project.name; const basename = name(scope ? `${title} - ${scope.frameId ? 'Keyframe' : scope.time !== undefined || scope.range ? 'Timeline' : 'Step'}` : title);
  if (kind === 'json') return { blob: new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), filename: `${basename}.manualstudio.json` };
  await view.prepareCapture();
  if (kind === 'png' && !scope) return { blob: await blob(view.capture()), filename: `${basename}.png` };
  const presentation: Project = { ...project, settings: { ...project.settings, showAxes: false, showConstructionAxes: false } };
  const queue = frameQueue(project); if (!queue.length) throw new Error('Create an assembly step before exporting.');
  const selectedOutline = view.outline.selectedObjects, savedSection = view.sectionState(); view.outline.selectedObjects = []; view.transform.detach(); view.setSection(0);
  try {
    if (kind === 'png') {
      check(signal);
      const sample = renderImageSample(presentation, scope!);
      const card = playbackCard(presentation, sample.segment);
      if (card) {
        const canvas = document.createElement('canvas'); canvas.width = videoWidth; canvas.height = videoHeight;
        drawPlaybackCard(canvas.getContext('2d')!, canvas.width, canvas.height, card);
        return { blob: await blob(canvas), filename: `${basename}.png` };
      }
      return await view.withVideoSize(async () => {
        view.showPlayback(presentation, sample.segment, sample.progress, display);
        return { blob: await blob(view.capture()), filename: `${basename}.png` };
      });
    }
    if (kind === 'mp4') return await exportVideo(presentation, view, basename, progress, options);
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    const archive: Record<string, Uint8Array> = {}; let markdown = `# ${title}\n\n`; let pageCount = 0;
    const addPage = (canvas: HTMLCanvasElement): void => { if (pageCount++) pdf.addPage(); pdf.addImage(canvas.toDataURL('image/jpeg', .92), 'JPEG', 0, 0, 210, 297); };
    if (kind === 'pdf') {
      const cover = document.createElement('canvas'); cover.width = 1240; cover.height = 1754; const context = cover.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, cover.width, cover.height); context.fillStyle = '#262e30'; context.font = 'bold 52px Segoe UI'; wrap(context, title, 1040).forEach((line, i) => context.fillText(line, 100, 190 + i * 70));
      if (project.settings.coverImage) { const image = new Image(); image.src = project.settings.coverImage; await image.decode(); context.drawImage(image, 100, 450, 1040, 780); }
      context.fillStyle = '#656a6b'; context.font = '25px Segoe UI'; context.fillText(`${project.steps.length} assembly steps · ${project.model.parts.filter(p => p.sourceStatus === 'active').length} parts`, 100, 1510); context.fillText('Assembly Guide', 100, 1560); addPage(cover);
      if (project.settings.secondPageImage) { const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1240, 1754); const image = new Image(); image.src = project.settings.secondPageImage; await image.decode(); const scale = Math.min(1140 / image.width, 1654 / image.height); ctx.drawImage(image, (1240 - image.width * scale) / 2, (1754 - image.height * scale) / 2, image.width * scale, image.height * scale); addPage(canvas); }
    }
    let page: HTMLCanvasElement | undefined, pageContext: CanvasRenderingContext2D | undefined, slot = 0;
    const finishPage = (): void => {
      if (!page || !pageContext) return;
      pageContext.fillStyle = '#777'; pageContext.font = '18px Segoe UI'; pageContext.fillText(`${title} · ${pageCount + 1}`, 75, 1695);
      addPage(page); page = undefined; pageContext = undefined;
    };
    const startStepPage = (stepNumber: number, stepName: string, continued = false): CanvasRenderingContext2D => {
      finishPage();
      const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#222'; context.font = '36px Segoe UI';
      const heading = `Step ${stepNumber}${continued ? ' (continued)' : ''}  ${stepName}`;
      wrap(context, heading, PDF_CONTENT_WIDTH).slice(0, 2).forEach((line, index) => context.fillText(line, 75, 100 + index * 43));
      page = canvas; pageContext = context;
      return context;
    };
    for (let i = 0; i < queue.length; i++) {
      check(signal); const { step, frame } = queue[i]; const stepNumber = project.steps.indexOf(step) + 1; progress(`Exporting ${stepNumber}: ${frame.name} (${i + 1}/${queue.length})`);
      view.show(presentation, step, frame, display); if (frame.camera) view.setCamera(frame.camera); else view.fit(step.partIds, 1.2); await pause(); const capture = view.capture();
      if (kind === 'markdown') {
        const file = `images/step-${String(stepNumber).padStart(2, '0')}-frame-${step.frames.indexOf(frame) + 1}.png`; archive[file] = bytes(capture.toDataURL()); markdown += `## ${stepNumber}. ${step.name} — ${frame.name}\n\n![${step.name}](${file})\n\n${step.description}\n\n`;
        for (const note of frame.notes) markdown += `- **${note.kind}**: ${note.text || note.kind}${note.anchors.some(a => a.needsReview) ? ' (attachment needs review after model update)' : ''}\n`;
        markdown += '\nParts: ' + step.partIds.map(id => project.model.parts.find(p => p.id === id)?.name ?? id).join(', ') + '\n\n'; continue;
      }
      if (slot === 2) { finishPage(); slot = 0; }
      const context = pageContext ?? startStepPage(stepNumber, step.name); const top = PDF_CONTENT_TOP + slot * 665;
      context.fillStyle = '#222'; context.font = '25px Segoe UI'; context.fillText(`Step ${stepNumber}.${step.frames.indexOf(frame) + 1}  ${frame.name}`, 75, top);
      const lastFrame = queue[i + 1]?.step.id !== step.id;
      const description = lastFrame ? step.description.trim() : '';
      let paragraphs: string[][] = [];
      if (description) {
        context.font = PDF_DESCRIPTION_FONT;
        paragraphs = description.split(/\r\n?|\n/).map(paragraph => wrapLabelText(paragraph, PDF_CONTENT_WIDTH, line => context.measureText(line).width));
      }
      const imageTop = top + 18;
      let imageHeight = Math.min(600, capture.height * PDF_CONTENT_WIDTH / capture.width);
      if (slot === 1 && paragraphs.length) {
        const lineCount = paragraphs.reduce((total, lines) => total + lines.length, 0);
        const heightWithDescription = PDF_DESCRIPTION_BOTTOM - imageTop - PDF_DESCRIPTION_GAP - (lineCount - 1) * PDF_DESCRIPTION_LINE_HEIGHT;
        const overflow = imageHeight - heightWithDescription;
        if (overflow > 0 && overflow <= Math.min(PDF_DESCRIPTION_LINE_HEIGHT, imageHeight * .05)) imageHeight = heightWithDescription;
      }
      const imageWidth = capture.width * imageHeight / capture.height;
      context.drawImage(capture, 75 + (PDF_CONTENT_WIDTH - imageWidth) / 2, imageTop, imageWidth, imageHeight);
      slot++;
      if (lastFrame) {
        drawPdfDescription(context, paragraphs, imageTop + imageHeight + PDF_DESCRIPTION_GAP, () => {
          check(signal);
          return startStepPage(stepNumber, step.name, true);
        });
        finishPage(); slot = 0;
      }
    }
    finishPage();
    if (kind === 'markdown') { archive['Assembly Guide.md'] = strToU8(markdown); return { blob: new Blob([zipSync(archive, { level: 3 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), filename: `${basename} - Markdown.zip` }; }
    return { blob: pdf.output('blob'), filename: `${basename}.pdf` };
  } finally { view.outline.selectedObjects = selectedOutline; view.restoreSection(savedSection); }
}
async function exportVideo(project: Project, view: Viewport, basename: string, progress: (text: string) => void, { display, playbackSpeed, signal, scope }: ExportOptions): Promise<ExportFile> {
  const slices = scope ? renderVideoSlices(project, scope)
    : playbackPlan(project).map(segment => ({ segment, start: 0, end: 1, duration: playbackDuration(segment, playbackSpeed) }));
  if (!slices.length) throw new Error('The selected playback timeline has no frames.');
  const canvas = document.createElement('canvas'); canvas.width = videoWidth; canvas.height = videoHeight;
  const context = canvas.getContext('2d', { alpha: false })!;
  const durations = slices.map(slice => slice.duration);
  const sampleCounts = videoSegments(durations).map(({ count }) => count);
  const openEnds = slices.map(({ segment, end }, index) =>
    end === 1 && slices[index + 1]?.start === 0 && continuousBoundary(segment, slices[index + 1].segment));
  const drawFrame = (index: number, t: number, first: boolean): boolean => {
    const { segment, start, end } = slices[index], { step } = segment;
    if (segment.kind !== 'motion' && !first) return false;
    if (first) progress(`Rendering ${step.name} · ${segment.kind === 'motion' ? segment.to.name : segment.kind}`);
    const card = playbackCard(project, segment);
    if (card) drawPlaybackCard(context, canvas.width, canvas.height, card);
    else {
      // Draw each pass-through waypoint once, at the start of its outgoing segment.
      const count = sampleCounts[index], progress = openEnds[index] ? t * (count - 1) / count : t;
      view.showPlayback(project, segment, start + (end - start) * progress, display);
      view.drawCapture(context);
    }
    return true;
  };
  const frames = await view.withVideoSize(async () => {
    const encoded = await captureAvc(canvas, durations, drawFrame, signal);
    if (encoded) return encoded;
    progress('Preparing FFmpeg video export…');
    return captureVideoFrames(canvas, durations, drawFrame, signal);
  });
  check(signal);
  if (frames.type === 'video/mp4') return { blob: frames, filename: `${basename}.mp4` };
  progress('Encoding MP4…');
  const response = await fetch('/api/export/video', { method: 'POST', body: frames, signal });
  const result = await response.json() as { url?: string; error?: string };
  if (!response.ok || !result.url) throw new Error(result.error ?? 'MP4 encoding failed.');
  const file = await fetch(result.url, { signal });
  if (!file.ok) throw new Error('Could not download the encoded MP4.');
  return { blob: await file.blob(), filename: `${basename}.mp4` };
}
export function download(file: ExportFile): void { const url = URL.createObjectURL(file.blob); const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
