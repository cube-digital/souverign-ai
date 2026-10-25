import type { AudioClient, Transcript } from "../src/voice/audio-client.js";

/** A canonical 16-bit mono PCM WAV of `ms` milliseconds (silence). */
export function makeWav(ms: number, sampleRate = 24000, extraChunk = false): Uint8Array {
  const dataLen = Math.round((sampleRate * ms) / 1000) * 2;
  const extra = extraChunk ? 8 + 6 : 0;
  const out = new Uint8Array(44 + extra + dataLen);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + extra + dataLen, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  let o = 36;
  if (extraChunk) {
    tag(o, "LIST");
    v.setUint32(o + 4, 6, true);
    o += 14;
  }
  tag(o, "data");
  v.setUint32(o + 4, dataLen, true);
  return out;
}

export type FakeAudioOpts = {
  /** transcript text returned for every voice message */
  text?: string;
  language?: string;
  sttDelayMs?: number;
  failStt?: boolean;
  /** per-call TTS behaviour, by sentence text */
  speak?: (text: string) => Promise<Uint8Array>;
};

/** An AudioClient that records its calls; every sentence becomes 100 ms of silence. */
export class FakeAudio implements AudioClient {
  transcribed: { bytes: Uint8Array; filename: string; language: string | undefined }[] = [];
  spoken: { text: string; language: string }[] = [];
  constructor(public opts: FakeAudioOpts = {}) {}
  async transcribe(bytes: Uint8Array, filename: string, language?: string): Promise<Transcript> {
    this.transcribed.push({ bytes, filename, language });
    if (this.opts.sttDelayMs) await new Promise((r) => setTimeout(r, this.opts.sttDelayMs));
    if (this.opts.failStt) throw new Error("stt_failed_500");
    return { text: this.opts.text ?? "hello", language: this.opts.language ?? "en", duration: 2 };
  }
  async speak(text: string, language: string): Promise<Uint8Array> {
    this.spoken.push({ text, language });
    return this.opts.speak ? this.opts.speak(text) : makeWav(100);
  }
}
