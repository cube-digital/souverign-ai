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

export const NOTES_SYSTEM = `You write meeting notes from a call transcript. Use only what the transcript says; never invent names, dates or numbers. Each line is "[mm:ss] Speaker: text". Some attendees were not captured; never guess what they said. Name only people who appear as speakers in the transcript.
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

const NOT_CAPTURED = "a participant who was not captured";
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokens = (name: string) => name.split(/\s+/).filter((t) => t.length >= 2);

const fold = (t: string): string => t.normalize("NFD").replace(/\p{M}/gu, "");

/** Folded text plus, per folded UTF-16 unit, the original [start, end) range it came from. */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) {
      starts.push(pos);
      ends.push(pos + ch.length);
    }
    folded += f;
    pos += ch.length;
  }
  return { folded, starts, ends };
}

/**
 * Removes the names of people who were not captured from model text. A multi-word display name
 * matches in any case; any single name (a one-word display name, or the first/last name of a
 * longer one) matches only when capitalised, so "They will ship" survives a decliner called
 * "Will Smith" or "Will". Diacritics are ignored. Text inside a captured speaker's name is never
 * touched ("Ana Maria" is not scrubbed out of "Ana Maria Popescu").
 */
export function scrubNames(text: string, notCaptured: string[], captured: string[]): string {
  const rules: RegExp[] = [];
  const seen = new Set<string>();
  const re = (f: string, ci: boolean) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${esc(f)}(?![\\p{L}\\p{N}])`, ci ? "giu" : "gu");
  const keep = new Set(
    captured.flatMap((n) => [n, ...tokens(n)]).map((t) => fold(t).toLowerCase()),
  );
  const add = (name: string, ci: boolean) => {
    const f = fold(name);
    const key = `${ci}:${f}`;
    if (!f || seen.has(key) || keep.has(f.toLowerCase())) return;
    seen.add(key);
    rules.push(re(f, ci));
  };
  for (const full of notCaptured) {
    const clean = full.normalize("NFC").replace(/\s+/g, " ").trim();
    const parts = tokens(clean);
    if (/\s/.test(clean)) {
      add(clean, true);
      for (const t of parts) if (/^\p{Lu}/u.test(t)) add(t, false);
    } else if (/^\p{Lu}/u.test(clean)) {
      add(clean, false);
    }
  }
  const protectedRes = captured
    .map((n) => fold(n.normalize("NFC").replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .map((f) => re(f, true));
  rules.sort((a, b) => b.source.length - a.source.length);
  let out = text.normalize("NFC");
  for (const rule of rules) {
    const { folded, starts, ends } = foldWithMap(out);
    const guarded = protectedRes.flatMap((p) =>
      [...folded.matchAll(p)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const),
    );
    for (const m of [...folded.matchAll(rule)].reverse()) {
      const i = m.index ?? 0;
      const j = i + m[0].length;
      if (guarded.some(([g0, g1]) => i < g1 && g0 < j)) continue;
      const from = starts[i] ?? 0;
      const to = ends[j - 1] ?? out.length;
      out = `${out.slice(0, from)}${NOT_CAPTURED}${out.slice(to)}`;
    }
  }
  return out;
}

/** Action-item owners other than captured speakers become "Unassigned". */
export function limitOwners(items: ActionItem[], captured: string[]): ActionItem[] {
  const ok = new Set(captured.flatMap((n) => [n, ...tokens(n)]).map((t) => t.toLowerCase()));
  return items.map((i) => (ok.has(i.owner.toLowerCase()) ? i : { ...i, owner: "Unassigned" }));
}

/** One line, bounded: names and text cannot forge transcript lines. */
export const oneLine = (t: string, max: number): string =>
  t.replace(/\s+/g, " ").trim().slice(0, max);
