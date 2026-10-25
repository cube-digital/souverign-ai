import type { AudioClient } from "./audio-client.js";
import { SentenceSplitter, speakable } from "./sentences.js";
import { concatWav, wavDurationMs } from "./wav.js";

export const MAX_SPOKEN_CHARS = 600;
export type SpokenChunk = { seq: number; text: string; wav: Uint8Array };
export type SpeakResult = {
  wav: Uint8Array | null;
  durationMs: number;
  firstAudioAt: number | null;
};

export class Speaker {
  private splitter = new SentenceSplitter();
  private chain: Promise<void> = Promise.resolve();
  private parts: Uint8Array[] = [];
  private spokenChars = 0;
  private seq = 0;
  private aborted = false;
  private firstAudioAt: number | null = null;

  constructor(
    private audio: AudioClient,
    private language: string,
    private onChunk: (c: SpokenChunk) => void,
    private now: () => number = Date.now,
  ) {}

  push(delta: string): void {
    if (this.aborted) return;
    for (const s of this.splitter.push(delta)) this.enqueue(s);
  }

  async finish(): Promise<SpeakResult> {
    if (!this.aborted) for (const s of this.splitter.flush()) this.enqueue(s);
    await this.chain;
    if (this.aborted || this.parts.length === 0) {
      return { wav: null, durationMs: 0, firstAudioAt: this.firstAudioAt };
    }
    try {
      const wav = concatWav(this.parts);
      return { wav, durationMs: wavDurationMs(wav), firstAudioAt: this.firstAudioAt };
    } catch (e) {
      console.warn("voice: concat failed", (e as Error).name);
      return { wav: null, durationMs: 0, firstAudioAt: this.firstAudioAt };
    }
  }

  abort(): void {
    this.aborted = true;
  }

  private enqueue(raw: string): void {
    const text = speakable(raw);
    if (!text || this.spokenChars >= MAX_SPOKEN_CHARS) return;
    this.spokenChars += text.length;
    this.chain = this.chain.then(async () => {
      if (this.aborted) return;
      try {
        const wav = await this.audio.speak(text, this.language);
        if (this.aborted) return;
        if (this.firstAudioAt === null) this.firstAudioAt = this.now();
        this.parts.push(wav);
        this.onChunk({ seq: this.seq++, text, wav });
      } catch (e) {
        console.warn(`voice: tts failed (${text.length} chars)`, (e as Error).name);
      }
    });
  }
}
