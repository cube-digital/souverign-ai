const BOUNDARY = /([.!?…]+["')\]]*)(\s+)|\n{2,}/g;
const MIN_SENTENCE = 12;

/** Markdown → speakable text: drops code blocks, links' URLs, emphasis, headings and bullets. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Streams sentences out of growing text. push() takes deltas; flush() returns the rest. */
export class SentenceSplitter {
  private buf = "";
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let last = 0;
    for (const m of this.buf.matchAll(BOUNDARY)) {
      const end = (m.index ?? 0) + m[0].length;
      const s = this.buf.slice(last, end).trim();
      if (s.length >= MIN_SENTENCE) {
        out.push(s);
        last = end;
      }
    }
    this.buf = this.buf.slice(last);
    return out;
  }
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = "";
    return s ? [s] : [];
  }
}
