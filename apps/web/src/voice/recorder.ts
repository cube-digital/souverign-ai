export type Rec = { bytes: Uint8Array; mime: string; durationMs: number };
export type Recording = { stop(): Promise<Rec | null>; cancel(): void };

const MIMES = ["audio/webm;codecs=opus", "audio/mp4"];
const MIN_MS = 500;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

/** Records the microphone until stop(), cancel() or maxMs. A recording under 500 ms is discarded (null). */
export async function startRecording(opts: {
  maxMs?: number;
  onAutoStop?: (rec: Rec | null) => void;
}): Promise<Recording> {
  const maxMs = opts.maxMs ?? 60_000;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const releaseTracks = () => {
    for (const t of stream.getTracks()) t.stop();
  };
  let recorder: MediaRecorder;
  let mime: string;
  try {
    mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    if (!mime) mime = recorder.mimeType;
  } catch (e) {
    releaseTracks();
    throw e;
  }
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    const data = (e as BlobEvent).data;
    if (data && data.size > 0) chunks.push(data);
  });
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Promise<Rec | null> | null = null;
  let cancelled = false;

  const finish = (): Promise<Rec | null> => {
    if (result) return result;
    clearTimeout(timer);
    const durationMs = Math.min(Date.now() - startedAt, maxMs);
    result = new Promise<Rec | null>((resolve) => {
      const done = async () => {
        releaseTracks();
        if (cancelled || durationMs < MIN_MS || chunks.length === 0) return resolve(null);
        resolve({ bytes: await bytesOf(new Blob(chunks, { type: mime })), mime, durationMs });
      };
      if (recorder.state === "inactive") return void done();
      recorder.addEventListener("stop", () => void done());
      recorder.stop();
    });
    return result;
  };

  recorder.start();
  timer = setTimeout(() => void finish().then((r) => opts.onAutoStop?.(r)), maxMs);
  return {
    stop: finish,
    cancel() {
      cancelled = true;
      void finish();
    },
  };
}
