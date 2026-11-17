import { jsPDF } from 'jspdf';
import { zipSync, strToU8 } from 'fflate';
import { frameQueue } from '../shared/document.ts';
import type { Project } from '../shared/types.ts';
import type { Viewport } from './viewport.ts';
import { encodeVideoFrames } from './video.ts';
import { playbackCard, playbackDuration, playbackFrame, playbackPlan } from '../shared/playback.ts';
import { drawPlaybackCard } from './playback-card.ts';

export interface ExportFile { blob: Blob; filename: string }
export type ExportKind = 'png' | 'pdf' | 'markdown' | 'mp4' | 'json';
const pause = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
const name = (value: string): string => value.replace(/[<>:"/\\|?*]/g, '-').slice(0, 100);
function bytes(dataUrl: string): Uint8Array { return Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0)); }
function blob(canvas: HTMLCanvasElement): Promise<Blob> { return new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image capture failed.')), 'image/png')); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Export cancelled.'); }
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []; for (const paragraph of text.split('\n')) { let line = ''; for (const character of paragraph) { if (context.measureText(line + character).width > width && line) { lines.push(line); line = ''; } line += character; } lines.push(line); } return lines;
}
export async function exportProject(project: Project, view: Viewport, kind: ExportKind, progress: (text: string) => void, signal?: AbortSignal, playbackSpeed = 1): Promise<ExportFile> {
  const title = project.settings.title || project.name; const basename = name(title);
  if (kind === 'json') return { blob: new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), filename: `${basename}.manualstudio.json` };
  await view.prepareCapture();
  if (kind === 'png') return { blob: await blob(view.capture()), filename: `${basename}.png` };
  const presentation: Project = { ...project, settings: { ...project.settings, showAxes: false, showConstructionAxes: false } };
  const queue = frameQueue(project); if (!queue.length) throw new Error('Create an assembly step before exporting.');
  const selectedOutline = view.outline.selectedObjects, savedSection = view.sectionState(); view.outline.selectedObjects = []; view.transform.detach(); view.setSection(0);
  try {
    if (kind === 'mp4') return await exportVideo(presentation, view, basename, progress, signal, playbackSpeed);
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    const archive: Record<string, Uint8Array> = {}; let markdown = `# ${title}\n\n`; let pageCount = 0;
    const addPage = (canvas: HTMLCanvasElement): void => { if (pageCount++) pdf.addPage(); pdf.addImage(canvas.toDataURL('image/jpeg', .92), 'JPEG', 0, 0, 210, 297); };
    if (kind === 'pdf') {
      const cover = document.createElement('canvas'); cover.width = 1240; cover.height = 1754; const context = cover.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, cover.width, cover.height); context.fillStyle = '#262e30'; context.font = 'bold 52px Segoe UI'; wrap(context, title, 1040).forEach((line, i) => context.fillText(line, 100, 190 + i * 70));
      if (project.settings.coverImage) { const image = new Image(); image.src = project.settings.coverImage; await image.decode(); context.drawImage(image, 100, 450, 1040, 780); }
      context.fillStyle = '#656a6b'; context.font = '25px Segoe UI'; context.fillText(`${project.steps.length} assembly steps · ${project.model.parts.filter(p => p.sourceStatus === 'active').length} parts`, 100, 1510); context.fillText('Assembly Guide', 100, 1560); addPage(cover);
      if (project.settings.secondPageImage) { const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1240, 1754); const image = new Image(); image.src = project.settings.secondPageImage; await image.decode(); const scale = Math.min(1140 / image.width, 1654 / image.height); ctx.drawImage(image, (1240 - image.width * scale) / 2, (1754 - image.height * scale) / 2, image.width * scale, image.height * scale); addPage(canvas); }
    }
    let page: HTMLCanvasElement | undefined, pageContext: CanvasRenderingContext2D | undefined, lastStepId = '', slot = 0;
    const finishPage = (): void => {
      if (!page || !pageContext) return;
      pageContext.fillStyle = '#777'; pageContext.font = '18px Segoe UI'; pageContext.fillText(`${title} · ${pageCount + 1}`, 75, 1695);
      addPage(page); page = undefined; pageContext = undefined;
    };
    for (let i = 0; i < queue.length; i++) {
      check(signal); const { step, frame } = queue[i]; const stepNumber = project.steps.indexOf(step) + 1; progress(`Exporting ${stepNumber}: ${frame.name} (${i + 1}/${queue.length})`);
      view.show(presentation, step, frame, 'current'); if (frame.camera) view.setCamera(frame.camera); else view.fit(step.partIds, 1.2); await pause(); const capture = view.capture();
      if (kind === 'markdown') {
        const file = `images/step-${String(stepNumber).padStart(2, '0')}-frame-${step.frames.indexOf(frame) + 1}.png`; archive[file] = bytes(capture.toDataURL()); markdown += `## ${stepNumber}. ${step.name} — ${frame.name}\n\n![${step.name}](${file})\n\n${step.description}\n\n`;
        for (const note of frame.notes) markdown += `- **${note.kind}**: ${note.text || note.kind}${note.anchors.some(a => a.needsReview) ? ' (attachment needs review after model update)' : ''}\n`;
        markdown += '\nParts: ' + step.partIds.map(id => project.model.parts.find(p => p.id === id)?.name ?? id).join(', ') + '\n\n'; continue;
      }
      if (!page || lastStepId !== step.id || slot === 2) {
        finishPage(); page = document.createElement('canvas'); page.width = 1240; page.height = 1754; pageContext = page.getContext('2d')!;
        pageContext.fillStyle = '#fff'; pageContext.fillRect(0, 0, page.width, page.height); pageContext.fillStyle = '#222'; pageContext.font = '36px Segoe UI';
        wrap(pageContext, `Step ${stepNumber}  ${step.name}`, 1090).slice(0, 2).forEach((line, index) => pageContext!.fillText(line, 75, 100 + index * 43));
        slot = 0; lastStepId = step.id;
      }
      const context = pageContext!; const top = 180 + slot * 665;
      context.fillStyle = '#222'; context.font = '25px Segoe UI'; context.fillText(`Step ${stepNumber}.${step.frames.indexOf(frame) + 1}  ${frame.name}`, 75, top);
      const ratio = Math.min(1090 / capture.width, 600 / capture.height); context.drawImage(capture, 75 + (1090 - capture.width * ratio) / 2, top + 18, capture.width * ratio, capture.height * ratio);
      slot++;
      if (i === queue.length - 1 || queue[i + 1].step.id !== step.id) {
        context.fillStyle = '#303438'; context.font = '22px Segoe UI'; wrap(context, step.description, 1090).slice(0, 3).forEach((line, index) => context.fillText(line, 75, 1570 + index * 28));
        finishPage();
      }
    }
    finishPage();
    if (kind === 'markdown') { archive['Assembly Guide.md'] = strToU8(markdown); return { blob: new Blob([zipSync(archive, { level: 3 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), filename: `${basename} - Markdown.zip` }; }
    return { blob: pdf.output('blob'), filename: `${basename}.pdf` };
  } finally { view.outline.selectedObjects = selectedOutline; view.restoreSection(savedSection); }
}
async function exportVideo(project: Project, view: Viewport, basename: string, progress: (text: string) => void, signal: AbortSignal | undefined, playbackSpeed: number): Promise<ExportFile> {
  const segments = playbackPlan(project); const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const context = canvas.getContext('2d')!;
  let lastSegment = -1;
  const video = await encodeVideoFrames(canvas, segments.map(segment => playbackDuration(segment, playbackSpeed)), (index, t) => {
    const segment = segments[index], { step } = segment;
    const entering = lastSegment !== index; lastSegment = index;
    if (entering || t === 1) progress(`Rendering ${step.name} · ${segment.kind === 'motion' ? segment.to.name : segment.kind}`);
    const card = playbackCard(project, segment); if (card) { drawPlaybackCard(context, canvas.width, canvas.height, card); return; }
    const frame = playbackFrame(segment, t); view.show(project, step, frame, 'current'); if (frame.camera) view.setCamera(frame.camera); else if (entering) view.fit(step.partIds, 1.2);
    const capture = view.capture(); context.fillStyle = '#53545b'; context.fillRect(0, 0, canvas.width, canvas.height); const ratio = Math.min(canvas.width / capture.width, canvas.height / capture.height); context.drawImage(capture, (canvas.width - capture.width * ratio) / 2, (canvas.height - capture.height * ratio) / 2, capture.width * ratio, capture.height * ratio);
  }, signal);
  check(signal); progress('Encoding MP4…'); const response = await fetch('/api/export/video', { method: 'POST', body: video }); const result = await response.json() as { url?: string; error?: string }; if (!response.ok || !result.url) throw new Error(result.error ?? 'MP4 encoding failed.'); return { blob: await (await fetch(result.url)).blob(), filename: `${basename}.mp4` };
}
export function download(file: ExportFile): void { const url = URL.createObjectURL(file.blob); const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
