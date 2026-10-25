export type ParsedWav = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Uint8Array;
};

const tag = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/** Walks the RIFF chunks; does not assume a 44-byte header. */
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    throw new Error("bad_wav");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      fmt = {
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) break;
      // streaming encoders may write 0 / 0xFFFFFFFF as size: clamp to what is there
      const end = Math.min(body + size, bytes.length);
      return { ...fmt, data: bytes.subarray(body, end) };
    }
    o = body + size + (size & 1);
  }
  throw new Error("bad_wav");
}

export function concatWav(parts: Uint8Array[]): Uint8Array {
  const parsed = parts.map(parseWav);
  const f = parsed[0];
  if (!f) throw new Error("bad_wav");
  for (const p of parsed) {
    if (
      p.sampleRate !== f.sampleRate ||
      p.channels !== f.channels ||
      p.bitsPerSample !== f.bitsPerSample
    ) {
      throw new Error("wav_format_mismatch");
    }
  }
  const dataLen = parsed.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  const blockAlign = (f.channels * f.bitsPerSample) / 8;
  put(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, f.channels, true);
  v.setUint32(24, f.sampleRate, true);
  v.setUint32(28, f.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, f.bitsPerSample, true);
  put(36, "data");
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (const p of parsed) {
    out.set(p.data, o);
    o += p.data.length;
  }
  return out;
}

export function wavDurationMs(bytes: Uint8Array): number {
  const p = parseWav(bytes);
  const perSec = p.sampleRate * p.channels * (p.bitsPerSample / 8);
  return perSec > 0 ? Math.round((p.data.length / perSec) * 1000) : 0;
}
