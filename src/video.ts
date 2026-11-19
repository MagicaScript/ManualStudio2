import { videoFrameRate } from '../shared/video-format.ts';

type RenderFrame = (segmentIndex: number, progress: number, first: boolean) => boolean | void;

export function videoSegments(durations: number[]): { firstFrame: number; count: number }[] {
  let seconds = 0, firstFrame = 0;
  return durations.map(duration => {
    seconds += duration;
    const count = Math.max(1, Math.round(seconds * videoFrameRate) - firstFrame);
    const segment = { firstFrame, count }; firstFrame += count; return segment;
  });
}

async function recordFrames(segments: ReturnType<typeof videoSegments>, render: RenderFrame,
  add: (index: number, changed: boolean) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let lastYield = performance.now();
  for (const [segmentIndex, { firstFrame, count }] of segments.entries()) {
    for (let sample = 0; sample < count; sample++) {
      signal?.throwIfAborted();
      const progress = count === 1 ? 1 : sample / (count - 1);
      const changed = render(segmentIndex, progress, sample === 0) !== false;
      await add(firstFrame + sample, changed);
      if (performance.now() - lastYield >= 50) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  }
  signal?.throwIfAborted();
}

/** Preserve the final authored pose and visibility, including when a transition is one frame long. */
export async function captureVideoFrames(canvas: HTMLCanvasElement, durations: number[], render: RenderFrame, signal?: AbortSignal): Promise<Blob> {
  const frames: Blob[] = [];
  let previous: Blob | undefined;
  await recordFrames(videoSegments(durations), render, async (_index, changed) => {
    if (changed || !previous) previous = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Could not capture a video frame.'));
    }, 'image/png'));
    frames.push(previous);
  }, signal);
  return new Blob(frames, { type: 'image/x-png-sequence' });
}

/** Encode directly from the rendered canvas when this Chrome or Edge can encode AVC. */
export async function captureAvc(canvas: HTMLCanvasElement, durations: number[], render: RenderFrame, signal?: AbortSignal): Promise<Blob | undefined> {
  if (typeof VideoEncoder === 'undefined') return;
  signal?.throwIfAborted();
  const { BufferTarget, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource, canEncodeVideo } = await import('mediabunny');
  const config = { quality: new Quality({ bitrate: 20_000_000 }), latencyMode: 'quality' as const, contentHint: 'detail' as const };
  if (!await canEncodeVideo('avc', { ...config, width: canvas.width, height: canvas.height, frameRate: videoFrameRate })) return;
  signal?.throwIfAborted();
  const segments = videoSegments(durations), frameCount = segments.reduce((total, segment) => total + segment.count, 0);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
  let encodedFrames = 0;
  const source = new VideoSampleSource({ codec: 'avc', ...config, onEncodedPacket: () => { encodedFrames++; } });
  output.addVideoTrack(source, { frameRate: videoFrameRate, maximumPacketCount: frameCount });
  let renderFailed = false;
  let previous: InstanceType<typeof VideoSample> | undefined;
  try {
    await output.start();
    await recordFrames(segments, (...args) => {
      try { return render(...args); }
      catch (error) { renderFailed = true; throw error; }
    }, async (index, changed) => {
      const timestamp = index / videoFrameRate;
      if (changed || !previous) {
        previous?.close();
        previous = new VideoSample(canvas, { timestamp, duration: 1 / videoFrameRate });
      } else previous.setTimestamp(timestamp);
      await source.add(previous);
    }, signal);
    await output.finalize();
    signal?.throwIfAborted();
    if (!output.target.buffer || encodedFrames !== frameCount) return;
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (error) {
    signal?.throwIfAborted();
    if (renderFailed) throw error;
  } finally {
    previous?.close();
    if (output.state === 'started') await output.cancel();
  }
}
