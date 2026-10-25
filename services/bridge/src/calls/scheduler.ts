import { randomBytes } from "node:crypto";
import type { ActionItem } from "@sa/protocol";
import type { AgentHostApi } from "../agents/api.js";
import type { ChatMessage } from "../agents/runtime.js";
import { publish } from "../approvals/events.js";
import type { Db } from "../db.js";
import type { Log } from "../plugin-api.js";
import { notCapturedCount } from "./consent.js";
import { getCallInfo } from "./store.js";
import {
  chunkLines,
  composeNotes,
  fallbackNotes,
  mergeMessages,
  notesHeader,
  notesMessages,
  parseActionItems,
  SINGLE_PASS_CHARS,
  transcriptLines,
} from "./summary.js";

export type Clock = {
  now(): number;
  setInterval(fn: () => void | Promise<void>, ms: number): () => void;
};
export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const t = setInterval(() => void fn(), ms);
    t.unref?.();
    return () => clearInterval(t);
  },
};

export type FinalNotes = {
  id: string;
  notetakerId: string;
  callId: string;
  chatId: string;
  invitedBy: string;
  version: number;
  final: true;
  bodyMd: string;
  actionItems: ActionItem[];
};

export type SchedulerOpts = {
  db: Db;
  agentHost: AgentHostApi | undefined;
  intervalMs: number;
  clock?: Clock;
  onFinalNotes?: (notes: FinalNotes) => void | Promise<void>;
  log: Log;
};

export class NotesScheduler {
  private readonly clock: Clock;
  private stopTick: (() => void) | undefined;
  /** highest segment id already summarised, per notetaker */
  private readonly seen = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly finals = new Map<string, Promise<void>>();

  constructor(private readonly o: SchedulerOpts) {
    this.clock = o.clock ?? systemClock;
  }

  start(): void {
    this.stopTick?.();
    this.stopTick = this.clock.setInterval(() => this.tick(), this.o.intervalMs);
  }

  stop(): void {
    this.stopTick?.();
    this.stopTick = undefined;
  }

  /** Interim summaries for active notetakers that have new segments. */
  async tick(): Promise<void> {
    const { db, log } = this.o;
    const active = await db.query<{ id: string; last: number | string | null }>(
      `select n.id, (select max(s.id) from sa.call_segments s where s.notetaker_id = n.id) as last
         from sa.call_notetakers n where n.status = 'active'`,
    );
    for (const n of active) {
      if (n.last === null || Number(n.last) <= (this.seen.get(n.id) ?? 0)) continue;
      if (this.inflight.has(n.id) || this.finals.has(n.id)) continue;
      try {
        await this.queue(n.id, false);
      } catch (e) {
        log("interim notes failed", { notetaker: n.id, error: (e as Error).message });
      }
    }
  }

  /** The final summary of a notetaker; runs once however often and however concurrently it is called. */
  final(notetakerId: string): Promise<void> {
    const existing = this.finals.get(notetakerId);
    if (existing) return existing;
    const run = this.queue(notetakerId, true).catch((e) => {
      this.o.log("final notes failed", { notetaker: notetakerId, error: (e as Error).message });
    });
    this.finals.set(notetakerId, run);
    return run;
  }

