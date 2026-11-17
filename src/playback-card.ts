import type { PlaybackCard } from '../shared/playback.ts';
import { wrapLabelText } from '../shared/text-layout.ts';

export function drawPlaybackCard(context: CanvasRenderingContext2D, width: number, height: number, card: PlaybackCard): void {
  context.fillStyle = '#53545b'; context.fillRect(0, 0, width, height); context.fillStyle = '#fff';
  const size = Math.min(48, width / 20); context.font = `${size}px Segoe UI`;
  const lines = wrapLabelText(card.title, width * .82, text => context.measureText(text).width), lineHeight = size * 1.25;
  const top = (height - lines.length * lineHeight) / 2; context.textBaseline = 'top'; context.textAlign = 'center';
  lines.forEach((line, index) => context.fillText(line, Math.floor(width / 2), Math.floor(top + index * lineHeight)));
  if (card.subtitle) {
    const titleWidth = Math.max(...lines.map(line => context.measureText(line).width));
    context.font = `${Math.max(14, size / 3)}px Segoe UI`; context.textAlign = 'right';
    context.fillText(card.subtitle, Math.floor((width + titleWidth) / 2), Math.floor(top + lines.length * lineHeight + 6));
  }
  context.textAlign = 'start'; context.textBaseline = 'alphabetic';
}
