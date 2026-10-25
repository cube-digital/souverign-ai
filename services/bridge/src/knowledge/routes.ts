import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  CorrectionRequest,
  CreateLessonRequest,
  type KnowledgeItem,
  type KnowledgeItemDetail,
  type Lesson,
  SharingRequest,
} from "@sa/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { type Memory, memory } from "../memory/client.js";
import { ExtractError, extract, MAX_DOC_BYTES, segmentSources } from "../memory/extract.js";
import type { RouteDeps } from "../plugin-api.js";

const MAX_LESSONS = 30;
const MAX_LIST = 200;
const SOURCE_TYPE = { document: "doc", note: "note", correction: "correction" } as const;

type AgentRow = { id: string; scope: "personal" | "workspace"; owner_user_id: string | null };
type ItemRow = {
  id: string;
  agent_id: string;
  kind: "document" | "note" | "correction";
  title: string;
  mime: string | null;
  size: number | null;
  parts: number;
  truncated: boolean;
  tags: string[];
  origin_chat_id: string | null;
  origin_chat_title: string | null;
  taught_by_user_id: string | null;
  taught_by_name: string | null;
  created_ms: string | number;
  preview: string | null;
};
type Segment = { label: string | null; text: string };

const newId = () => randomBytes(9).toString("base64url");

const ITEM_SELECT = `select k.id, k.agent_id, k.kind, k.title, k.mime, k.size,
    jsonb_array_length(k.parts) as parts, k.truncated, k.tags, k.origin_chat_id,
    c.title as origin_chat_title, k.taught_by as taught_by_user_id, u.display_name as taught_by_name,
    (extract(epoch from k.created_at) * 1000)::float8 as created_ms,
    left((select string_agg(p->>'text', E'\\n\\n') from jsonb_array_elements(k.parts) p), 200) as preview
  from sa.knowledge_items k
  left join sa.chats c on c.id = k.origin_chat_id
  left join sa.users u on u.id = k.taught_by`;

function toItem(r: ItemRow): KnowledgeItem {
  const { created_ms, preview, ...rest } = r;
  return { ...rest, created_at: Math.round(Number(created_ms)), preview: preview ?? "" };
}

