import { randomUUID } from "node:crypto";
import { CreateRoutineRequest, type Routine, UpdateRoutineRequest } from "@sa/protocol";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "../plugin-api.js";
import type { makeCatchup } from "./catchup.js";

// membership is checked against the db, so the chat id needs no strict shape here
const CreateBody = CreateRoutineRequest.omit({ chat_id: true });
const MAX_ROUTINES = 20;
const WATCH_ID = "alert-watch";

type Row = {
  id: string;
  kind: "routine" | "alert_watch";
  user_id: string | null;
  agent_id: string;
  chat_id: string;
  days: number[];
  time_hhmm: string;
  prompt: string;
  paused: boolean;
  last_run_at: Date | string | null;
};

const toRoutine = (r: Row): Routine => ({
  id: r.id,
  kind: r.kind,
  user_id: r.user_id,
  agent_id: r.agent_id,
  chat_id: r.chat_id,
  days: r.days,
  time: r.time_hhmm,
  prompt: r.prompt,
  paused: r.paused,
  last_run_at: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
});

const COLS = "id, kind, user_id, agent_id, chat_id, days, time_hhmm, prompt, paused, last_run_at";

export function registerProactiveRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  catchup: ReturnType<typeof makeCatchup>,
): void {
  const { db, authenticate } = deps;

  app.post("/api/me/hello", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    return { catchup: await catchup.onHello(userId) };
  });

  const prefs = async (userId: string) => {
    const [p] = await db.query<{ pause_all: boolean }>(
      "select pause_all from sa.user_prefs where user_id = $1",
      [userId],
    );
    return p?.pause_all ?? false;
  };

  app.get("/api/me/prefs", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    return {
      pause_all: await prefs(userId),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });

  app.put("/api/me/prefs", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const pauseAll = (req.body as { pause_all?: unknown } | null)?.pause_all;
    if (typeof pauseAll !== "boolean") return reply.code(400).send({ error: "bad_request" });
    await db.query(
      `insert into sa.user_prefs (user_id, pause_all) values ($1, $2)
       on conflict (user_id) do update set pause_all = $2`,
      [userId, pauseAll],
    );
    return {
      pause_all: pauseAll,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });

  app.get("/api/routines", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const agentId = (req.query as { agent_id?: string }).agent_id;
    const rows = await db.query<Row>(
      `select ${COLS} from sa.routines
        where (kind = 'routine' and user_id = $1 and ($2::text is null or agent_id = $2))
           or (kind = 'alert_watch' and ($2::text is null
               or agent_id = $2 and exists (select 1 from sa.agents where id = $2 and roster_id = 'ops')))
        order by kind desc, created_at, id`,
      [userId, agentId ?? null],
    );
    return rows.map(toRoutine);
  });

  app.post("/api/routines", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const body = CreateBody.safeParse(req.body);
    const chatId = (req.body as { chat_id?: unknown } | null)?.chat_id;
    if (!body.success || typeof chatId !== "string" || chatId.length < 1 || chatId.length > 64)
      return reply.code(400).send({ error: "bad_request" });
    const b = { ...body.data, chat_id: chatId };
    const [agent] = await db.query(
      "select 1 from sa.agents where id = $1 and (scope = 'workspace' or owner_user_id = $2)",
      [b.agent_id, userId],
    );
    if (!agent) return reply.code(403).send({ error: "forbidden" });
    const members = await db.query(
      `select 1 from sa.chat_members
        where chat_id = $1 and removed_at is null
          and ((member_type = 'user' and member_id = $2) or (member_type = 'agent' and member_id = $3))`,
      [b.chat_id, userId, b.agent_id],
    );
    if (members.length < 2) return reply.code(403).send({ error: "forbidden" });
    const [n] = await db.query<{ n: number }>(
      "select count(*)::int as n from sa.routines where user_id = $1 and kind = 'routine'",
      [userId],
    );
    if ((n?.n ?? 0) >= MAX_ROUTINES) return reply.code(409).send({ error: "too_many_routines" });
    const [row] = await db.query<Row>(
      `insert into sa.routines (id, kind, user_id, agent_id, chat_id, days, time_hhmm, prompt)
       values ($1, 'routine', $2, $3, $4, $5, $6, $7) returning ${COLS}`,
      [randomUUID(), userId, b.agent_id, b.chat_id, b.days, b.time, b.prompt],
    );
    return reply.code(201).send(toRoutine(row as Row));
  });

  app.patch("/api/routines/:id", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const body = UpdateRoutineRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await db.query<Row>(
      `update sa.routines set paused = $2
        where id = $1 and (id = $4 or user_id = $3) returning ${COLS}`,
      [id, body.data.paused, userId, WATCH_ID],
    );
    if (!row) return reply.code(404).send({ error: "not_found" });
    return toRoutine(row);
  });

  app.delete("/api/routines/:id", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    if (id === WATCH_ID) return reply.code(403).send({ error: "forbidden" });
    const rows = await db.query(
      "delete from sa.routines where id = $1 and user_id = $2 and kind = 'routine' returning id",
      [id, userId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });
}
