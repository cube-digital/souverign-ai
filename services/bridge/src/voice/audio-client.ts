export type Transcript = { text: string; language: string; duration: number };
export interface AudioClient {
  transcribe(bytes: Uint8Array, filename: string, language?: string): Promise<Transcript>;
  /** One sentence or short text → 16-bit PCM WAV bytes. */
  speak(text: string, language: string): Promise<Uint8Array>;
}

export const TTS_LANGS = new Set(["en", "fr", "es", "it", "de", "ro"]);
export function ttsLanguage(detected: string | undefined): string {
  const l = (detected ?? "").toLowerCase().slice(0, 2);
  return TTS_LANGS.has(l) ? l : "en";
}

export function httpAudioClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): AudioClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const timeout = opts.timeoutMs ?? 30_000;
  const headers = { "X-Internal-Token": opts.token };
  return {
    async transcribe(bytes, filename, language = "auto") {
      const form = new FormData();
      form.set("file", new Blob([bytes]), filename);
      form.set("language", language);
      const res = await fetch(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`stt_failed_${res.status}`);
      const j = (await res.json()) as Partial<Transcript>;
      return {
        text: String(j.text ?? "").trim(),
        language: String(j.language ?? "en"),
        duration: Number(j.duration ?? 0),
      };
    },
    async speak(text, language) {
      const res = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ input: text.slice(0, 4000), language, stream: false }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`tts_failed_${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export function audioClientFromEnv(env = process.env): AudioClient | null {
  if (!env.AUDIO_TOKEN) return null;
  return httpAudioClient({
    baseUrl: env.AUDIO_URL || "http://127.0.0.1:8645",
    token: env.AUDIO_TOKEN,
  });
}