  /** One summary at a time per notetaker: a new one waits for the one in flight. */
  private queue(notetakerId: string, final: boolean): Promise<void> {
    const prev = this.inflight.get(notetakerId) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.summarise(notetakerId, final))
      .finally(() => {
        if (this.inflight.get(notetakerId) === run) this.inflight.delete(notetakerId);
      });
    this.inflight.set(notetakerId, run);
    return run;
  }

  private async complete(agentId: string, key: string, messages: ChatMessage[]): Promise<string> {
    const complete = this.o.agentHost?.complete;
    if (!complete) throw new Error("no completion available");
    return complete.call(this.o.agentHost, agentId, key, messages);
  }

  private async summarise(notetakerId: string, final: boolean): Promise<void> {
    const { db, log } = this.o;
    const [nt] = await db.query<{
      call_id: string;
      agent_id: string;
      invited_by: string;
      chat_id: string;
      chat_title: string | null;
      started_ms: number;
      ended_ms: number | null;
    }>(
      `select n.call_id, n.agent_id, n.invited_by, c.chat_id, ch.title as chat_title,
              (extract(epoch from c.started_at) * 1000)::float8 as started_ms,
              (extract(epoch from coalesce(c.ended_at, n.ended_at)) * 1000)::float8 as ended_ms
         from sa.call_notetakers n
         join sa.calls c on c.id = n.call_id
         join sa.chats ch on ch.id = c.chat_id
        where n.id = $1`,
      [notetakerId],
    );
    if (!nt) return;
    const segs = await db.query<{
      id: number | string;
      name: string;
      t0_ms: number;
      text: string;
    }>(
      `select s.id, u.display_name as name, (extract(epoch from s.t0) * 1000)::float8 as t0_ms, s.text
         from sa.call_segments s join sa.users u on u.id = s.speaker_user_id
        where s.notetaker_id = $1 order by s.t0, s.id`,
      [notetakerId],
    );
    if (segs.length === 0) {
      log("no segments, no notes", { notetaker: notetakerId, final });
      return;
    }
    this.seen.set(notetakerId, Math.max(...segs.map((s) => Number(s.id))));
    const startMs = Math.round(Number(nt.started_ms));
    const lines = transcriptLines(
      segs.map((s) => ({ speakerName: s.name, t0Ms: Math.round(Number(s.t0_ms)), text: s.text })),
      startMs,
    );
    const key = `call-notes:${notetakerId}`;
    let body: string;
    try {
      const transcript = lines.join("\n");
      if (transcript.length <= SINGLE_PASS_CHARS) {
        body = await this.complete(nt.agent_id, key, notesMessages(transcript));
      } else {
        const chunks = chunkLines(lines);
        const parts: string[] = [];
        for (const [i, chunk] of chunks.entries()) {
          parts.push(
            await this.complete(
              nt.agent_id,
              key,
              notesMessages(chunk, { i: i + 1, n: chunks.length }),
            ),
          );
        }
        body = await this.complete(nt.agent_id, key, mergeMessages(parts));
      }
      if (!body.trim()) throw new Error("empty summary");
    } catch (e) {
      log("summary model failed", { notetaker: notetakerId, error: (e as Error).name });
      body = fallbackNotes(lines);
    }
    const call = await getCallInfo(db, nt.call_id);
    const endMs = nt.ended_ms === null ? this.clock.now() : Math.round(Number(nt.ended_ms));
    const header = notesHeader({
      chatTitle: nt.chat_title ?? "chat",
      startedAtMs: startMs,
      durationMs: endMs - startMs,
      speakers: [...new Set(segs.map((s) => s.name))],
      notCaptured: call ? notCapturedCount(call) : 0,
    });
    const items = parseActionItems(body);
    const text = composeNotes(header, body);
    const id = randomBytes(9).toString("base64url");
    const [row] = await db.query<{ version: number }>(
      `insert into sa.call_notes (id, notetaker_id, version, final, body_md, action_items)
       select $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5::jsonb
         from sa.call_notes where notetaker_id = $2
       on conflict do nothing returning version`,
      [id, notetakerId, final, text, JSON.stringify(items)],
    );
    if (!row) return;
    const version = Number(row.version);
    log("call notes written", { notetaker: notetakerId, version, final, chars: text.length });
    publish([nt.invited_by], { type: "call.notes", call_id: nt.call_id, version, final });
    if (final) {
      await this.o.onFinalNotes?.({
        id,
        notetakerId,
        callId: nt.call_id,
        chatId: nt.chat_id,
        invitedBy: nt.invited_by,
        version,
        final: true,
        bodyMd: text,
        actionItems: items,
      });
    }
  }
}
