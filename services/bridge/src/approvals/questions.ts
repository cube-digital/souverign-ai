import { randomBytes } from "node:crypto";
import { AnswerRequest, type Question } from "@sa/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { registerTools } from "../mcp/registry.js";
import { taughtHeld } from "../memory/scope-input.js";
import type { Authenticate } from "../plugin-api.js";
import { publish } from "./events.js";
import { approvalDeps, setQuestionSweep, ttlFromEnv, withLock, withTimeout } from "./service.js";
import { humanMembers, isHumanMember } from "./store.js";

export const ASK_USER_TEMPLATES = [
  "general",
  "devops",
  "qa",
  "ops",
  "dev",
  "tech",
  "sales",
  "scribe",
] as const;
const MAX_OPEN_PER_THREAD = 2;
const TOO_MANY = "You already asked two questions here; wait for the answers.";
const TAUGHT_HELD =
  "I can't ask questions in this turn: it used taught knowledge that needs approval before it is shared here. Put everything in your answer.";

type QuestionRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  chat_id: string;
  reply_to: string | null;
  requester_user_id: string;
  requester_name: string;
  question: string;
  options: unknown;
  status: Question["status"];
  answer: string | null;
  created_ms: number;
  expires_ms: number;
};

const select = (src: string) =>
  `select q.id, q.agent_id, ag.name as agent_name, q.chat_id, q.reply_to, q.requester_user_id,
     u.display_name as requester_name, q.question, q.options, q.status, q.answer,
     (extract(epoch from q.created_at) * 1000)::float8 as created_ms,
     (extract(epoch from q.expires_at) * 1000)::float8 as expires_ms
   from ${src} q
   join sa.agents ag on ag.id = q.agent_id
   join sa.users u on u.id = q.requester_user_id`;

function toQuestion(r: QuestionRow): Question {
  const options = typeof r.options === "string" ? JSON.parse(r.options) : r.options;
  return {
    id: r.id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    chat_id: r.chat_id,
    reply_to: r.reply_to,
    requester_user_id: r.requester_user_id,
    requester_name: r.requester_name,
    question: r.question,
    options: Array.isArray(options) ? (options as string[]) : [],
    status: r.status,
    answer: r.answer,
    created_at: Math.round(Number(r.created_ms)),
    expires_at: Math.round(Number(r.expires_ms)),
  };
}

async function getQuestion(db: Db, id: string): Promise<Question | null> {
  const [row] = await db.query<QuestionRow>(`${select("sa.questions")} where q.id = $1`, [id]);
  return row ? toQuestion(row) : null;
}

/** Question cards are public in their thread: every active human of the chat gets the update. */
async function announce(db: Db, q: Question): Promise<void> {
  publish(await humanMembers(db, q.chat_id), { type: "question", question: q });
}

function parseAsk(args: Record<string, unknown>): { question: string; options: string[] } | string {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (question.length < 1 || question.length > 500) {
    return "question must be 1 to 500 characters.";
  }
  const raw = args.options ?? [];
  if (!Array.isArray(raw) || raw.length > 4) return "options must be a list of at most 4.";
  const options: string[] = [];
  for (const o of raw) {
    const t = typeof o === "string" ? o.trim() : "";
    if (t.length < 1 || t.length > 80) return "each option must be 1 to 80 characters.";
    options.push(t);
  }
  return { question, options };
}

