import { escape } from './ui.ts';

interface ColorPreset {
  name: string;
  value: string;
}

// Bambu Studio 2.9.1.7, AssemblyStepsUtilsInternal.hpp, kNoteColors.
export const NOTE_COLOR_PRESETS: readonly ColorPreset[] = [
  { name: 'Red', value: '#d53d40' },
  { name: 'Orange', value: '#f09f13' },
  { name: 'Green', value: '#23a92e' },
  { name: 'Blue', value: '#3f82f0' },
  { name: 'Black', value: '#1d202d' },
  { name: 'Grey', value: '#7d7f86' },
  { name: 'White', value: '#ffffff' },
];

export const NOTE_BACKGROUND_PRESETS: readonly ColorPreset[] = [
  { name: 'Dark red', value: '#682b30' },
  { name: 'Dark orange', value: '#70490d' },
  { name: 'Dark green', value: '#1e572b' },
  { name: 'Dark blue', value: '#234679' },
  { name: 'Black', value: '#141722' },
  { name: 'Charcoal', value: '#292d34' },
  { name: 'Slate', value: '#30343c' },
];

export function isShapeNote(kind: string): boolean {
  return kind === 'rectangle' || kind === 'circle' || kind === 'arrow';
}

export function noteColorPalette(id: string, property: 'color' | 'background', value: string, noteId = ''): string {
  const presets = property === 'color' ? NOTE_COLOR_PRESETS : NOTE_BACKGROUND_PRESETS;
  const label = property === 'color' ? 'Color' : 'Background';
  const current = value.toLowerCase();
  const buttons = presets.map(preset => `<button type="button" class="annotation-swatch" data-preset-color="${preset.value}" aria-label="${preset.name}" aria-pressed="${current === preset.value}" title="${preset.name}"><span style="background:${preset.value}"></span></button>`).join('');
  const savedColor = presets.some(preset => preset.value === current) ? '' : `<span class="annotation-swatch saved-note-color" style="--saved-color:${escape(value)}" role="img" aria-label="Current color ${escape(value)}" title="Current color (${escape(value)})"></span>`;
  return `<div class="note-color-field"><span id="${id}Label">${label}</span><div id="${id}" class="annotation-palette" role="group" aria-labelledby="${id}Label" data-color-property="${property}" data-note-id="${escape(noteId)}">${buttons}${savedColor}</div></div>`;
}
