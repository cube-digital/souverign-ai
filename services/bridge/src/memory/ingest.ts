import type { StoredMessage } from "../agents/turn-hooks.js";
import type { Db } from "../db.js";
import type { Log } from "../plugin-api.js";
import type { Memory } from "./client.js";
import { docKind, ExtractError, extract, segmentSources } from "./extract.js";

/** Ingests one stored chat message (or posted file) into chat:<id>, once per message. */
export async function ingestStored(
  m: StoredMessage,
  deps: { db: Db; memory: Memory | null; log: Log },
): Promise<void> {
  const { db, memory, log } = deps;
  if (!memory) return;
  try {
    const b = m.body;
    if (b.type === "text") {
      const meta = b.meta as { held?: unknown; approval?: unknown } | undefined;
      if (meta?.held || meta?.approval) return;
    } else if (b.type !== "file" || !docKind(b.name, b.mime)) {
      return;
    }
    const claimed = await db.query(
      `insert into sa.memory_ingested (chat_id, message_id) values ($1, $2)
       on conflict do nothing returning message_id`,
      [m.chatId, m.id],
    );
    if (claimed.length === 0) return;
    const namespace = `chat:${m.chatId}`;
    const ts = m.receivedAt;
    try {
      if (b.type === "text") {
        const rows = await db.query<{ name: string | null }>(
          `select coalesce(u.display_name, a.name) as name
             from sa.devices d
             left join sa.users u on d.owner_type = 'user' and u.id = d.owner_id
             left join sa.agents a on d.owner_type = 'agent' and a.id = d.owner_id
            where d.id = $1`,
          [m.senderDevice],
        );
        await memory.ingest({
          namespace,
          kind: "conversation",
          origin_chat_id: null,
          source: { type: "message", id: m.id, title: rows[0]?.name ?? null, ts },
          text: b.text,
        });
      } else if (b.type === "file") {
        if (!m.loadFile) return;
        const ex = await extract(await m.loadFile(), b.name, b.mime);
        for (const p of segmentSources(m.id, b.name, ex.segments)) {
          await memory.ingest({
            namespace,
            kind: "knowledge",
            origin_chat_id: null,
            source: { type: "file", id: p.id, title: p.title, ts },
            text: p.text,
          });
        }
      }
    } catch (e) {
      log("memory ingest failed", {
        chat: m.chatId,
        message: m.id,
        code: e instanceof ExtractError ? e.code : "memory",
      });
    }
  } catch (e) {
    log("memory ingest failed", { chat: m.chatId, message: m.id, code: "db" });
    void e;
  }
}
