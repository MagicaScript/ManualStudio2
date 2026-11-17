const framesPerSecond = 30;

export function videoSegments(durations: number[]): { firstFrame: number; count: number }[] {
  let seconds = 0, firstFrame = 0;
  return durations.map(duration => {
    seconds += duration;
    const count = Math.max(1, Math.round(seconds * framesPerSecond) - firstFrame);
    const segment = { firstFrame, count }; firstFrame += count; return segment;
  });
}

function ivfHeader(width: number, height: number, count: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DKIF')); view.setUint16(6, 32, true);
  bytes.set(new TextEncoder().encode('VP90'), 8); view.setUint16(12, width, true); view.setUint16(14, height, true);
  view.setUint32(16, framesPerSecond, true); view.setUint32(20, 1, true); view.setUint32(24, count, true);
  return bytes;
}

/** Frame timestamps follow the authored timeline, independently of rendering speed. */
export async function encodeVideoFrames(canvas: HTMLCanvasElement, durations: number[], renderFrame: (segmentIndex: number, progress: number) => void, signal?: AbortSignal): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') throw new Error('Video export requires Chrome or Edge with WebCodecs support.');
  const config: VideoEncoderConfig = { codec: 'vp09.00.31.08', width: canvas.width, height: canvas.height, bitrate: 6500000, framerate: framesPerSecond, latencyMode: 'realtime' };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('The browser cannot encode the assembly video.');
  const segments = videoSegments(durations), count = segments.reduce((sum, segment) => sum + segment.count, 0);
  const packets: Uint8Array<ArrayBuffer>[] = []; let encoderError: DOMException | undefined;
  const check = (): void => { if (signal?.aborted) throw new Error('Export cancelled.'); if (encoderError) throw encoderError; };
  const encoder = new VideoEncoder({
    output: chunk => {
      const index = Math.round(chunk.timestamp * framesPerSecond / 1000000);
      const packet = new Uint8Array(12 + chunk.byteLength), header = new DataView(packet.buffer);
      header.setUint32(0, chunk.byteLength, true); header.setBigUint64(4, BigInt(index), true); chunk.copyTo(packet.subarray(12)); packets[index] = packet;
    },
    error: error => { encoderError = error; },
  });
  try {
    encoder.configure(config);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      for (let sample = 0; sample < segment.count; sample++) {
        check(); const index = segment.firstFrame + sample;
        // Include the exact endpoint so final assembly poses and removals reach the encoded video.
        renderFrame(segmentIndex, segment.count === 1 ? 1 : sample / (segment.count - 1));
        const timestamp = Math.round(index * 1000000 / framesPerSecond);
        const frame = new VideoFrame(canvas, { timestamp, duration: Math.round((index + 1) * 1000000 / framesPerSecond) - timestamp });
        try { encoder.encode(frame, { keyFrame: sample === 0 }); } finally { frame.close(); }
        if (encoder.encodeQueueSize >= 8) { await encoder.flush(); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
      }
    }
    await encoder.flush(); check();
    if (packets.length !== count || Array.from({ length: count }, (_, index) => packets[index]).some(packet => !packet)) throw new Error('The video encoder omitted a frame.');
    return new Blob([ivfHeader(canvas.width, canvas.height, count), ...packets], { type: 'video/x-ivf' });
  } finally { if (encoder.state !== 'closed') encoder.close(); }
}
