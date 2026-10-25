import type { ActionItem } from "@sa/protocol";
import type { ChatMessage } from "../agents/runtime.js";

export type SegmentRow = { speakerName: string; t0Ms: number; text: string };
export const MAX_NOTES_CHARS = 7500;
export const SINGLE_PASS_CHARS = 14_000;
export const CHUNK_CHARS = 12_000;

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function transcriptLines(segments: SegmentRow[], callStartMs: number): string[] {
  return segments.map((s) => `[${mmss(s.t0Ms - callStartMs)}] ${s.speakerName}: ${s.text.trim()}`);
}

export function chunkLines(lines: string[], max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const raw of lines) {
    const l = raw.slice(0, max);
    if (cur && cur.length + l.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export const NOTES_SYSTEM = `You write meeting notes from a call transcript. Use only what the transcript says; never invent names, dates or numbers. Each line is "[mm:ss] Speaker: text". Some attendees were not captured; never guess what they said.
Answer in English Markdown with exactly these four sections, in this order:
## Summary
Three to six sentences.
## Decisions
- One bullet per decision, ending with its time stamp, for example (03:41). Write "- None recorded." when there are none.
## Action items
- [ ] Owner: task (due: when)
Leave out "(due: …)" when no date was said. Use "Unassigned" when nobody took the task. Write "- None recorded." when there are none.
## Open questions
- One bullet per open question, or "- None recorded."`;

export function notesMessages(transcript: string, part?: { i: number; n: number }): ChatMessage[] {
  const intro = part
    ? `This is part ${part.i} of ${part.n} of one call. Write the four sections for this part only.`
    : "Write the notes for this call.";
  return [
    { role: "system", content: NOTES_SYSTEM },
    { role: "user", content: `${intro}\n\nTranscript:\n${transcript}` },
  ];
}

export function mergeMessages(partNotes: string[]): ChatMessage[] {
  return [
    { role: "system", content: NOTES_SYSTEM },
    {
      role: "user",
      content: `Below are notes for consecutive parts of one call. Merge them into one set of the four sections; drop duplicates and keep time stamps.\n\n${partNotes.map((p, i) => `### Part ${i + 1}\n${p}`).join("\n\n")}`,
    },
  ];
}

const ITEM = /^\s*[-*]\s*\[[ xX]\]\s*(?:\*\*)?([^:*\n]{1,80}?)(?:\*\*)?\s*:\s*(.+?)\s*$/;
const DUE = /\s*\(due:?\s*([^)]{1,40})\)\s*$/i;

export function parseActionItems(md: string): ActionItem[] {
  const out: ActionItem[] = [];
  let inSection = false;
  for (const line of md.split("\n")) {
    if (/^#{2,3}\s+/.test(line)) {
      inSection = /^#{2,3}\s+action items/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = ITEM.exec(line);
    if (!m) continue;
    const owner = (m[1] ?? "").trim();
    let text = (m[2] ?? "").trim();
    let due: string | undefined;
    const d = DUE.exec(text);
    if (d) {
      due = (d[1] ?? "").trim() || undefined;
      text = text.slice(0, d.index).trim();
    }
    if (!owner || !text) continue;
    out.push(due ? { owner, text: text.slice(0, 300), due } : { owner, text: text.slice(0, 300) });
    if (out.length === 30) break;
  }
  return out;
}

export type HeaderInput = {
  chatTitle: string;
  startedAtMs: number;
  durationMs: number;
  speakers: string[];
  notCaptured: number;
};

export function notesHeader(h: HeaderInput): string {
  const date = new Date(h.startedAtMs).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const mins = Math.max(1, Math.round(h.durationMs / 60_000));
  const lines = [
    `**Call notes** · ${h.chatTitle} · ${date} · ${mins} min`,
    `Speakers: ${h.speakers.length ? h.speakers.join(", ") : "none"}`,
  ];
  if (h.notCaptured > 0) {
    lines.push(
      `Not captured: ${h.notCaptured} ${h.notCaptured === 1 ? "person" : "people"} who did not consent`,
    );
  }
  lines.push("Draft by Scribe on this Mac.");
  return lines.join("\n");
}

export function composeNotes(header: string, body: string): string {
  const text = `${header}\n\n${body.trim()}`;
  return text.length <= MAX_NOTES_CHARS
    ? text
    : `${text.slice(0, MAX_NOTES_CHARS - 20)}\n\n(notes truncated)`;
}

export function fallbackNotes(lines: string[]): string {
  const tail = lines.slice(-40).map((l) => `> ${l}`);
  return [
    "## Summary",
    "The summary could not be generated on this Mac. Last lines of the transcript:",
    ...tail,
  ].join("\n");
}