/** The free `ask_user` tool, for every template. */
export function registerAskUser(): void {
  registerTools(ASK_USER_TEMPLATES, [
    {
      name: "ask_user",
      description:
        "Ask the person who asked you a short question in this thread (optionally with up to 4 options). End your turn after asking; their answer arrives as the next message.",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 500 },
        options: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 4 },
      },
      required: ["question"],
      async run(ctx, args) {
        const turn = ctx.turn;
        if (!turn?.requesterUserId) return "No one to ask.";
        const parsed = parseAsk(args);
        if (typeof parsed === "string") return parsed;
        if (await taughtHeld(ctx.db, turn)) return TAUGHT_HELD;
        const d = approvalDeps();
        const requester = turn.requesterUserId;
        const id = randomBytes(10).toString("hex");
        const placed = await withLock(`questions:${turn.agentId}:${turn.chatId}`, async () => {
          const [open] = await ctx.db.query<{ n: number }>(
            `select count(*)::int as n from sa.questions
             where agent_id = $1 and chat_id = $2 and reply_to is not distinct from $3
               and status = 'open' and expires_at > now()`,
            [turn.agentId, turn.chatId, turn.replyTo],
          );
          if ((open?.n ?? 0) >= MAX_OPEN_PER_THREAD) return false;
          await ctx.db.query(
            `insert into sa.questions (id, agent_id, chat_id, reply_to, turn_id, requester_user_id,
             question, options, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now() + ($9::float8 * interval '1 millisecond'))`,
            [
              id,
              turn.agentId,
              turn.chatId,
              turn.replyTo,
              turn.turnId,
              requester,
              parsed.question,
              JSON.stringify(parsed.options),
              ttlFromEnv(),
            ],
          );
          return true;
        });
        if (!placed) return TOO_MANY;
        const post = d.agentHost.postAs?.(turn.agentId, turn.chatId, parsed.question, {
          replyTo: turn.replyTo,
          meta: { question: { id, options: parsed.options } },
        });
        const messageId = post ? await withTimeout(post).catch(() => null) : null;
        if (!messageId) {
          await ctx.db.query("update sa.questions set status = 'canceled' where id = $1", [id]);
          d.log("question post failed", { id, agent: turn.agentId });
          return "I could not post the question in this chat.";
        }
        await ctx.db.query("update sa.questions set message_id = $2 where id = $1", [
          id,
          messageId,
        ]);
        const q = await getQuestion(ctx.db, id);
        if (q) await announce(ctx.db, q);
        d.log("question asked", { id, agent: turn.agentId, options: parsed.options.length });
        return JSON.stringify({
          status: "asked",
          question_id: id,
          message: `I asked ${q?.requester_name ?? "them"}. End your turn; their answer arrives as the next message.`,
        });
      },
    },
  ]);
  setQuestionSweep(expireQuestions);
}

async function expireQuestions(): Promise<void> {
  const { db, log } = approvalDeps();
  const rows = await db.query<QuestionRow>(
    `with x as (update sa.questions set status = 'expired'
       where status = 'open' and expires_at <= now() returning *) ${select("x")}`,
    [],
  );
  for (const r of rows) {
    const q = toQuestion(r);
    log("question expired", { id: q.id });
    await announce(db, q);
  }
}

export function registerQuestionRoutes(
  app: FastifyInstance,
  deps: { db: Db; authenticate: Authenticate },
): void {
  const { db, authenticate } = deps;

  app.get("/api/questions/:id", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const q = await getQuestion(db, (req.params as { id: string }).id);
    if (!q || !(await isHumanMember(db, q.chat_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    return q;
  });

  app.post("/api/questions/:id/answer", async (req, reply) => {
    const userId = await authenticate(req, reply);
    if (!userId) return;
    const q = await getQuestion(db, (req.params as { id: string }).id);
    if (!q || q.requester_user_id !== userId || !(await isHumanMember(db, q.chat_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const body = AnswerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (q.status !== "open" || q.expires_at <= Date.now()) {
      return reply.code(409).send({ error: "closed" });
    }
    const answer =
      body.data.option !== undefined ? q.options[body.data.option] : (body.data.text ?? "");
    if (!answer) return reply.code(400).send({ error: "bad_request" });
    // First answer wins: the update only applies while the question is still open.
    const [row] = await db.query<QuestionRow>(
      `with x as (update sa.questions set status = 'answered', answer = $2, answered_at = now()
         where id = $1 and status = 'open' and expires_at > now() returning *) ${select("x")}`,
      [q.id, answer],
    );
    if (!row) return reply.code(409).send({ error: "closed" });
    const done = toQuestion(row);
    const { agentHost, log } = approvalDeps();
    log("question answered", { id: done.id, agent: done.agent_id });
    await announce(db, done);
    // The answer turn runs in the background; the card updates through the event above.
    agentHost
      .runProactive?.({
        agentId: done.agent_id,
        chatId: done.chat_id,
        prompt: `${done.requester_name} answered your question "${done.question}": ${answer}`,
        kind: "answer",
        requesterUserId: done.requester_user_id,
        replyTo: done.reply_to,
      })
      .catch((e) => log("answer turn failed", { id: done.id, error: (e as Error).message }));
    return done;
  });
}
