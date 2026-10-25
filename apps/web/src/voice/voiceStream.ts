export type VoiceChunk = { seq: number; wav_b64: string; text?: string };

let ctx: AudioContext | null = null;
const players = new Set<VoicePlayer>();

function audioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  return ctx;
}

function toBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Plays the `voice.chunk` WAVs of one source in seq order. A late lower seq is dropped. */
export class VoicePlayer {
  private pending = new Map<number, VoiceChunk>();
  private next = 0;
  private running = false;
  private stopped = false;
  private current: AudioBufferSourceNode | null = null;
  private started = false;

  constructor(
    readonly sourceId: string,
    private opts: { onFirstAudio?: () => void } = {},
  ) {
    players.add(this);
  }

  push(chunk: VoiceChunk): void {
    if (this.stopped || chunk.seq < this.next) return;
    this.pending.set(chunk.seq, chunk);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    this.current?.stop();
    players.delete(this);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const chunk = this.pending.get(this.next);
        if (!chunk) break;
        this.pending.delete(this.next);
        this.next++;
        const c = audioContext();
        if (c.state === "suspended") await c.resume();
        const buffer = await c.decodeAudioData(toBuffer(chunk.wav_b64));
        if (this.stopped) break;
        await new Promise<void>((resolve) => {
          const src = c.createBufferSource();
          src.buffer = buffer;
          src.connect(c.destination);
          src.onended = () => resolve();
          this.current = src;
          src.start();
          if (!this.started) {
            this.started = true;
            this.opts.onFirstAudio?.();
          }
        });
        this.current = null;
      }
    } catch {
      // an undecodable chunk ends this reply's audio; the text reply is unaffected
    } finally {
      this.running = false;
    }
  }
}

/** Stops every voice reply that is playing; called when the user starts a new recording. */
export function stopAll(): void {
  for (const p of [...players]) p.stop();
}