async function activeMember(db: Db, chatId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from sa.chat_members
      where chat_id = $1 and member_type = 'user' and member_id = $2 and removed_at is null`,
    [chatId, userId],
  );
  return rows.length > 0;
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, authenticate, agentHost, log } = deps;

  const agentOf = async (id: string): Promise<AgentRow | undefined> =>
    (
      await db.query<AgentRow>("select id, scope, owner_user_id from sa.agents where id = $1", [id])
    )[0];

  /** personal: the owner; workspace: any person */
  const canTeach = async (userId: string, agent: AgentRow): Promise<boolean> => {
    if (agent.scope === "personal") return agent.owner_user_id === userId;
    const rows = await db.query("select 1 from sa.users where id = $1 and kind = 'person'", [
      userId,
    ]);
    return rows.length > 0;
  };

  const canSeeItem = async (
    userId: string,
    agent: AgentRow,
    item: { kind: string; origin_chat_id: string | null },
  ): Promise<boolean> => {
    if (item.kind !== "document" && item.origin_chat_id) {
      if (agent.scope === "personal" && agent.owner_user_id === userId) return true;
      return activeMember(db, item.origin_chat_id, userId);
    }
    return canTeach(userId, agent);
  };

  /** Auth plus teach permission; replies 401/404 itself. */
  const teacher = async (
    req: { params: unknown; headers: unknown },
    reply: FastifyReply,
    authReq: Parameters<typeof authenticate>[0],
  ): Promise<{ userId: string; agent: AgentRow } | null> => {
    const userId = await authenticate(authReq, reply);
    if (!userId) return null;
    const agent = await agentOf((req.params as { id: string }).id);
    if (!agent || !(await canTeach(userId, agent))) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return { userId, agent };
  };

  const itemById = async (agentId: string, itemId: string): Promise<ItemRow | undefined> =>
    (
      await db.query<ItemRow>(`${ITEM_SELECT} where k.agent_id = $1 and k.id = $2`, [
        agentId,
        itemId,
      ])
    )[0];

  const cleanup = async (mem: Memory, agentId: string, type: string, id: string) => {
    try {
      await mem.deleteSource({
        namespace: `agent:${agentId}`,
        source_type: type,
        source_id: id,
        include_parts: true,
      });
    } catch {
      log("knowledge cleanup failed", { agent: agentId, item: id });
    }
  };

  app.get("/api/agents/:id/knowledge", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const owner = t.agent.scope === "personal" && t.agent.owner_user_id === t.userId;
    const rows = await db.query<ItemRow>(
      `${ITEM_SELECT}
        where k.agent_id = $1
          and (k.kind = 'document' or k.origin_chat_id is null or $3::boolean
               or k.origin_chat_id in (select chat_id from sa.chat_members
                    where member_type = 'user' and member_id = $2 and removed_at is null))
        order by k.created_at desc, k.id limit ${MAX_LIST}`,
      [t.agent.id, t.userId, owner],
    );
    return rows.map(toItem);
  });

  app.get("/api/agents/:id/knowledge/:itemId", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const row = await itemById(t.agent.id, (req.params as { itemId: string }).itemId);
    if (!row || !(await canSeeItem(t.userId, t.agent, row)))
      return reply.code(404).send({ error: "not_found" });
    const [p] = await db.query<{ parts: Segment[] }>(
      "select parts from sa.knowledge_items where id = $1",
      [row.id],
    );
    const detail: KnowledgeItemDetail = { ...toItem(row), segments: p?.parts ?? [] };
    return detail;
  });

  app.delete("/api/agents/:id/knowledge/:itemId", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const row = await itemById(t.agent.id, (req.params as { itemId: string }).itemId);
    if (!row || !(await canSeeItem(t.userId, t.agent, row)))
      return reply.code(404).send({ error: "not_found" });
    const mem = memory();
    if (!mem) return reply.code(503).send({ error: "memory_unavailable" });
    try {
      await mem.deleteSource({
        namespace: `agent:${t.agent.id}`,
        source_type: SOURCE_TYPE[row.kind],
        source_id: row.id,
        include_parts: true,
      });
    } catch {
      log("knowledge delete failed", { agent: t.agent.id, item: row.id });
      return reply.code(503).send({ error: "memory_unavailable" });
    }
    await db.query("delete from sa.knowledge_items where id = $1", [row.id]);
    log("knowledge deleted", { agent: t.agent.id, item: row.id });
    return { ok: true };
  });

  // Own context, so the binary parser does not touch the rest of the app.
  app.register(async (s) => {
    s.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_DOC_BYTES + 1024 },
      (_r, b, done) => done(null, b),
    );
    s.setErrorHandler((err, _req, reply) => {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      if (status === 413) return reply.code(413).send({ error: "too_large" });
      if (status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request" });
      log("knowledge upload error", { code: "internal" });
      return reply.code(500).send({ error: "internal" });
    });

    s.post("/api/agents/:id/knowledge", async (req, reply) => {
      const t = await teacher(req, reply, req);
      if (!t) return;
      let name = "";
      try {
        const raw = req.headers["x-file-name"];
        name = basename(decodeURIComponent(typeof raw === "string" ? raw : ""));
      } catch {
        name = "";
      }
      if (!name || name.length > 200) return reply.code(400).send({ error: "bad_name" });
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: "bad_request" });
      const mime = String(req.headers["x-file-type"] ?? "application/octet-stream");
      const mem = memory();
      if (!mem) return reply.code(503).send({ error: "memory_unavailable" });

      let ex: Awaited<ReturnType<typeof extract>>;
      try {
        ex = await extract(body, name, mime);
      } catch (e) {
        const code = e instanceof ExtractError ? e.code : "failed";
        log("knowledge extract failed", { agent: t.agent.id, size: body.byteLength, code });
        if (code === "unsupported") return reply.code(415).send({ error: "unsupported" });
        if (code === "too_large") return reply.code(413).send({ error: "too_large" });
        if (code === "empty")
          return reply.code(422).send({
            error: "empty",
            ...(e instanceof Error && e.message !== "empty" ? { message: e.message } : {}),
          });
        return reply.code(422).send({ error: "extract_failed" });
      }

      const id = newId();
      const parts: Segment[] = ex.segments.map((x) => ({ label: x.label, text: x.text }));
      await db.query(
        `insert into sa.knowledge_items (id, agent_id, kind, title, mime, size, parts, truncated, taught_by)
         values ($1, $2, 'document', $3, $4, $5, $6, $7, $8)`,
        [
          id,
          t.agent.id,
          name,
          mime.slice(0, 200),
          body.byteLength,
          JSON.stringify(parts),
          ex.truncated,
          t.userId,
        ],
      );
      try {
        for (const p of segmentSources(id, name, ex.segments)) {
          await mem.ingest({
            namespace: `agent:${t.agent.id}`,
            kind: "knowledge",
            origin_chat_id: null,
            source: { type: "doc", id: p.id, title: p.title, ts: Date.now() },
            text: p.text,
          });
        }
      } catch {
        await cleanup(mem, t.agent.id, "doc", id);
        await db.query("delete from sa.knowledge_items where id = $1", [id]);
        log("knowledge ingest failed", { agent: t.agent.id, item: id });
        return reply.code(502).send({ error: "memory_failed" });
      }
      log("knowledge added", {
        agent: t.agent.id,
        item: id,
        parts: parts.length,
        size: body.byteLength,
      });
      return toItem((await itemById(t.agent.id, id)) as ItemRow);
    });
  });

  app.get("/api/agents/:id/lessons", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    return lessonsOf(t.agent.id);
  });

  const lessonsOf = async (agentId: string, lessonId?: string): Promise<Lesson[]> => {
    const rows = await db.query<Omit<Lesson, "created_at"> & { created_ms: number }>(
      `select l.id, l.agent_id, l.text, l.taught_by as taught_by_user_id,
              u.display_name as taught_by_name,
              (extract(epoch from l.created_at) * 1000)::float8 as created_ms
         from sa.agent_lessons l left join sa.users u on u.id = l.taught_by
        where l.agent_id = $1 and ($2::text is null or l.id = $2)
        order by l.created_at, l.id`,
      [agentId, lessonId ?? null],
    );
    return rows.map(({ created_ms, ...r }) => ({
      ...r,
      created_at: Math.round(Number(created_ms)),
    }));
  };

  const restart = async (agentId: string) => {
    try {
      await agentHost?.onAgentUpdated?.(agentId);
    } catch {
      log("agent restart failed", { agent: agentId });
    }
  };

  app.post("/api/agents/:id/lessons", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const body = CreateLessonRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const id = newId();
    const ins = await db.query(
      `insert into sa.agent_lessons (id, agent_id, text, taught_by)
       select $1, $2, $3, $4 where (select count(*) from sa.agent_lessons where agent_id = $2) < ${MAX_LESSONS}
       returning id`,
      [id, t.agent.id, body.data.text, t.userId],
    );
    if (ins.length === 0) return reply.code(409).send({ error: "too_many_lessons" });
    log("lesson added", { agent: t.agent.id, lesson: id });
    await restart(t.agent.id);
    return (await lessonsOf(t.agent.id, id))[0];
  });

  app.delete("/api/agents/:id/lessons/:lessonId", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const gone = await db.query(
      "delete from sa.agent_lessons where id = $1 and agent_id = $2 returning id",
      [(req.params as { lessonId: string }).lessonId, t.agent.id],
    );
    if (gone.length === 0) return reply.code(404).send({ error: "not_found" });
    log("lesson deleted", { agent: t.agent.id });
    await restart(t.agent.id);
    return { ok: true };
  });

  app.post("/api/agents/:id/corrections", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    // Chat and message ids are only looked up, so they are bounds-checked rather than format-checked.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const idOk = (v: unknown): v is string =>
      typeof v === "string" && v.length > 0 && v.length <= 64;
    const textOk = CorrectionRequest.shape.text.safeParse(raw.text);
    if (!idOk(raw.chat_id) || !idOk(raw.message_id) || !textOk.success)
      return reply.code(400).send({ error: "bad_request" });
    const agent = await agentOf((req.params as { id: string }).id);
    if (!agent) return reply.code(404).send({ error: "not_found" });
    const chat_id = raw.chat_id;
    const message_id = raw.message_id;
    const text = textOk.data;
    if (!(await activeMember(db, chat_id, userId)))
      return reply.code(403).send({ error: "forbidden" });
    const [msg] = await db.query<{ body: unknown }>(
      `select m.body from sa.messages_plain m
         join sa.agent_devices d on d.device_id = m.device_id and d.agent_id = $1
        where m.chat_id = $2 and m.id = $3 and m.sender_device = d.device_id`,
      [agent.id, chat_id, message_id],
    );
    const parsed = typeof msg?.body === "string" ? safeJson(msg.body) : msg?.body;
    const said = (parsed as { type?: string; text?: unknown } | undefined)?.text;
    if (!msg || (parsed as { type?: string }).type !== "text" || typeof said !== "string")
      return reply.code(404).send({ error: "not_found" });
    const mem = memory();
    if (!mem) return reply.code(503).send({ error: "memory_unavailable" });

    const origin = agent.scope === "personal" && agent.owner_user_id === userId ? null : chat_id;
    const full = `Correction to an earlier answer ("${said.slice(0, 300)}"): ${text}`;
    const id = newId();
    await db.query(
      `insert into sa.knowledge_items (id, agent_id, kind, title, parts, origin_chat_id, target_message_id, taught_by)
       values ($1, $2, 'correction', 'Correction', $3, $4, $5, $6)`,
      [id, agent.id, JSON.stringify([{ label: null, text: full }]), origin, message_id, userId],
    );
    try {
      await mem.ingest({
        namespace: `agent:${agent.id}`,
        kind: "correction",
        origin_chat_id: origin,
        source: { type: "correction", id, title: "Correction", ts: Date.now() },
        text: full,
      });
    } catch {
      await cleanup(mem, agent.id, "correction", id);
      await db.query("delete from sa.knowledge_items where id = $1", [id]);
      log("correction ingest failed", { agent: agent.id, item: id });
      return reply.code(502).send({ error: "memory_failed" });
    }
    log("correction added", { agent: agent.id, item: id });
    return toItem((await itemById(agent.id, id)) as ItemRow);
  });

  app.put("/api/agents/:id/sharing", async (req, reply) => {
    const t = await teacher(req, reply, req);
    if (!t) return;
    const body = SharingRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    await db.query("update sa.agents set share_private_in_chats = $1 where id = $2", [
      body.data.share_private_in_chats,
      t.agent.id,
    ]);
    log("sharing changed", { agent: t.agent.id, value: body.data.share_private_in_chats });
    return { share_private_in_chats: body.data.share_private_in_chats };
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
